import "server-only";

import Stripe from "stripe";

import { CURRENCY_VALUES } from "@/config/site";
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
  NormalizedDisputeWebhookEvent,
  NormalizedPaymentWebhookEvent,
  NormalizedRefundWebhookEvent,
  NormalizedWebhookEvent,
  PaymentProvider,
  ProviderCapabilityReport,
  ProviderDispute,
  ProviderPaymentIntent,
  ProviderRefund,
} from "@/server/payments/payment-provider";

/**
 * Stripe payment-provider adapter.
 *
 * Boundaries this file exists to hold:
 *
 *  - No Stripe object escapes. Every return value is a bounded internal type,
 *    so a Stripe field can never reach a domain service just because it arrived
 *    in a familiar shape.
 *  - No raw payload, signature, or key is ever logged, returned, or stored.
 *    Errors are reduced to safe codes.
 *  - Nothing here is financial authority. `createRefund` returning a status is
 *    a request receipt; only a verified webhook settles a refund locally.
 *  - The adapter is constructed only when PAYMENT_PROVIDER=STRIPE, and refuses
 *    to construct in live mode against a test key or the reverse.
 */

export interface StripeProviderConfiguration {
  secretKey: string;
  webhookSecrets: WebhookSecretWindow;
  mode: "test" | "live";
  allowedCurrencies: readonly Currency[];
  requestTimeoutMs: number;
}

/** Stripe reports amounts in minor units already, which is what we store. */
function toMinorUnits(value: number | null | undefined) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function toCurrency(value: string | null | undefined): Currency {
  const upper = (value ?? "").toUpperCase();
  if ((CURRENCY_VALUES as readonly string[]).includes(upper)) return upper as Currency;
  throw new PaymentWebhookValidationError();
}

function toDate(seconds: number | null | undefined) {
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? new Date(seconds * 1_000)
    : null;
}

const DISPUTE_REASON_BY_STRIPE_REASON: Record<string, DisputeReasonCategory> = {
  fraudulent: "FRAUDULENT",
  product_not_received: "PRODUCT_NOT_RECEIVED",
  duplicate: "DUPLICATE",
  credit_not_processed: "CREDIT_NOT_PROCESSED",
  subscription_canceled: "SUBSCRIPTION_CANCELED",
  general: "GENERAL",
};

function toDisputeReason(reason: string | null | undefined): DisputeReasonCategory {
  return DISPUTE_REASON_BY_STRIPE_REASON[(reason ?? "").toLowerCase()] ?? "UNRECOGNIZED";
}

/**
 * Reduce any Stripe failure to a bounded, non-sensitive code. Stripe error
 * messages can quote request parameters, so the message is deliberately dropped
 * rather than forwarded.
 */
export function safeStripeErrorCode(error: unknown): string {
  if (error instanceof Stripe.errors.StripeError) {
    const type = String(error.type ?? "stripe_error");
    return type.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase().slice(0, 80);
  }
  return "STRIPE_REQUEST_FAILED";
}

/** True for a Stripe failure that a later identical retry may still succeed. */
export function isRetryableStripeError(error: unknown) {
  if (!(error instanceof Stripe.errors.StripeError)) return true;
  return [
    "StripeConnectionError",
    "StripeAPIError",
    "StripeRateLimitError",
  ].includes(error.type ?? "");
}

function extractIntentId(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string") return id;
  }
  return "";
}

export class StripePaymentProvider implements PaymentProvider {
  readonly name = "STRIPE" as const;
  readonly simulated = false;

  private readonly client: Stripe;

  constructor(
    private readonly configuration: StripeProviderConfiguration,
    client?: Stripe,
  ) {
    this.client =
      client ??
      new Stripe(configuration.secretKey, {
        // Pinned so a Stripe-side default change cannot silently alter the
        // shape of what this adapter normalizes.
        apiVersion: "2026-06-24.dahlia",
        timeout: configuration.requestTimeoutMs,
        maxNetworkRetries: 0,
        telemetry: false,
        appInfo: { name: "seatflow" },
      });
  }

  capabilityReport(): ProviderCapabilityReport {
    return {
      provider: this.name,
      simulated: false,
      mode: this.configuration.mode,
      supportsPartialRefund: true,
      supportsRefundReconciliation: true,
      supportsDisputeEvents: true,
      supportsWebhookSecretRotation: true,
      supportedCurrencies: this.configuration.allowedCurrencies,
      // Names a mode and a capability set, never a key, account, or endpoint.
      safeConfigurationSummary: `stripe adapter in ${this.configuration.mode} mode`,
    };
  }

  private assertCurrencyAllowed(currency: Currency) {
    if (!this.configuration.allowedCurrencies.includes(currency)) {
      throw new Error("CURRENCY_NOT_ENABLED_FOR_PROVIDER");
    }
  }

  async createPaymentIntent(input: CreatePaymentIntentInput): Promise<ProviderPaymentIntent> {
    this.assertCurrencyAllowed(input.currency);
    const intent = await this.client.paymentIntents.create(
      {
        amount: input.amountMinor,
        currency: input.currency.toLowerCase(),
        // Only a non-identifying reference is attached. No customer email,
        // name, seat, or internal user id is ever sent to the provider.
        metadata: { orderReference: input.orderReference },
        automatic_payment_methods: { enabled: true },
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return this.toProviderIntent(intent);
  }

  async retrievePaymentIntent(input: {
    providerIntentId: string;
  }): Promise<ProviderPaymentIntent> {
    return this.toProviderIntent(
      await this.client.paymentIntents.retrieve(input.providerIntentId),
    );
  }

  async cancelPaymentIntent(input: {
    providerIntentId: string;
  }): Promise<ProviderPaymentIntent> {
    return this.toProviderIntent(
      await this.client.paymentIntents.cancel(input.providerIntentId),
    );
  }

  private toProviderIntent(intent: Stripe.PaymentIntent): ProviderPaymentIntent {
    return {
      providerIntentId: intent.id,
      status: normalizeProviderPaymentStatus(intent.status),
      providerStatus: String(intent.status).slice(0, 80),
      // A provider-hosted URL is never trusted as a redirect target here; the
      // checkout flow uses its own routes.
      checkoutUrl: null,
    };
  }

  /**
   * Create a refund under a stable idempotency key.
   *
   * Retrying with the same key returns Stripe's existing refund rather than
   * creating a second one, which is what makes provider-timeout recovery safe:
   * the key is committed locally before the call is ever made.
   */
  async createRefund(input: CreateRefundInput): Promise<ProviderRefund> {
    this.assertCurrencyAllowed(input.currency);
    const refund = await this.client.refunds.create(
      {
        payment_intent: input.providerIntentId,
        amount: input.amountMinor,
        metadata: { reasonCode: input.safeReasonCode.slice(0, 40) },
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return this.toProviderRefund(refund, input.currency);
  }

  async retrieveRefund(input: { providerRefundId: string }): Promise<ProviderRefund> {
    const refund = await this.client.refunds.retrieve(input.providerRefundId);
    return this.toProviderRefund(refund, toCurrency(refund.currency), true);
  }

  async listRefundsForPayment(input: { providerIntentId: string }): Promise<ProviderRefund[]> {
    const refunds = await this.client.refunds.list({
      payment_intent: input.providerIntentId,
      limit: 100,
    });
    return refunds.data.map((refund) =>
      this.toProviderRefund(refund, toCurrency(refund.currency), true),
    );
  }

  private toProviderRefund(
    refund: Stripe.Refund,
    currency: Currency,
    duplicate = false,
  ): ProviderRefund {
    return {
      providerRefundId: refund.id,
      status: normalizeProviderRefundStatus(String(refund.status ?? "pending")),
      providerStatus: String(refund.status ?? "pending").slice(0, 80),
      amountMinor: toMinorUnits(refund.amount),
      currency,
      duplicate,
    };
  }

  async retrieveDispute(input: { providerDisputeId: string }): Promise<ProviderDispute> {
    return this.toProviderDispute(await this.client.disputes.retrieve(input.providerDisputeId));
  }

  async listDisputes(input: { providerIntentId: string }): Promise<ProviderDispute[]> {
    const disputes = await this.client.disputes.list({
      payment_intent: input.providerIntentId,
      limit: 100,
    });
    return disputes.data.map((dispute) => this.toProviderDispute(dispute));
  }

  private toProviderDispute(dispute: Stripe.Dispute): ProviderDispute {
    return {
      providerDisputeId: dispute.id,
      providerIntentId: extractIntentId(dispute.payment_intent),
      status: normalizeProviderDisputeStatus(String(dispute.status)),
      providerStatus: String(dispute.status).slice(0, 80),
      reasonCategory: toDisputeReason(dispute.reason),
      amountMinor: toMinorUnits(dispute.amount),
      currency: toCurrency(dispute.currency),
      openedAt: toDate(dispute.created),
      evidenceDueAt: toDate(dispute.evidence_details?.due_by),
    };
  }

  /**
   * Verify with Stripe's own construct, once per secret still inside the
   * rotation window. Signature checking is never reimplemented here.
   */
  verifyWebhook(
    input: { rawBody: Uint8Array; signature: string },
    now = new Date(),
  ): boolean {
    assertPaymentWebhookPayloadSize(input.rawBody, DEFAULT_PAYMENT_WEBHOOK_MAX_BYTES);
    if (input.signature.length > 1_024) return false;
    const payload = Buffer.from(input.rawBody);

    for (const secret of activeSecretsForVerification(this.configuration.webhookSecrets, now)) {
      try {
        this.client.webhooks.constructEvent(payload, input.signature, secret);
        return true;
      } catch {
        // Try the next secret in the window. The reason is deliberately not
        // captured: it would distinguish "wrong secret" from "malformed", and
        // neither is safe to report to a caller.
      }
    }
    return false;
  }

  /**
   * Normalize a verified Stripe event.
   *
   * Callers must have verified the signature first. Anything this build does
   * not model becomes UNSUPPORTED rather than being guessed at, so an unknown
   * Stripe event can never be interpreted as a financial outcome.
   */
  normalizeWebhookEvent(rawBody: Uint8Array): NormalizedWebhookEvent {
    assertPaymentWebhookPayloadSize(rawBody, DEFAULT_PAYMENT_WEBHOOK_MAX_BYTES);
    let event: Stripe.Event;
    try {
      event = JSON.parse(Buffer.from(rawBody).toString("utf8")) as Stripe.Event;
    } catch {
      throw new PaymentWebhookValidationError();
    }
    if (!event?.id || !event?.type || !event?.data?.object) {
      throw new PaymentWebhookValidationError();
    }

    const occurredAt = toDate(event.created);
    // Stripe types this as a union of every resource it can deliver. It is
    // narrowed per event type below and every field is re-validated, so it is
    // treated as unstructured here rather than trusted as any one shape.
    const object = event.data.object as unknown as Record<string, unknown>;

    if (event.type.startsWith("payment_intent.")) {
      return {
        category: "PAYMENT",
        event: this.normalizePaymentEvent(event, object, occurredAt),
      };
    }
    if (event.type.startsWith("charge.dispute.")) {
      return {
        category: "DISPUTE",
        event: this.normalizeDisputeEvent(event, object, occurredAt),
      };
    }
    if (event.type === "refund.updated" || event.type === "charge.refund.updated") {
      return {
        category: "REFUND",
        event: this.normalizeRefundEvent(event, object, occurredAt),
      };
    }

    return {
      category: "UNSUPPORTED",
      providerEventId: String(event.id).slice(0, 191),
      eventType: String(event.type).slice(0, 120),
    };
  }

  private normalizePaymentEvent(
    event: Stripe.Event,
    object: Record<string, unknown>,
    occurredAt: Date | null,
  ): NormalizedPaymentWebhookEvent {
    const intent = object as unknown as Stripe.PaymentIntent;
    if (!intent.id || !intent.status) throw new PaymentWebhookValidationError();
    return {
      providerEventId: event.id,
      eventType: event.type,
      providerIntentId: intent.id,
      status: normalizeProviderPaymentStatus(intent.status),
      amountMinor: toMinorUnits(intent.amount),
      currency: toCurrency(intent.currency),
      occurredAt,
    };
  }

  private normalizeRefundEvent(
    event: Stripe.Event,
    object: Record<string, unknown>,
    occurredAt: Date | null,
  ): NormalizedRefundWebhookEvent {
    const refund = object as unknown as Stripe.Refund;
    const providerIntentId = extractIntentId(refund.payment_intent);
    if (!refund.id || !providerIntentId) throw new PaymentWebhookValidationError();
    return {
      providerEventId: event.id,
      eventType: event.type,
      providerIntentId,
      providerRefundId: refund.id,
      status: normalizeProviderRefundStatus(String(refund.status ?? "pending")),
      amountMinor: toMinorUnits(refund.amount),
      currency: toCurrency(refund.currency),
      occurredAt,
    };
  }

  private normalizeDisputeEvent(
    event: Stripe.Event,
    object: Record<string, unknown>,
    occurredAt: Date | null,
  ): NormalizedDisputeWebhookEvent {
    const dispute = object as unknown as Stripe.Dispute;
    const providerIntentId = extractIntentId(dispute.payment_intent);
    if (!dispute.id || !providerIntentId) throw new PaymentWebhookValidationError();
    return {
      providerEventId: event.id,
      eventType: event.type,
      providerIntentId,
      providerDisputeId: dispute.id,
      status: normalizeProviderDisputeStatus(String(dispute.status)),
      reasonCategory: toDisputeReason(dispute.reason),
      amountMinor: toMinorUnits(dispute.amount),
      currency: toCurrency(dispute.currency),
      occurredAt,
      evidenceDueAt: toDate(dispute.evidence_details?.due_by),
    };
  }

  parseWebhookEvent(rawBody: Uint8Array): NormalizedPaymentWebhookEvent {
    const normalized = this.normalizeWebhookEvent(rawBody);
    if (normalized.category !== "PAYMENT") throw new PaymentWebhookValidationError();
    return normalized.event;
  }
}
