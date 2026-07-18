import type {
  Currency,
  PaymentAttemptStatus,
  PaymentProviderName,
} from "@/generated/prisma/enums";

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

export interface NormalizedPaymentWebhookEvent {
  providerEventId: string;
  eventType: string;
  providerIntentId: string;
  status: PaymentAttemptStatus;
  amountMinor: number;
  currency: Currency;
  occurredAt: Date | null;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  readonly simulated: boolean;

  createPaymentIntent(input: CreatePaymentIntentInput): Promise<ProviderPaymentIntent>;
  retrievePaymentIntent(input: {
    providerIntentId: string;
  }): Promise<ProviderPaymentIntent>;
  cancelPaymentIntent(input: {
    providerIntentId: string;
  }): Promise<ProviderPaymentIntent>;
  verifyWebhook(input: { rawBody: Uint8Array; signature: string }): boolean;
  parseWebhookEvent(rawBody: Uint8Array): NormalizedPaymentWebhookEvent;
}

