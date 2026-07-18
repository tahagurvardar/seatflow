import { describe, expect, it } from "vitest";

import { readPaymentEnvironment } from "@/env/schema";
import { decidePaidFulfillment, isCheckoutExpired, isTerminalCheckoutStatus } from "@/features/checkout/lifecycle";
import { calculateCheckoutTotal } from "@/features/checkout/totals";
import { toCheckoutDisplayState } from "@/features/checkout/view-models";
import { createSafeCommerceEventPayload } from "@/features/payments/events";
import { isContradictoryTerminalStatus, normalizeProviderPaymentStatus } from "@/features/payments/status";
import { assertPaymentWebhookPayloadSize, hashPaymentWebhookPayload, PaymentWebhookPayloadTooLargeError } from "@/features/payments/webhook";

const future = new Date("2035-01-01T00:10:00.000Z");
const now = new Date("2035-01-01T00:00:00.000Z");

describe("Phase 5A checkout totals and lifecycle", () => {
  it("calculates official totals with integer minor units", () => {
    expect(calculateCheckoutTotal([{ priceMinor: 2_500, currency: "AZN" }, { priceMinor: 3_000, currency: "AZN" }])).toEqual({ subtotalMinor: 5_500, totalMinor: 5_500, currency: "AZN", seatCount: 2 });
  });

  it("rejects empty, mixed-currency, negative, and overflowing totals", () => {
    expect(() => calculateCheckoutTotal([])).toThrow(/at least one/i);
    expect(() => calculateCheckoutTotal([{ priceMinor: 1, currency: "AZN" }, { priceMinor: 1, currency: "USD" }])).toThrow(/mix/i);
    expect(() => calculateCheckoutTotal([{ priceMinor: -1, currency: "AZN" }])).toThrow(/non-negative/i);
    expect(() => calculateCheckoutTotal([{ priceMinor: 2_147_483_647, currency: "AZN" }, { priceMinor: 1, currency: "AZN" }])).toThrow(/range/i);
  });

  it("expires only unpaid pending checkout states", () => {
    expect(isCheckoutExpired({ status: "PAYMENT_PENDING", checkoutExpiresAt: now, now })).toBe(true);
    expect(isCheckoutExpired({ status: "FULFILLED", checkoutExpiresAt: now, now })).toBe(false);
    expect(isCheckoutExpired({ status: "PENDING", checkoutExpiresAt: future, now })).toBe(false);
  });

  it("identifies every terminal order status", () => {
    for (const status of ["FULFILLED", "FAILED", "CANCELLED", "EXPIRED", "PAID_UNFULFILLED", "REQUIRES_REVIEW"] as const) {
      expect(isTerminalCheckoutStatus(status)).toBe(true);
    }
    expect(isTerminalCheckoutStatus("PAYMENT_PENDING")).toBe(false);
  });
});

describe("Phase 5A payment and hold race decisions", () => {
  const eligible = {
    orderStatus: "PAYMENT_PENDING" as const,
    holdStatus: "ACTIVE" as const,
    holdExpiresAt: future,
    eventStatus: "PUBLISHED" as const,
    sessionStatus: "ON_SALE" as const,
    now,
  };

  it("fulfills a verified payment while the hold remains valid", () => {
    expect(decidePaidFulfillment(eligible)).toEqual({ outcome: "FULFILL" });
  });

  it("treats an already fulfilled order as idempotent", () => {
    expect(decidePaidFulfillment({ ...eligible, orderStatus: "FULFILLED" })).toEqual({ outcome: "IDEMPOTENT" });
  });

  it("routes released, expired, converted, cancelled-session, and unavailable-event payments to review", () => {
    expect(decidePaidFulfillment({ ...eligible, holdStatus: "RELEASED" })).toMatchObject({ outcome: "REVIEW", code: "HOLD_RELEASED" });
    expect(decidePaidFulfillment({ ...eligible, holdExpiresAt: now })).toMatchObject({ outcome: "REVIEW", code: "HOLD_EXPIRED" });
    expect(decidePaidFulfillment({ ...eligible, holdStatus: "CONVERTED" })).toMatchObject({ outcome: "REVIEW", code: "HOLD_NOT_ACTIVE" });
    expect(decidePaidFulfillment({ ...eligible, sessionStatus: "CANCELLED" })).toMatchObject({ outcome: "REVIEW", code: "SESSION_CANCELLED" });
    expect(decidePaidFulfillment({ ...eligible, eventStatus: "CANCELLED" })).toMatchObject({ outcome: "REVIEW", code: "SESSION_UNAVAILABLE" });
  });

  it("preserves a conflicting terminal order outcome for review", () => {
    expect(decidePaidFulfillment({ ...eligible, orderStatus: "FAILED" })).toMatchObject({ outcome: "REVIEW", code: "ORDER_TERMINAL_CONFLICT" });
  });
});

describe("Phase 5A provider normalization and webhook safety", () => {
  it("allows the local signed provider only with an explicit development/test secret", () => {
    expect(readPaymentEnvironment({ NODE_ENV: "test", PAYMENT_PROVIDER: "LOCAL_SIGNED", LOCAL_PAYMENT_WEBHOOK_SECRET: "test-only-secret-000000000000000000" })).toMatchObject({ PAYMENT_PROVIDER: "LOCAL_SIGNED" });
    expect(() => readPaymentEnvironment({ NODE_ENV: "test", PAYMENT_PROVIDER: "LOCAL_SIGNED" })).toThrow(/LOCAL_PAYMENT_WEBHOOK_SECRET/i);
  });

  it("forbids the simulated provider in production", () => {
    expect(() => readPaymentEnvironment({ NODE_ENV: "production", PAYMENT_PROVIDER: "LOCAL_SIGNED", LOCAL_PAYMENT_WEBHOOK_SECRET: "test-only-secret-000000000000000000" })).toThrow(/forbidden in production/i);
  });

  it("normalizes supported provider statuses", () => {
    expect(normalizeProviderPaymentStatus("paid")).toBe("SUCCEEDED");
    expect(normalizeProviderPaymentStatus("requires_payment_method")).toBe("FAILED");
    expect(normalizeProviderPaymentStatus("processing")).toBe("PENDING");
    expect(normalizeProviderPaymentStatus("cancelled")).toBe("CANCELLED");
  });

  it("rejects unknown provider statuses", () => {
    expect(() => normalizeProviderPaymentStatus("mystery")).toThrow(/unsupported/i);
  });

  it("detects contradictory terminal statuses", () => {
    expect(isContradictoryTerminalStatus("FAILED", "SUCCEEDED")).toBe(true);
    expect(isContradictoryTerminalStatus("SUCCEEDED", "SUCCEEDED")).toBe(false);
    expect(isContradictoryTerminalStatus("PENDING", "SUCCEEDED")).toBe(false);
  });

  it("enforces raw payload size and hashes the exact body", () => {
    expect(assertPaymentWebhookPayloadSize("hello", 5)).toBe(5);
    expect(() => assertPaymentWebhookPayloadSize("hello!", 5)).toThrow(PaymentWebhookPayloadTooLargeError);
    expect(hashPaymentWebhookPayload("hello")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashPaymentWebhookPayload("hello")).not.toBe(hashPaymentWebhookPayload("hello "));
  });

  it("emits a minimal commerce invalidation payload", () => {
    const payload = createSafeCommerceEventPayload({ eventId: "fbe9e996-dc29-42f4-b9df-bd264a919f72", sessionId: "session_1", eventType: "BOOKING_CONFIRMED", now });
    expect(payload).toEqual({ eventId: "fbe9e996-dc29-42f4-b9df-bd264a919f72", sessionId: "session_1", eventType: "BOOKING_CONFIRMED", serverTimestamp: now.toISOString() });
    expect(JSON.stringify(payload)).not.toMatch(/email|userId|holdToken|signature|paymentMethod/i);
  });
});

describe("Phase 5A honest checkout display states", () => {
  const base = { paymentStatus: "PENDING" as const, bookingConfirmed: false, checkoutExpiresAt: future, now };

  it("never treats a query-string or provider-return concept as confirmation", () => {
    expect(toCheckoutDisplayState({ ...base, orderStatus: "PAYMENT_PENDING" })).toBe("PENDING");
  });

  it("requires both fulfilled order state and a confirmed booking", () => {
    expect(toCheckoutDisplayState({ ...base, orderStatus: "FULFILLED", bookingConfirmed: false })).toBe("PENDING");
    expect(toCheckoutDisplayState({ ...base, orderStatus: "FULFILLED", bookingConfirmed: true })).toBe("CONFIRMED");
  });

  it("maps failed, paid-review, expired, and cancelled states honestly", () => {
    expect(toCheckoutDisplayState({ ...base, orderStatus: "FAILED" })).toBe("FAILED");
    expect(toCheckoutDisplayState({ ...base, orderStatus: "PAID_UNFULFILLED" })).toBe("REQUIRES_REVIEW");
    expect(toCheckoutDisplayState({ ...base, orderStatus: "EXPIRED" })).toBe("EXPIRED");
    expect(toCheckoutDisplayState({ ...base, orderStatus: "CANCELLED" })).toBe("CANCELLED");
  });
});
