import { createHash } from "node:crypto";

export const DEFAULT_PAYMENT_WEBHOOK_MAX_BYTES = 65_536;

export class PaymentWebhookPayloadTooLargeError extends Error {
  constructor() {
    super("Payment webhook payload exceeds the allowed size.");
    this.name = "PaymentWebhookPayloadTooLargeError";
  }
}

export function assertPaymentWebhookPayloadSize(
  rawBody: Uint8Array | string,
  maximumBytes = DEFAULT_PAYMENT_WEBHOOK_MAX_BYTES,
) {
  const bytes = typeof rawBody === "string" ? Buffer.byteLength(rawBody, "utf8") : rawBody.byteLength;
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1 || bytes > maximumBytes) {
    throw new PaymentWebhookPayloadTooLargeError();
  }
  return bytes;
}

export function hashPaymentWebhookPayload(rawBody: Uint8Array | string) {
  return createHash("sha256").update(rawBody).digest("hex");
}

