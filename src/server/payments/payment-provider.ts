import type {
  Currency,
  DisputeReasonCategory,
  DisputeStatus,
  PaymentAttemptStatus,
  PaymentProviderName,
  RefundStatus,
} from "@/generated/prisma/enums";

/**
 * The provider boundary.
 *
 * Everything crossing it is a bounded internal type. No Stripe object, Resend
 * object, or raw provider payload is allowed past this file, so a provider
 * change cannot reach into domain services, and a provider field can never be
 * trusted just because it arrived in a well-known shape.
 */

export interface CreatePaymentIntentInput {
  orderReference: string;
  amountMinor: number;
  currency: Currency;
  idempotencyKey: string;
  expiresAt: Date;
}

export interface ProviderPaymentIntent {
  providerIntentId: string;
  status: PaymentAttemptStatus;
  providerStatus: string;
  checkoutUrl: string | null;
}

export interface CreateRefundInput {
  providerIntentId: string;
  amountMinor: number;
  currency: Currency;
  /** Stable key; a retry with the same key must never create a second refund. */
  idempotencyKey: string;
  safeReasonCode: string;
}

export interface ProviderRefund {
  providerRefundId: string;
  status: RefundStatus;
  providerStatus: string;
  amountMinor: number;
  currency: Currency;
  /** True when the provider recognised the idempotency key and replayed. */
  duplicate: boolean;
}

export interface ProviderDispute {
  providerDisputeId: string;
  providerIntentId: string;
  status: DisputeStatus;
  providerStatus: string;
  reasonCategory: DisputeReasonCategory;
  amountMinor: number;
  currency: Currency;
  openedAt: Date | null;
  evidenceDueAt: Date | null;
}

export interface NormalizedPaymentWebhookEvent {
  providerEventId: string;
  eventType: string;
  providerIntentId: string;
  status: PaymentAttemptStatus;
  amountMinor: number;
  currency: Currency;
  occurredAt: Date | null;
}

export interface NormalizedRefundWebhookEvent {
  providerEventId: string;
  eventType: string;
  providerIntentId: string;
  providerRefundId: string;
  status: RefundStatus;
  amountMinor: number;
  currency: Currency;
  occurredAt: Date | null;
}

export interface NormalizedDisputeWebhookEvent {
  providerEventId: string;
  eventType: string;
  providerIntentId: string;
  providerDisputeId: string;
  status: DisputeStatus;
  reasonCategory: DisputeReasonCategory;
  amountMinor: number;
  currency: Currency;
  occurredAt: Date | null;
  evidenceDueAt: Date | null;
}

/**
 * One discriminated result for every verified webhook. A provider event that
 * this build does not model normalizes to UNSUPPORTED rather than being guessed
 * at, so an unknown event can never be interpreted as a financial outcome.
 */
export type NormalizedWebhookEvent =
  | { category: "PAYMENT"; event: NormalizedPaymentWebhookEvent }
  | { category: "REFUND"; event: NormalizedRefundWebhookEvent }
  | { category: "DISPUTE"; event: NormalizedDisputeWebhookEvent }
  | { category: "UNSUPPORTED"; providerEventId: string; eventType: string };

/**
 * What a provider adapter can actually do in this deployment. Reported rather
 * than assumed, so an operator can see before enabling traffic that (say)
 * partial refunds or dispute events are not available.
 */
export interface ProviderCapabilityReport {
  provider: PaymentProviderName;
  /** True for development adapters that never touch a real payment network. */
  simulated: boolean;
  mode: "test" | "live" | "simulated";
  supportsPartialRefund: boolean;
  supportsRefundReconciliation: boolean;
  supportsDisputeEvents: boolean;
  supportsWebhookSecretRotation: boolean;
  supportedCurrencies: readonly Currency[];
  /** Never a secret, key fragment, or account identifier. */
  safeConfigurationSummary: string;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  readonly simulated: boolean;

  capabilityReport(): ProviderCapabilityReport;

  createPaymentIntent(input: CreatePaymentIntentInput): Promise<ProviderPaymentIntent>;
  retrievePaymentIntent(input: { providerIntentId: string }): Promise<ProviderPaymentIntent>;
  cancelPaymentIntent(input: { providerIntentId: string }): Promise<ProviderPaymentIntent>;

  createRefund(input: CreateRefundInput): Promise<ProviderRefund>;
  retrieveRefund(input: { providerRefundId: string }): Promise<ProviderRefund>;
  listRefundsForPayment(input: { providerIntentId: string }): Promise<ProviderRefund[]>;

  retrieveDispute(input: { providerDisputeId: string }): Promise<ProviderDispute>;
  listDisputes(input: { providerIntentId: string }): Promise<ProviderDispute[]>;

  verifyWebhook(input: { rawBody: Uint8Array; signature: string }): boolean;
  normalizeWebhookEvent(rawBody: Uint8Array): NormalizedWebhookEvent;

  /**
   * Retained for the Phase 5A payment path. Throws for a non-payment event
   * rather than coercing it, so a refund event can never be mistaken for one.
   */
  parseWebhookEvent(rawBody: Uint8Array): NormalizedPaymentWebhookEvent;
}
