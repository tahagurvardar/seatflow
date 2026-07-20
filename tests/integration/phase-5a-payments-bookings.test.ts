import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client";
import { createDatabaseClient } from "../../src/lib/database";
import { cancelEventSession } from "../../src/server/events/event-session-service";
import { acquireSeatHold, releaseSeatHold } from "../../src/server/holds/hold-service";
import {
  createCheckoutAndPayment,
  createCheckoutOrder,
  ensurePaymentIntent,
} from "../../src/server/payments/checkout-service";
import {
  getCustomerBookingByReference,
  getOrganizerBookingSummary,
} from "../../src/server/payments/booking-queries";
import { getCustomerCheckoutByReference } from "../../src/server/payments/checkout-queries";
import {
  CheckoutAuthorizationError,
  CheckoutValidationError,
  PaymentProviderError,
  PaymentWebhookSignatureError,
} from "../../src/server/payments/errors";
import { LocalSignedPaymentProvider } from "../../src/server/payments/local-signed-provider";
import type { PaymentProvider } from "../../src/server/payments/payment-provider";
import { reprocessVerifiedWebhook } from "../../src/server/payments/operations-service";
import { processPaymentWebhook } from "../../src/server/payments/webhook-service";
import {
  createRedisInventoryFixture,
  createRedisTestCustomer,
} from "../redis/inventory-fixture";
import { resetIntegrationDatabase } from "./reset-database";

let database: PrismaClient;
const providerSecret = "phase-5a-test-provider-secret-000000000000000000";

function provider() {
  return new LocalSignedPaymentProvider(providerSecret, "test");
}

function idempotency(label: string) {
  return `checkout:${label}:${Math.random().toString(36).slice(2, 12)}`;
}

async function setupCheckout(prefix: string, seatCount = 2) {
  const fixture = await createRedisInventoryFixture(database, prefix);
  const customer = await createRedisTestCustomer(database, `${prefix}customer`);
  const acquired = await acquireSeatHold(database, { userId: customer.id }, {
    sessionId: fixture.session.id,
    seatIds: fixture.seatIds.slice(0, seatCount),
    idempotencyKey: `hold:${prefix}:${Math.random().toString(36).slice(2, 10)}`,
  });
  const local = provider();
  const checkout = await createCheckoutAndPayment(
    database,
    local,
    { userId: customer.id },
    { holdToken: acquired.hold.publicToken, idempotencyKey: idempotency(prefix) },
  );
  const attempt = await database.paymentAttempt.findFirstOrThrow({
    where: { orderId: checkout.order.orderId },
  });
  const order = await database.checkoutOrder.findUniqueOrThrow({
    where: { id: checkout.order.orderId },
    include: { items: true },
  });
  return { fixture, customer, acquired, local, checkout, attempt, order };
}

function deliveryFor(
  context: Awaited<ReturnType<typeof setupCheckout>>,
  outcome: "success" | "failure",
  options: { eventId?: string; amountMinor?: number } = {},
) {
  return context.local.createSignedWebhook({
    providerIntentId: context.attempt.providerIntentId!,
    outcome,
    amountMinor: options.amountMinor ?? context.attempt.amountMinor,
    currency: context.attempt.currency,
    eventId: options.eventId,
  });
}

beforeEach(async () => {
  database = createDatabaseClient();
  await resetIntegrationDatabase(database);
});

afterEach(async () => {
  await database.$disconnect();
});

describe("Phase 5A checkout creation", () => {
  it("creates checkout only from the authenticated customer's active hold and rejects client financial fields", async () => {
    const fixture = await createRedisInventoryFixture(database, "checkoutauth");
    const owner = await createRedisTestCustomer(database, "checkoutowner");
    const attacker = await createRedisTestCustomer(database, "checkoutattacker");
    const acquired = await acquireSeatHold(database, { userId: owner.id }, {
      sessionId: fixture.session.id,
      seatIds: fixture.seatIds.slice(0, 2),
      idempotencyKey: "hold:checkout-auth",
    });
    await expect(createCheckoutOrder(database, { userId: attacker.id }, {
      holdToken: acquired.hold.publicToken,
      idempotencyKey: "checkout:attacker",
    }, { provider: "LOCAL_SIGNED" })).rejects.toBeInstanceOf(CheckoutAuthorizationError);
    await expect(createCheckoutOrder(database, { userId: owner.id }, {
      holdToken: acquired.hold.publicToken,
      idempotencyKey: "checkout:manipulated",
      totalMinor: 1,
      currency: "USD",
      status: "FULFILLED",
      userId: attacker.id,
    }, { provider: "LOCAL_SIGNED" })).rejects.toBeInstanceOf(CheckoutValidationError);
    await expect(database.checkoutOrder.count()).resolves.toBe(0);
  });

  it("copies immutable order items from hold and inventory snapshots", async () => {
    const context = await setupCheckout("snapshots");
    expect(context.order.items).toHaveLength(2);
    expect(context.order.totalMinor).toBe(5_000);
    expect(context.order.currency).toBe("AZN");
    expect(context.order.items.every((item) => item.priceMinor === 2_500 && item.currency === "AZN")).toBe(true);
    await expect(database.checkoutOrderItem.update({
      where: { id: context.order.items[0]!.id },
      data: { priceMinor: 1 },
    })).rejects.toThrow(/immutable/i);
    await expect(database.checkoutOrder.update({
      where: { id: context.order.id },
      data: { totalMinor: 1, subtotalMinor: 1 },
    })).rejects.toThrow(/immutable/i);
  });

  it("returns one order for idempotent and concurrent checkout creation", async () => {
    const fixture = await createRedisInventoryFixture(database, "checkoutconcurrent");
    const customer = await createRedisTestCustomer(database, "checkoutconcurrentcustomer");
    const acquired = await acquireSeatHold(database, { userId: customer.id }, {
      sessionId: fixture.session.id,
      seatIds: fixture.seatIds.slice(0, 2),
      idempotencyKey: "hold:checkout-concurrent",
    });
    const input = { holdToken: acquired.hold.publicToken, idempotencyKey: "checkout:one-key" };
    const results = await Promise.all([
      createCheckoutOrder(database, { userId: customer.id }, input, { provider: "LOCAL_SIGNED" }),
      createCheckoutOrder(database, { userId: customer.id }, input, { provider: "LOCAL_SIGNED" }),
    ]);
    expect(results[0]!.orderId).toBe(results[1]!.orderId);
    await expect(database.checkoutOrder.count()).resolves.toBe(1);
    await expect(database.paymentAttempt.count()).resolves.toBe(1);
  });

  it("recovers from a provider timeout with the same precommitted idempotency key", async () => {
    const fixture = await createRedisInventoryFixture(database, "checkouttimeout");
    const customer = await createRedisTestCustomer(database, "checkouttimeoutcustomer");
    const acquired = await acquireSeatHold(database, { userId: customer.id }, {
      sessionId: fixture.session.id,
      seatIds: fixture.seatIds.slice(0, 2),
      idempotencyKey: "hold:checkout-timeout",
    });
    const order = await createCheckoutOrder(database, { userId: customer.id }, {
      holdToken: acquired.hold.publicToken,
      idempotencyKey: "checkout:timeout-recovery",
    }, { provider: "LOCAL_SIGNED" });
    const unavailableProvider: PaymentProvider = {
      name: "LOCAL_SIGNED",
      simulated: true,
      capabilityReport() {
        return {
          provider: "LOCAL_SIGNED",
          simulated: true,
          mode: "simulated",
          supportsPartialRefund: false,
          supportsRefundReconciliation: false,
          supportsDisputeEvents: false,
          supportsWebhookSecretRotation: false,
          supportedCurrencies: [],
          safeConfigurationSummary: "unavailable test double",
        };
      },
      async createPaymentIntent() { throw new Error("provider timeout"); },
      async retrievePaymentIntent() { throw new Error("provider unavailable"); },
      async cancelPaymentIntent() { throw new Error("provider unavailable"); },
      async createRefund() { throw new Error("provider unavailable"); },
      async retrieveRefund() { throw new Error("provider unavailable"); },
      async listRefundsForPayment() { throw new Error("provider unavailable"); },
      async retrieveDispute() { throw new Error("provider unavailable"); },
      async listDisputes() { throw new Error("provider unavailable"); },
      verifyWebhook() { return false; },
      normalizeWebhookEvent() { throw new Error("not available"); },
      parseWebhookEvent() { throw new Error("not available"); },
    };

    await expect(ensurePaymentIntent(database, unavailableProvider, order.orderId)).rejects.toBeInstanceOf(PaymentProviderError);
    const pending = await database.paymentAttempt.findFirstOrThrow({ where: { orderId: order.orderId } });
    expect(pending).toMatchObject({ providerIntentId: null, status: "CREATED" });

    const recovered = await ensurePaymentIntent(database, provider(), order.orderId);
    expect(recovered.replayed).toBe(false);
    const replay = await ensurePaymentIntent(database, provider(), order.orderId);
    expect(replay.replayed).toBe(true);
    expect(replay.intent.providerIntentId).toBe(recovered.intent.providerIntentId);
    await expect(database.paymentAttempt.count({ where: { orderId: order.orderId } })).resolves.toBe(1);
  });
});

describe("Phase 5A verified webhook fulfillment", () => {
  it("creates one confirmed booking, books inventory, converts the hold, and atomically writes outbox events", async () => {
    const context = await setupCheckout("success");
    const result = await processPaymentWebhook(database, context.local, deliveryFor(context, "success"));
    expect(result.outcome).toBe("BOOKED");
    await expect(database.booking.count({ where: { orderId: context.order.id } })).resolves.toBe(1);
    await expect(database.bookingSeat.count({ where: { booking: { orderId: context.order.id } } })).resolves.toBe(2);
    await expect(database.sessionSeatInventory.count({ where: { id: { in: context.order.items.map((item) => item.inventoryId) }, state: "BOOKED", currentHoldId: null, holdExpiresAt: null } })).resolves.toBe(2);
    await expect(database.seatHold.findUniqueOrThrow({ where: { publicToken: context.acquired.hold.publicToken } })).resolves.toMatchObject({ status: "CONVERTED" });
    await expect(database.checkoutOrder.findUniqueOrThrow({ where: { id: context.order.id } })).resolves.toMatchObject({ status: "FULFILLED" });
    const events = await database.inventoryEventOutbox.findMany({ where: { aggregateId: { in: [context.order.id, (await database.booking.findUniqueOrThrow({ where: { orderId: context.order.id } })).id] } }, select: { eventType: true, payload: true } });
    expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining(["PAYMENT_SUCCEEDED", "INVENTORY_BOOKED", "BOOKING_CONFIRMED"]));
    expect(JSON.stringify(events)).not.toContain(context.customer.id);
    expect(JSON.stringify(events)).not.toContain(context.acquired.hold.publicToken);
  });

  it("treats duplicate and concurrent duplicate webhooks as exact-once success", async () => {
    const context = await setupCheckout("duplicate");
    const delivery = deliveryFor(context, "success", { eventId: "local_evt_exact_duplicate" });
    const results = await Promise.all([
      processPaymentWebhook(database, context.local, delivery),
      processPaymentWebhook(database, context.local, delivery),
    ]);
    expect(results.every((result) => result.outcome === "BOOKED")).toBe(true);
    await expect(database.paymentWebhookEvent.count()).resolves.toBe(1);
    await expect(database.booking.count()).resolves.toBe(1);
    await expect(database.bookingSeat.count()).resolves.toBe(2);
  });

  it("creates exactly one booking for concurrent distinct success event deliveries", async () => {
    const context = await setupCheckout("concurrentevents");
    const [first, second] = await Promise.all([
      processPaymentWebhook(database, context.local, deliveryFor(context, "success", { eventId: "local_evt_success_a" })),
      processPaymentWebhook(database, context.local, deliveryFor(context, "success", { eventId: "local_evt_success_b" })),
    ]);
    expect(first.outcome).toBe("BOOKED");
    expect(second.outcome).toBe("BOOKED");
    await expect(database.booking.count()).resolves.toBe(1);
  });

  it("never releases booked inventory after the original hold expires", async () => {
    const context = await setupCheckout("permanent");
    await processPaymentWebhook(database, context.local, deliveryFor(context, "success"));
    const future = new Date(context.acquired.hold.expiresAt);
    future.setHours(future.getHours() + 1);
    const { sweepExpiredHolds } = await import("../../src/server/holds/expiry-service");
    await sweepExpiredHolds(database, { now: future });
    await releaseSeatHold(database, { userId: context.customer.id }, { publicToken: context.acquired.hold.publicToken });
    await expect(database.sessionSeatInventory.count({ where: { state: "BOOKED" } })).resolves.toBe(2);
    await expect(database.sessionSeatInventory.count({ where: { state: "AVAILABLE" } })).resolves.toBe(2);
  });

  it("enforces unique booked inventory and physical seat per session", async () => {
    const context = await setupCheckout("uniqueseat", 1);
    const result = await processPaymentWebhook(database, context.local, deliveryFor(context, "success"));
    expect(result.outcome).toBe("BOOKED");
    const booking = await database.booking.findUniqueOrThrow({ where: { orderId: context.order.id }, include: { seats: true } });
    const seat = booking.seats[0]!;
    await expect(database.bookingSeat.create({ data: { ...seat, id: undefined, createdAt: new Date() } })).rejects.toThrow();
  });

  it("rolls back every fulfillment write and can safely reprocess the verified webhook", async () => {
    const context = await setupCheckout("rollback");
    const delivery = deliveryFor(context, "success", { eventId: "local_evt_rollback" });
    await expect(processPaymentWebhook(database, context.local, delivery, { beforeCommit() { throw new Error("test rollback"); } })).rejects.toThrow(/test rollback/i);
    await expect(database.booking.count()).resolves.toBe(0);
    await expect(database.bookingSeat.count()).resolves.toBe(0);
    await expect(database.sessionSeatInventory.count({ where: { state: "BOOKED" } })).resolves.toBe(0);
    const webhook = await database.paymentWebhookEvent.findFirstOrThrow();
    expect(webhook.processingStatus).toBe("FAILED");
    const recovered = await reprocessVerifiedWebhook(database, webhook.id);
    expect(recovered.outcome).toBe("BOOKED");
    await expect(database.booking.count()).resolves.toBe(1);
  });
});

describe("Phase 5A payment/hold races and security", () => {
  it("preserves paid-but-unfulfilled review for released, expired, and cancelled-session holds", async () => {
    const released = await setupCheckout("releasedreview", 1);
    await releaseSeatHold(database, { userId: released.customer.id }, { publicToken: released.acquired.hold.publicToken });
    expect((await processPaymentWebhook(database, released.local, deliveryFor(released, "success"))).outcome).toBe("REQUIRES_REVIEW");
    await expect(database.checkoutOrder.findUniqueOrThrow({ where: { id: released.order.id } })).resolves.toMatchObject({ status: "PAID_UNFULFILLED", safeFailureCode: "HOLD_RELEASED" });

    await resetIntegrationDatabase(database);
    const expired = await setupCheckout("expiredreview", 1);
    const afterExpiry = new Date(new Date(expired.acquired.hold.expiresAt).getTime() + 1);
    expect((await processPaymentWebhook(database, expired.local, deliveryFor(expired, "success"), { now: afterExpiry })).outcome).toBe("REQUIRES_REVIEW");
    await expect(database.booking.count()).resolves.toBe(0);

    await resetIntegrationDatabase(database);
    const cancelled = await setupCheckout("cancelledreview", 1);
    await cancelEventSession(database, { ...cancelled.fixture.organizerScope, sessionId: cancelled.fixture.session.id });
    expect((await processPaymentWebhook(database, cancelled.local, deliveryFor(cancelled, "success"))).outcome).toBe("REQUIRES_REVIEW");
    await expect(database.checkoutOrder.findUniqueOrThrow({ where: { id: cancelled.order.id } })).resolves.toMatchObject({ status: "PAID_UNFULFILLED" });
  });

  it("records failed payment without creating a booking", async () => {
    const context = await setupCheckout("failedpayment");
    const result = await processPaymentWebhook(database, context.local, deliveryFor(context, "failure"));
    expect(result.outcome).toBe("FAILED");
    await expect(database.booking.count()).resolves.toBe(0);
    await expect(database.checkoutOrder.findUniqueOrThrow({ where: { id: context.order.id } })).resolves.toMatchObject({ status: "FAILED", paidAt: null });
    await expect(database.sessionSeatInventory.count({ where: { state: "HELD" } })).resolves.toBe(2);
  });

  it("rejects forged signatures without recording a webhook or changing financial state", async () => {
    const context = await setupCheckout("forged");
    const delivery = deliveryFor(context, "success");
    await expect(processPaymentWebhook(database, context.local, { ...delivery, signature: "t=1234567890,v1=" + "0".repeat(64) })).rejects.toBeInstanceOf(PaymentWebhookSignatureError);
    await expect(database.paymentWebhookEvent.count()).resolves.toBe(0);
    await expect(database.booking.count()).resolves.toBe(0);
    await expect(database.checkoutOrder.findUniqueOrThrow({ where: { id: context.order.id } })).resolves.toMatchObject({ status: "PAYMENT_PENDING" });
  });

  it("flags amount manipulation and contradictory terminal provider outcomes for review", async () => {
    const amount = await setupCheckout("amountreview", 1);
    const amountResult = await processPaymentWebhook(database, amount.local, deliveryFor(amount, "success", { amountMinor: amount.attempt.amountMinor + 1 }));
    expect(amountResult).toMatchObject({ outcome: "REQUIRES_REVIEW", safeCode: "PAYMENT_AMOUNT_OR_CURRENCY_MISMATCH" });
    await expect(database.booking.count()).resolves.toBe(0);

    await resetIntegrationDatabase(database);
    const contradictory = await setupCheckout("contradictory", 1);
    await processPaymentWebhook(database, contradictory.local, deliveryFor(contradictory, "failure", { eventId: "local_evt_first_failure" }));
    const result = await processPaymentWebhook(database, contradictory.local, deliveryFor(contradictory, "success", { eventId: "local_evt_late_success" }));
    expect(result).toMatchObject({ outcome: "REQUIRES_REVIEW", safeCode: "CONTRADICTORY_TERMINAL_STATUS" });
    await expect(database.checkoutOrder.findUniqueOrThrow({ where: { id: contradictory.order.id } })).resolves.toMatchObject({ status: "FAILED" });
    await expect(database.booking.count()).resolves.toBe(0);
  });

  it("denies cross-user booking/order reads and cross-organization organizer aggregates", async () => {
    const context = await setupCheckout("readsecurity", 1);
    const processed = await processPaymentWebhook(database, context.local, deliveryFor(context, "success"));
    if (processed.outcome !== "BOOKED") throw new Error("Expected booking.");
    const attacker = await createRedisTestCustomer(database, "readattacker");
    await expect(getCustomerCheckoutByReference(database, { userId: attacker.id }, context.order.publicReference)).rejects.toBeInstanceOf(CheckoutAuthorizationError);
    await expect(getCustomerBookingByReference(database, { userId: attacker.id }, processed.bookingReference)).rejects.toBeInstanceOf(CheckoutAuthorizationError);

    const other = await createRedisInventoryFixture(database, "otherorganizer");
    await expect(getOrganizerBookingSummary(database, {
      userId: other.organizerScope.userId,
      organizationSlug: other.organizerScope.organizationSlug,
      eventSlug: context.fixture.organizerScope.eventSlug,
      sessionId: context.fixture.session.id,
    })).rejects.toBeInstanceOf(CheckoutAuthorizationError);
  });
});
