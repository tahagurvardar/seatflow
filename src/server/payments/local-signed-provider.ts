import {
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { z } from "zod";

import { CURRENCY_VALUES } from "@/config/site";
import { normalizeProviderPaymentStatus } from "@/features/payments/status";
import {
  assertPaymentWebhookPayloadSize,
  DEFAULT_PAYMENT_WEBHOOK_MAX_BYTES,
} from "@/features/payments/webhook";
import type { Currency } from "@/generated/prisma/enums";
import { PaymentWebhookValidationError } from "@/server/payments/errors";
import type {
  CreatePaymentIntentInput,
  NormalizedPaymentWebhookEvent,
  PaymentProvider,
  ProviderPaymentIntent,
} from "@/server/payments/payment-provider";

const localWebhookEventSchema = z
  .object({
    id: z.string().min(8).max(191).regex(/^[A-Za-z0-9_-]+$/),
    type: z.enum(["payment.succeeded", "payment.failed"]),
    createdAt: z.iso.datetime({ offset: true }),
    data: z
      .object({
        providerIntentId: z.string().min(8).max(191),
        status: z.enum(["succeeded", "failed"]),
        amountMinor: z.number().int().min(0).max(2_147_483_647),
        currency: z.enum(CURRENCY_VALUES),
      })
      .strict(),
  })
  .strict();

function deterministicIntentId(secret: string, idempotencyKey: string) {
  const digest = createHmac("sha256", secret)
    .update(`seatflow-local-intent:${idempotencyKey}`)
    .digest("base64url")
    .slice(0, 32);
  return `local_pi_${digest}`;
}

function sign(secret: string, timestamp: number, rawBody: Uint8Array) {
  return createHmac("sha256", secret)
    .update(String(timestamp))
    .update(".")
    .update(rawBody)
    .digest("hex");
}

export interface LocalSignedWebhookDelivery {
  rawBody: Uint8Array;
  signature: string;
  eventId: string;
}

/**
 * Development/test-only deterministic provider. It never receives payment-card
 * data. Webhooks use an HMAC over the exact raw body and a constant-time compare.
 */
export class LocalSignedPaymentProvider implements PaymentProvider {
  readonly name = "LOCAL_SIGNED" as const;
  readonly simulated = true;

  constructor(
    private readonly secret: string,
    runtimeEnvironment = process.env.NODE_ENV,
  ) {
    if (runtimeEnvironment === "production") {
      throw new Error("The local signed payment provider is disabled in production.");
    }
    if (secret.length < 32) {
      throw new Error("The local signed payment provider secret is too short.");
    }
  }

  async createPaymentIntent(
    input: CreatePaymentIntentInput,
  ): Promise<ProviderPaymentIntent> {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0) {
      throw new Error("Local payment amount is invalid.");
    }
    return {
      providerIntentId: deterministicIntentId(this.secret, input.idempotencyKey),
      status: "PENDING",
      providerStatus: "pending",
      checkoutUrl: null,
    };
  }

  async retrievePaymentIntent(input: {
    providerIntentId: string;
  }): Promise<ProviderPaymentIntent> {
    if (!input.providerIntentId.startsWith("local_pi_")) {
      throw new Error("Unknown local payment intent.");
    }
    return {
      providerIntentId: input.providerIntentId,
      status: "PENDING",
      providerStatus: "pending",
      checkoutUrl: null,
    };
  }

  async cancelPaymentIntent(input: {
    providerIntentId: string;
  }): Promise<ProviderPaymentIntent> {
    if (!input.providerIntentId.startsWith("local_pi_")) {
      throw new Error("Unknown local payment intent.");
    }
    return {
      providerIntentId: input.providerIntentId,
      status: "CANCELLED",
      providerStatus: "cancelled",
      checkoutUrl: null,
    };
  }

  verifyWebhook(input: { rawBody: Uint8Array; signature: string }): boolean {
    assertPaymentWebhookPayloadSize(
      input.rawBody,
      DEFAULT_PAYMENT_WEBHOOK_MAX_BYTES,
    );
    if (input.signature.length > 256) return false;
    const match = /^t=(\d{10,13}),v1=([a-f0-9]{64})$/.exec(input.signature);
    if (!match) return false;
    const timestamp = Number(match[1]);
    if (!Number.isSafeInteger(timestamp)) return false;
    const expected = Buffer.from(sign(this.secret, timestamp, input.rawBody), "hex");
    const provided = Buffer.from(match[2], "hex");
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  }

  parseWebhookEvent(rawBody: Uint8Array): NormalizedPaymentWebhookEvent {
    assertPaymentWebhookPayloadSize(rawBody, DEFAULT_PAYMENT_WEBHOOK_MAX_BYTES);
    try {
      const parsed = localWebhookEventSchema.parse(
        JSON.parse(Buffer.from(rawBody).toString("utf8")),
      );
      return {
        providerEventId: parsed.id,
        eventType: parsed.type,
        providerIntentId: parsed.data.providerIntentId,
        status: normalizeProviderPaymentStatus(parsed.data.status),
        amountMinor: parsed.data.amountMinor,
        currency: parsed.data.currency as Currency,
        occurredAt: new Date(parsed.createdAt),
      };
    } catch {
      throw new PaymentWebhookValidationError();
    }
  }

  createSignedWebhook(input: {
    providerIntentId: string;
    outcome: "success" | "failure";
    amountMinor: number;
    currency: Currency;
    eventId?: string;
    occurredAt?: Date;
    signatureTimestamp?: number;
  }): LocalSignedWebhookDelivery {
    const eventId = input.eventId ?? `local_evt_${randomUUID().replaceAll("-", "")}`;
    const payload = {
      id: eventId,
      type: input.outcome === "success" ? "payment.succeeded" : "payment.failed",
      createdAt: (input.occurredAt ?? new Date()).toISOString(),
      data: {
        providerIntentId: input.providerIntentId,
        status: input.outcome === "success" ? "succeeded" : "failed",
        amountMinor: input.amountMinor,
        currency: input.currency,
      },
    };
    localWebhookEventSchema.parse(payload);
    const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
    const timestamp = input.signatureTimestamp ?? Math.floor(Date.now() / 1_000);
    return {
      rawBody,
      signature: `t=${timestamp},v1=${sign(this.secret, timestamp, rawBody)}`,
      eventId,
    };
  }
}

