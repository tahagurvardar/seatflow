import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { CURRENCY_VALUES } from "@/config/site";
import { isIsolatedE2EMode } from "@/features/operations/e2e-test-mode";
import {
  normalizeProviderDisputeStatus,
  normalizeProviderPaymentStatus,
  normalizeProviderRefundStatus,
} from "@/features/payments/status";
import {
  activeSecretsForVerification,
  type WebhookSecretWindow,
} from "@/features/payments/secret-rotation";
import {
  assertPaymentWebhookPayloadSize,
  DEFAULT_PAYMENT_WEBHOOK_MAX_BYTES,
} from "@/features/payments/webhook";
import type { Currency, DisputeReasonCategory } from "@/generated/prisma/enums";
import { PaymentWebhookValidationError } from "@/server/payments/errors";
import type {
  CreatePaymentIntentInput,
  CreateRefundInput,
  NormalizedPaymentWebhookEvent,
  NormalizedWebhookEvent,
  PaymentProvider,
  ProviderCapabilityReport,
  ProviderDispute,
  ProviderPaymentIntent,
  ProviderRefund,
} from "@/server/payments/payment-provider";

const DISPUTE_REASON_VALUES = [
  "FRAUDULENT",
  "PRODUCT_NOT_RECEIVED",
  "DUPLICATE",
  "CREDIT_NOT_PROCESSED",
  "SUBSCRIPTION_CANCELED",
  "GENERAL",
  "UNRECOGNIZED",
] as const;

const paymentEventSchema = z
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

const refundEventSchema = z
  .object({
    id: z.string().min(8).max(191).regex(/^[A-Za-z0-9_-]+$/),
    type: z.enum(["refund.succeeded", "refund.failed", "refund.processing"]),
    createdAt: z.iso.datetime({ offset: true }),
    data: z
      .object({
        providerIntentId: z.string().min(8).max(191),
        providerRefundId: z.string().min(8).max(191),
        status: z.enum(["succeeded", "failed", "processing", "pending", "requires_review"]),
        amountMinor: z.number().int().min(1).max(2_147_483_647),
        currency: z.enum(CURRENCY_VALUES),
      })
      .strict(),
  })
  .strict();

const disputeEventSchema = z
  .object({
    id: z.string().min(8).max(191).regex(/^[A-Za-z0-9_-]+$/),
    type: z.enum([
      "dispute.opened",
      "dispute.updated",
      "dispute.won",
      "dispute.lost",
      "dispute.closed",
    ]),
    createdAt: z.iso.datetime({ offset: true }),
    data: z
      .object({
        providerIntentId: z.string().min(8).max(191),
        providerDisputeId: z.string().min(8).max(191),
        status: z.enum([
          "open",
          "needs_response",
          "under_review",
          "won",
          "lost",
          "closed",
        ]),
        reason: z.enum(DISPUTE_REASON_VALUES).optional(),
        amountMinor: z.number().int().min(1).max(2_147_483_647),
        currency: z.enum(CURRENCY_VALUES),
        evidenceDueAt: z.iso.datetime({ offset: true }).optional(),
      })
      .strict(),
  })
  .strict();

const envelopeSchema = z.object({ type: z.string().min(1).max(120) });

function deterministicIntentId(secret: string, idempotencyKey: string) {
  const digest = createHmac("sha256", secret)
    .update(`seatflow-local-intent:${idempotencyKey}`)
    .digest("base64url")
    .slice(0, 32);
  return `local_pi_${digest}`;
}

/**
 * The provider-side identity of a refund is derived from the idempotency key,
 * which is exactly how a real provider behaves: retrying with the same key
 * returns the same refund rather than creating a second one.
 */
function deterministicRefundId(secret: string, idempotencyKey: string) {
  const digest = createHmac("sha256", secret)
    .update(`seatflow-local-refund:${idempotencyKey}`)
    .digest("base64url")
    .slice(0, 32);
  return `local_re_${digest}`;
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

interface LocalRefundRecord {
  providerRefundId: string;
  providerIntentId: string;
  amountMinor: number;
  currency: Currency;
}

interface LocalDisputeRecord {
  providerDisputeId: string;
  providerIntentId: string;
  status: ProviderDispute["status"];
  reasonCategory: DisputeReasonCategory;
  amountMinor: number;
  currency: Currency;
  openedAt: Date;
  evidenceDueAt: Date | null;
}

/**
 * Development/test-only deterministic provider.
 *
 * It never receives payment-card data and never reaches a payment network.
 * Webhooks are HMACs over the exact raw body compared in constant time, and
 * the same rotation window the external adapter uses is honoured here so the
 * rotation behaviour under test is the real one.
 */
export class LocalSignedPaymentProvider implements PaymentProvider {
  readonly name = "LOCAL_SIGNED" as const;
  readonly simulated = true;

  private readonly secretWindow: WebhookSecretWindow;
  private readonly refunds = new Map<string, LocalRefundRecord>();
  private readonly disputes = new Map<string, LocalDisputeRecord>();
  /** Test hook: forces the next createRefund call to fail or hang. */
  private nextRefundFault: "TIMEOUT" | "PROVIDER_ERROR" | null = null;

  constructor(
    secretOrWindow: string | WebhookSecretWindow,
    runtimeEnvironment = process.env.NODE_ENV,
  ) {
    // Forbidden in production, with one audited exception: a demonstrably
    // isolated E2E harness, which must run against a production build to make
    // console-error and framework-overlay assertions meaningful. Every
    // condition in `evaluateIsolatedE2EMode` has to hold; a real production
    // deployment fails them, so this stays disabled there.
    if (runtimeEnvironment === "production" && !isIsolatedE2EMode(process.env)) {
      throw new Error("The local signed payment provider is disabled in production.");
    }
    this.secretWindow =
      typeof secretOrWindow === "string" ? { current: secretOrWindow } : secretOrWindow;
    if (this.secretWindow.current.length < 32) {
      throw new Error("The local signed payment provider secret is too short.");
    }
  }

  private get secret() {
    return this.secretWindow.current;
  }

  capabilityReport(): ProviderCapabilityReport {
    return {
      provider: this.name,
      simulated: true,
      mode: "simulated",
      supportsPartialRefund: true,
      supportsRefundReconciliation: true,
      supportsDisputeEvents: true,
      supportsWebhookSecretRotation: true,
      supportedCurrencies: CURRENCY_VALUES as unknown as readonly Currency[],
      safeConfigurationSummary: "local signed simulator; no external network calls",
    };
  }

  async createPaymentIntent(input: CreatePaymentIntentInput): Promise<ProviderPaymentIntent> {
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

  /**
   * Creating a refund is idempotent on the key. The returned status is never
   * financial authority: it only becomes SUCCEEDED locally once a verified
   * refund webhook says so.
   */
  async createRefund(input: CreateRefundInput): Promise<ProviderRefund> {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw new Error("Local refund amount is invalid.");
    }
    const fault = this.nextRefundFault;
    this.nextRefundFault = null;
    if (fault === "TIMEOUT") {
      // The provider accepted the idempotency key before the caller gave up,
      // so the refund is recorded here exactly as a real provider would.
      this.rememberRefund(input);
      throw new Error("LOCAL_PROVIDER_TIMEOUT");
    }
    if (fault === "PROVIDER_ERROR") {
      throw new Error("LOCAL_PROVIDER_ERROR");
    }

    const existing = this.refunds.get(input.idempotencyKey);
    const record = existing ?? this.rememberRefund(input);
    return {
      providerRefundId: record.providerRefundId,
      status: "PROCESSING",
      providerStatus: "processing",
      amountMinor: record.amountMinor,
      currency: record.currency,
      duplicate: Boolean(existing),
    };
  }

  private rememberRefund(input: CreateRefundInput): LocalRefundRecord {
    const record: LocalRefundRecord = {
      providerRefundId: deterministicRefundId(this.secret, input.idempotencyKey),
      providerIntentId: input.providerIntentId,
      amountMinor: input.amountMinor,
      currency: input.currency,
    };
    this.refunds.set(input.idempotencyKey, record);
    return record;
  }

  async retrieveRefund(input: { providerRefundId: string }): Promise<ProviderRefund> {
    const record = [...this.refunds.values()].find(
      (candidate) => candidate.providerRefundId === input.providerRefundId,
    );
    if (!record) throw new Error("Unknown local refund.");
    return {
      providerRefundId: record.providerRefundId,
      status: "PROCESSING",
      providerStatus: "processing",
      amountMinor: record.amountMinor,
      currency: record.currency,
      duplicate: true,
    };
  }

  async listRefundsForPayment(input: { providerIntentId: string }): Promise<ProviderRefund[]> {
    return [...this.refunds.values()]
      .filter((record) => record.providerIntentId === input.providerIntentId)
      .map((record) => ({
        providerRefundId: record.providerRefundId,
        status: "PROCESSING" as const,
        providerStatus: "processing",
        amountMinor: record.amountMinor,
        currency: record.currency,
        duplicate: true,
      }));
  }

  async retrieveDispute(input: { providerDisputeId: string }): Promise<ProviderDispute> {
    const record = this.disputes.get(input.providerDisputeId);
    if (!record) throw new Error("Unknown local dispute.");
    return { ...record, providerStatus: record.status.toLowerCase() };
  }

  async listDisputes(input: { providerIntentId: string }): Promise<ProviderDispute[]> {
    return [...this.disputes.values()]
      .filter((record) => record.providerIntentId === input.providerIntentId)
      .map((record) => ({ ...record, providerStatus: record.status.toLowerCase() }));
  }

  /**
   * Verify against every secret still inside the rotation window, in constant
   * time. An expired previous secret is not tried at all.
   */
  verifyWebhook(input: { rawBody: Uint8Array; signature: string }, now = new Date()): boolean {
    assertPaymentWebhookPayloadSize(input.rawBody, DEFAULT_PAYMENT_WEBHOOK_MAX_BYTES);
    if (input.signature.length > 256) return false;
    const match = /^t=(\d{10,13}),v1=([a-f0-9]{64})$/.exec(input.signature);
    if (!match) return false;
    const timestamp = Number(match[1]);
    if (!Number.isSafeInteger(timestamp)) return false;

    const provided = Buffer.from(match[2]!, "hex");
    let verified = false;
    for (const secret of activeSecretsForVerification(this.secretWindow, now)) {
      const expected = Buffer.from(sign(secret, timestamp, input.rawBody), "hex");
      // Every candidate is compared, so verification time does not reveal which
      // secret matched or whether an early one did.
      if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
        verified = true;
      }
    }
    return verified;
  }

  normalizeWebhookEvent(rawBody: Uint8Array): NormalizedWebhookEvent {
    assertPaymentWebhookPayloadSize(rawBody, DEFAULT_PAYMENT_WEBHOOK_MAX_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(rawBody).toString("utf8"));
    } catch {
      throw new PaymentWebhookValidationError();
    }

    const envelope = envelopeSchema.safeParse(parsed);
    if (!envelope.success) throw new PaymentWebhookValidationError();
    const type = envelope.data.type;

    if (type.startsWith("payment.")) {
      return { category: "PAYMENT", event: this.parsePaymentEvent(parsed) };
    }
    if (type.startsWith("refund.")) {
      const event = refundEventSchema.safeParse(parsed);
      if (!event.success) throw new PaymentWebhookValidationError();
      return {
        category: "REFUND",
        event: {
          providerEventId: event.data.id,
          eventType: event.data.type,
          providerIntentId: event.data.data.providerIntentId,
          providerRefundId: event.data.data.providerRefundId,
          status: normalizeProviderRefundStatus(event.data.data.status),
          amountMinor: event.data.data.amountMinor,
          currency: event.data.data.currency as Currency,
          occurredAt: new Date(event.data.createdAt),
        },
      };
    }
    if (type.startsWith("dispute.")) {
      const event = disputeEventSchema.safeParse(parsed);
      if (!event.success) throw new PaymentWebhookValidationError();
      return {
        category: "DISPUTE",
        event: {
          providerEventId: event.data.id,
          eventType: event.data.type,
          providerIntentId: event.data.data.providerIntentId,
          providerDisputeId: event.data.data.providerDisputeId,
          status: normalizeProviderDisputeStatus(event.data.data.status),
          reasonCategory: (event.data.data.reason ?? "UNRECOGNIZED") as DisputeReasonCategory,
          amountMinor: event.data.data.amountMinor,
          currency: event.data.data.currency as Currency,
          occurredAt: new Date(event.data.createdAt),
          evidenceDueAt: event.data.data.evidenceDueAt
            ? new Date(event.data.data.evidenceDueAt)
            : null,
        },
      };
    }

    // An unmodelled event is reported as unsupported rather than guessed at.
    const identified = z
      .object({ id: z.string().min(1).max(191) })
      .safeParse(parsed);
    return {
      category: "UNSUPPORTED",
      providerEventId: identified.success ? identified.data.id : "unknown",
      eventType: type.slice(0, 120),
    };
  }

  parseWebhookEvent(rawBody: Uint8Array): NormalizedPaymentWebhookEvent {
    assertPaymentWebhookPayloadSize(rawBody, DEFAULT_PAYMENT_WEBHOOK_MAX_BYTES);
    try {
      return this.parsePaymentEvent(JSON.parse(Buffer.from(rawBody).toString("utf8")));
    } catch {
      throw new PaymentWebhookValidationError();
    }
  }

  private parsePaymentEvent(parsed: unknown): NormalizedPaymentWebhookEvent {
    const event = paymentEventSchema.safeParse(parsed);
    if (!event.success) throw new PaymentWebhookValidationError();
    return {
      providerEventId: event.data.id,
      eventType: event.data.type,
      providerIntentId: event.data.data.providerIntentId,
      status: normalizeProviderPaymentStatus(event.data.data.status),
      amountMinor: event.data.data.amountMinor,
      currency: event.data.data.currency as Currency,
      occurredAt: new Date(event.data.createdAt),
    };
  }

  // ---- Test-only helpers ---------------------------------------------------

  /** Arrange the next createRefund call to fail the way a real provider can. */
  failNextRefund(fault: "TIMEOUT" | "PROVIDER_ERROR") {
    this.nextRefundFault = fault;
  }

  createSignedWebhook(input: {
    providerIntentId: string;
    outcome: "success" | "failure";
    amountMinor: number;
    currency: Currency;
    eventId?: string;
    occurredAt?: Date;
    signatureTimestamp?: number;
    signWithSecret?: string;
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
    paymentEventSchema.parse(payload);
    return this.seal(payload, eventId, input.signatureTimestamp, input.signWithSecret);
  }

  createSignedRefundWebhook(input: {
    providerIntentId: string;
    providerRefundId: string;
    outcome: "succeeded" | "failed" | "processing";
    amountMinor: number;
    currency: Currency;
    eventId?: string;
    occurredAt?: Date;
    signatureTimestamp?: number;
    signWithSecret?: string;
  }): LocalSignedWebhookDelivery {
    const eventId = input.eventId ?? `local_evt_${randomUUID().replaceAll("-", "")}`;
    const payload = {
      id: eventId,
      type: `refund.${input.outcome}`,
      createdAt: (input.occurredAt ?? new Date()).toISOString(),
      data: {
        providerIntentId: input.providerIntentId,
        providerRefundId: input.providerRefundId,
        status: input.outcome,
        amountMinor: input.amountMinor,
        currency: input.currency,
      },
    };
    refundEventSchema.parse(payload);
    return this.seal(payload, eventId, input.signatureTimestamp, input.signWithSecret);
  }

  createSignedDisputeWebhook(input: {
    providerIntentId: string;
    providerDisputeId: string;
    status: "open" | "needs_response" | "under_review" | "won" | "lost" | "closed";
    amountMinor: number;
    currency: Currency;
    reason?: DisputeReasonCategory;
    eventId?: string;
    occurredAt?: Date;
    evidenceDueAt?: Date;
    signatureTimestamp?: number;
    signWithSecret?: string;
  }): LocalSignedWebhookDelivery {
    const eventId = input.eventId ?? `local_evt_${randomUUID().replaceAll("-", "")}`;
    const eventType =
      input.status === "won" || input.status === "lost" || input.status === "closed"
        ? `dispute.${input.status}`
        : input.status === "open"
          ? "dispute.opened"
          : "dispute.updated";
    const payload = {
      id: eventId,
      type: eventType,
      createdAt: (input.occurredAt ?? new Date()).toISOString(),
      data: {
        providerIntentId: input.providerIntentId,
        providerDisputeId: input.providerDisputeId,
        status: input.status,
        ...(input.reason ? { reason: input.reason } : {}),
        amountMinor: input.amountMinor,
        currency: input.currency,
        ...(input.evidenceDueAt ? { evidenceDueAt: input.evidenceDueAt.toISOString() } : {}),
      },
    };
    disputeEventSchema.parse(payload);

    this.disputes.set(input.providerDisputeId, {
      providerDisputeId: input.providerDisputeId,
      providerIntentId: input.providerIntentId,
      status: normalizeProviderDisputeStatus(input.status),
      reasonCategory: input.reason ?? "UNRECOGNIZED",
      amountMinor: input.amountMinor,
      currency: input.currency,
      openedAt: input.occurredAt ?? new Date(),
      evidenceDueAt: input.evidenceDueAt ?? null,
    });

    return this.seal(payload, eventId, input.signatureTimestamp, input.signWithSecret);
  }

  private seal(
    payload: unknown,
    eventId: string,
    signatureTimestamp?: number,
    signWithSecret?: string,
  ): LocalSignedWebhookDelivery {
    const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
    const timestamp = signatureTimestamp ?? Math.floor(Date.now() / 1_000);
    return {
      rawBody,
      signature: `t=${timestamp},v1=${sign(signWithSecret ?? this.secret, timestamp, rawBody)}`,
      eventId,
    };
  }
}
