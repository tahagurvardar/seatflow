import { describe, expect, it } from "vitest";

import { LocalSignedPaymentProvider } from "@/server/payments/local-signed-provider";

const provider = new LocalSignedPaymentProvider("test-only-local-provider-secret-000000000000", "test");
const input = {
  orderReference: "order_reference_1234567890123456",
  amountMinor: 5_000,
  currency: "AZN" as const,
  idempotencyKey: "pay_123456789012345678901234567890",
  expiresAt: new Date("2035-01-01T00:10:00.000Z"),
};

describe("local signed payment-provider contract", () => {
  it("creates exactly one deterministic intent for an idempotency key", async () => {
    const first = await provider.createPaymentIntent(input);
    const second = await provider.createPaymentIntent(input);
    expect(first.providerIntentId).toBe(second.providerIntentId);
    expect(first.status).toBe("PENDING");
  });

  it("creates and verifies a successful signed webhook", async () => {
    const intent = await provider.createPaymentIntent(input);
    const delivery = provider.createSignedWebhook({ providerIntentId: intent.providerIntentId, outcome: "success", amountMinor: input.amountMinor, currency: input.currency });
    expect(provider.verifyWebhook(delivery)).toBe(true);
    expect(provider.parseWebhookEvent(delivery.rawBody)).toMatchObject({ providerEventId: delivery.eventId, providerIntentId: intent.providerIntentId, status: "SUCCEEDED", amountMinor: 5_000, currency: "AZN" });
  });

  it("creates and verifies a failed signed webhook", async () => {
    const intent = await provider.createPaymentIntent(input);
    const delivery = provider.createSignedWebhook({ providerIntentId: intent.providerIntentId, outcome: "failure", amountMinor: input.amountMinor, currency: input.currency });
    expect(provider.verifyWebhook(delivery)).toBe(true);
    expect(provider.parseWebhookEvent(delivery.rawBody).status).toBe("FAILED");
  });

  it("supports duplicate and delayed deliveries", async () => {
    const intent = await provider.createPaymentIntent(input);
    const delivery = provider.createSignedWebhook({ providerIntentId: intent.providerIntentId, outcome: "success", amountMinor: input.amountMinor, currency: input.currency, eventId: "local_evt_duplicate123", occurredAt: new Date("2030-01-01T00:00:00.000Z"), signatureTimestamp: 1_893_456_000 });
    expect(provider.verifyWebhook(delivery)).toBe(true);
    expect(provider.verifyWebhook(delivery)).toBe(true);
    expect(provider.parseWebhookEvent(delivery.rawBody).occurredAt?.toISOString()).toBe("2030-01-01T00:00:00.000Z");
  });

  it("rejects invalid signatures and exact-body tampering", async () => {
    const intent = await provider.createPaymentIntent(input);
    const delivery = provider.createSignedWebhook({ providerIntentId: intent.providerIntentId, outcome: "success", amountMinor: input.amountMinor, currency: input.currency });
    const finalCharacter = delivery.signature.at(-1);
    const invalidSignature = `${delivery.signature.slice(0, -1)}${finalCharacter === "0" ? "1" : "0"}`;
    expect(provider.verifyWebhook({ ...delivery, signature: invalidSignature })).toBe(false);
    expect(provider.verifyWebhook({ ...delivery, rawBody: Buffer.concat([delivery.rawBody, Buffer.from(" ")]) })).toBe(false);
  });

  it("retrieves and cancels provider intents through the shared contract", async () => {
    const intent = await provider.createPaymentIntent(input);
    await expect(provider.retrievePaymentIntent({ providerIntentId: intent.providerIntentId })).resolves.toMatchObject({
      providerIntentId: intent.providerIntentId,
      status: "PENDING",
    });
    await expect(provider.cancelPaymentIntent({ providerIntentId: intent.providerIntentId })).resolves.toMatchObject({
      providerIntentId: intent.providerIntentId,
      status: "CANCELLED",
    });
  });

  it("is impossible to instantiate in production", () => {
    expect(() => new LocalSignedPaymentProvider("test-only-local-provider-secret-000000000000", "production")).toThrow(/disabled in production/i);
  });

  it("never accepts or returns raw payment information", async () => {
    const intent = await provider.createPaymentIntent(input);
    expect(JSON.stringify(intent)).not.toMatch(/card|cvv|bank|paymentMethod/i);
  });
});
