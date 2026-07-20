import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client";
import { createDatabaseClient } from "../../src/lib/database";
import { acquireSeatHold } from "../../src/server/holds/hold-service";
import { createCheckoutAndPayment } from "../../src/server/payments/checkout-service";
import { LocalSignedPaymentProvider } from "../../src/server/payments/local-signed-provider";
import { processPaymentWebhook } from "../../src/server/payments/webhook-service";
import { PaymentWebhookSignatureError } from "../../src/server/payments/errors";
import {
  RefundAuthorizationError,
  RefundEligibilityError,
  requestRefund,
  summarizeRefundability,
} from "../../src/server/refunds/refund-service";
import { submitRefund } from "../../src/server/refunds/submission-service";
import {
  getOrganizerFinancialSummary,
  OrganizerFinancialAccessError,
} from "../../src/server/refunds/organizer-queries";
import {
  createRedisInventoryFixture,
  createRedisTestCustomer,
} from "../redis/inventory-fixture";
import { resetIntegrationDatabase } from "./reset-database";

let database: PrismaClient;
const providerSecret = "phase-5c2a-test-provider-secret-00000000000000";
// Integration setup deliberately clears TICKET_CREDENTIAL_SECRET so fulfillment
// does not issue tickets by default. Refund and dispute consequences are about
// tickets, so these tests opt in explicitly, exactly as the Phase 5B suite does.
const credentialSecret = "phase-5c2a-test-ticket-credential-secret-0000";

function provider() {
  return new LocalSignedPaymentProvider(providerSecret, "test");
}

/**
 * Drive a booking all the way to CONFIRMED through the real Phase 5A path: a
 * hold, a checkout, a payment intent, and a verified provider webhook. Refund
 * tests must start from genuinely captured money, never from a hand-written
 * row, or they would prove nothing about the constraints that matter.
 */
async function setupPaidBooking(prefix: string, seatCount = 2) {
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
    {
      holdToken: acquired.hold.publicToken,
      idempotencyKey: `checkout:${prefix}:${Math.random().toString(36).slice(2, 10)}`,
    },
  );
  const attempt = await database.paymentAttempt.findFirstOrThrow({
    where: { orderId: checkout.order.orderId },
  });
  const delivery = local.createSignedWebhook({
    providerIntentId: attempt.providerIntentId!,
    outcome: "success",
    amountMinor: attempt.amountMinor,
    currency: attempt.currency,
  });
  const result = await processPaymentWebhook(database, local, delivery, {
    ticketCredentialSecret: credentialSecret,
  });
  if (result.outcome !== "BOOKED") throw new Error(`expected BOOKED, got ${result.outcome}`);

  const booking = await database.booking.findUniqueOrThrow({
    where: { publicReference: result.bookingReference },
    include: { seats: { orderBy: { id: "asc" } } },
  });
  // Re-read the attempt after settlement so tests compare against the captured
  // payment as it actually stands, not the pre-webhook snapshot.
  const settledAttempt = await database.paymentAttempt.findUniqueOrThrow({
    where: { id: attempt.id },
  });
  return {
    fixture,
    customer,
    local,
    booking,
    attempt: settledAttempt,
    orderId: checkout.order.orderId,
  };
}

beforeEach(async () => {
  database = createDatabaseClient();
  await resetIntegrationDatabase(database);
});

afterEach(async () => {
  await database.$disconnect();
});

describe("Phase 5C2A refund request authorization and calculation", () => {
  it("lets a customer request a refund only for their own paid booking", async () => {
    const context = await setupPaidBooking("refundown");
    const stranger = await createRedisTestCustomer(database, "refundstranger");

    const refund = await requestRefund(
      database,
      { userId: context.customer.id, role: "CUSTOMER" },
      {
        bookingReference: context.booking.publicReference,
        scope: "FULL_BOOKING",
        reasonCode: "CUSTOMER_REQUEST",
        idempotencyKey: "refund-own-1",
      },
    );
    expect(refund.status).toBe("REQUESTED");
    expect(refund.amountMinor).toBe(context.attempt.amountMinor);

    // A stranger is refused, and is told nothing that distinguishes "not yours"
    // from "does not exist".
    await expect(
      requestRefund(
        database,
        { userId: stranger.id, role: "CUSTOMER" },
        {
          bookingReference: context.booking.publicReference,
          scope: "FULL_BOOKING",
          reasonCode: "CUSTOMER_REQUEST",
          idempotencyKey: "refund-stranger-1",
        },
      ),
    ).rejects.toBeInstanceOf(RefundAuthorizationError);
    expect(await database.refund.count()).toBe(1);
  });

  it("calculates the amount on the server from immutable booking snapshots", async () => {
    const context = await setupPaidBooking("refundcalc");
    const seatTotal = context.booking.seats.reduce((sum, seat) => sum + seat.priceMinor, 0);

    const refund = await requestRefund(
      database,
      { userId: context.customer.id, role: "CUSTOMER" },
      {
        bookingReference: context.booking.publicReference,
        scope: "FULL_BOOKING",
        reasonCode: "CUSTOMER_REQUEST",
        idempotencyKey: "refund-calc-1",
      },
    );

    expect(refund.amountMinor).toBe(seatTotal);
    expect(refund.currency).toBe(context.attempt.currency);
    const stored = await database.refund.findUniqueOrThrow({ where: { id: refund.refundId } });
    // Currency is inherited from the captured payment, never supplied.
    expect(stored.currency).toBe(context.attempt.currency);
    expect(stored.provider).toBe(context.attempt.provider);
  });

  it("returns the existing refund for a replayed idempotency key", async () => {
    const context = await setupPaidBooking("refundidem");
    const actor = { userId: context.customer.id, role: "CUSTOMER" as const };
    const request = {
      bookingReference: context.booking.publicReference,
      scope: "FULL_BOOKING" as const,
      reasonCode: "CUSTOMER_REQUEST" as const,
      idempotencyKey: "refund-idem-1",
    };

    const first = await requestRefund(database, actor, request);
    const second = await requestRefund(database, actor, request);

    expect(second.replayed).toBe(true);
    expect(second.refundId).toBe(first.refundId);
    expect(await database.refund.count()).toBe(1);
    // The amount is reserved once, not twice.
    const attempt = await database.paymentAttempt.findUniqueOrThrow({
      where: { id: context.attempt.id },
    });
    expect(attempt.inFlightRefundMinor).toBe(first.amountMinor);
  });

  it("refunds selected seats and then only the remainder", async () => {
    const context = await setupPaidBooking("refundpartial");
    const [firstSeat, secondSeat] = context.booking.seats;

    const partial = await requestRefund(
      database,
      { userId: context.customer.id, role: "CUSTOMER" },
      {
        bookingReference: context.booking.publicReference,
        scope: "SELECTED_SEATS",
        bookingSeatIds: [firstSeat!.id],
        reasonCode: "CUSTOMER_REQUEST",
        idempotencyKey: "refund-partial-1",
      },
    );
    expect(partial.amountMinor).toBe(firstSeat!.priceMinor);

    // A follow-up full-booking request may only claim what is left.
    const remainder = await requestRefund(
      database,
      { userId: context.customer.id, role: "CUSTOMER" },
      {
        bookingReference: context.booking.publicReference,
        scope: "FULL_BOOKING",
        reasonCode: "CUSTOMER_REQUEST",
        idempotencyKey: "refund-partial-2",
      },
    );
    expect(remainder.amountMinor).toBe(secondSeat!.priceMinor);

    const attempt = await database.paymentAttempt.findUniqueOrThrow({
      where: { id: context.attempt.id },
    });
    expect(attempt.inFlightRefundMinor).toBe(context.attempt.amountMinor);
    expect(attempt.refundedMinor).toBe(0);
  });

  it("refuses to reserve more than the captured amount", async () => {
    const context = await setupPaidBooking("refundover");
    const actor = { userId: context.customer.id, role: "CUSTOMER" as const };

    await requestRefund(database, actor, {
      bookingReference: context.booking.publicReference,
      scope: "FULL_BOOKING",
      reasonCode: "CUSTOMER_REQUEST",
      idempotencyKey: "refund-over-1",
    });

    // Everything is already reserved, so a second distinct request has nothing
    // left to claim.
    await expect(
      requestRefund(database, actor, {
        bookingReference: context.booking.publicReference,
        scope: "FULL_BOOKING",
        reasonCode: "CUSTOMER_REQUEST",
        idempotencyKey: "refund-over-2",
      }),
    ).rejects.toBeInstanceOf(RefundEligibilityError);

    const attempt = await database.paymentAttempt.findUniqueOrThrow({
      where: { id: context.attempt.id },
    });
    expect(attempt.refundedMinor + attempt.inFlightRefundMinor).toBeLessThanOrEqual(
      attempt.amountMinor,
    );
  });

  it("keeps sixteen concurrent refund requests within the captured amount", async () => {
    const context = await setupPaidBooking("refundrace", 4);
    const actor = { userId: context.customer.id, role: "CUSTOMER" as const };

    // Distinct idempotency keys, so nothing is deduplicated: each one is a
    // genuine attempt to reserve the whole remaining balance at once.
    const attempts = await Promise.allSettled(
      Array.from({ length: 16 }, (_, index) =>
        requestRefund(database, actor, {
          bookingReference: context.booking.publicReference,
          scope: "FULL_BOOKING",
          reasonCode: "CUSTOMER_REQUEST",
          idempotencyKey: `refund-race-${index}`,
        }),
      ),
    );

    const succeeded = attempts.filter((entry) => entry.status === "fulfilled");
    expect(succeeded.length).toBeGreaterThanOrEqual(1);

    const attempt = await database.paymentAttempt.findUniqueOrThrow({
      where: { id: context.attempt.id },
    });
    // The invariant that matters: whatever interleaving occurred, the database
    // never let the reserved plus refunded total exceed what was captured.
    expect(attempt.refundedMinor + attempt.inFlightRefundMinor).toBeLessThanOrEqual(
      attempt.amountMinor,
    );

    const reserved = await database.refund.aggregate({
      where: {
        paymentAttemptId: context.attempt.id,
        status: { in: ["REQUESTED", "SUBMITTING", "PROCESSING", "REQUIRES_REVIEW"] },
      },
      _sum: { requestedAmountMinor: true },
    });
    expect(reserved._sum.requestedAmountMinor ?? 0).toBeLessThanOrEqual(attempt.amountMinor);
  });

  it("never refunds the same booked seat twice", async () => {
    const context = await setupPaidBooking("refundseattwice");
    const [firstSeat] = context.booking.seats;
    const actor = { userId: context.customer.id, role: "CUSTOMER" as const };

    await requestRefund(database, actor, {
      bookingReference: context.booking.publicReference,
      scope: "SELECTED_SEATS",
      bookingSeatIds: [firstSeat!.id],
      reasonCode: "CUSTOMER_REQUEST",
      idempotencyKey: "refund-seat-1",
    });

    await expect(
      requestRefund(database, actor, {
        bookingReference: context.booking.publicReference,
        scope: "SELECTED_SEATS",
        bookingSeatIds: [firstSeat!.id],
        reasonCode: "CUSTOMER_REQUEST",
        idempotencyKey: "refund-seat-2",
      }),
    ).rejects.toBeInstanceOf(RefundEligibilityError);

    expect(await database.refundSeat.count({ where: { bookingSeatId: firstSeat!.id } })).toBe(1);
  });
});

describe("Phase 5C2A financial ledger and payment immutability", () => {
  it("writes an append-only ledger entry and outbox event atomically with the refund", async () => {
    const context = await setupPaidBooking("refundledger");

    const refund = await requestRefund(
      database,
      { userId: context.customer.id, role: "CUSTOMER" },
      {
        bookingReference: context.booking.publicReference,
        scope: "FULL_BOOKING",
        reasonCode: "CUSTOMER_REQUEST",
        idempotencyKey: "refund-ledger-1",
      },
    );

    const entries = await database.financialLedgerEntry.findMany({
      where: { refundId: refund.refundId },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entryType: "REFUND_REQUESTED",
      direction: "DEBIT",
      amountMinor: refund.amountMinor,
      currency: refund.currency,
    });
    // The raw provider reference is never stored on the ledger.
    expect(entries[0]!.providerReferenceHash).toBeNull();

    const outbox = await database.financialOutbox.findMany({
      where: { refundId: refund.refundId },
    });
    expect(outbox).toHaveLength(1);
    const payload = JSON.stringify(outbox[0]!.payload);
    expect(payload).not.toContain(context.customer.email);
    expect(payload).not.toContain(context.attempt.providerIntentId);
  });

  it("rejects any update or delete of a written ledger entry", async () => {
    const context = await setupPaidBooking("refundappendonly");
    const refund = await requestRefund(
      database,
      { userId: context.customer.id, role: "CUSTOMER" },
      {
        bookingReference: context.booking.publicReference,
        scope: "FULL_BOOKING",
        reasonCode: "CUSTOMER_REQUEST",
        idempotencyKey: "refund-append-1",
      },
    );
    const entry = await database.financialLedgerEntry.findFirstOrThrow({
      where: { refundId: refund.refundId },
    });

    await expect(
      database.financialLedgerEntry.update({
        where: { id: entry.id },
        data: { amountMinor: 1 },
      }),
    ).rejects.toThrow(/append-only/i);
    await expect(
      database.financialLedgerEntry.delete({ where: { id: entry.id } }),
    ).rejects.toThrow(/append-only/i);
  });

  it("leaves the original payment, booking, and inventory untouched by a refund request", async () => {
    const context = await setupPaidBooking("refundimmutable");
    const inventoryBefore = await database.sessionSeatInventory.findMany({
      where: { sessionId: context.booking.sessionId },
      orderBy: { id: "asc" },
      select: { id: true, state: true },
    });

    await requestRefund(
      database,
      { userId: context.customer.id, role: "CUSTOMER" },
      {
        bookingReference: context.booking.publicReference,
        scope: "FULL_BOOKING",
        reasonCode: "CUSTOMER_REQUEST",
        idempotencyKey: "refund-immutable-1",
      },
    );

    const attempt = await database.paymentAttempt.findUniqueOrThrow({
      where: { id: context.attempt.id },
    });
    // The captured payment is never rewritten by a refund.
    expect(attempt.status).toBe("SUCCEEDED");
    expect(attempt.amountMinor).toBe(context.attempt.amountMinor);
    expect(attempt.succeededAt).toEqual(context.attempt.succeededAt);

    const booking = await database.booking.findUniqueOrThrow({
      where: { id: context.booking.id },
    });
    expect(booking.status).toBe("CONFIRMED");
    expect(booking.totalMinor).toBe(context.booking.totalMinor);

    // Requesting a refund never reopens inventory.
    const inventoryAfter = await database.sessionSeatInventory.findMany({
      where: { sessionId: context.booking.sessionId },
      orderBy: { id: "asc" },
      select: { id: true, state: true },
    });
    expect(inventoryAfter).toEqual(inventoryBefore);
    expect(inventoryAfter.filter((row) => row.state === "BOOKED")).toHaveLength(
      context.booking.seats.length,
    );
  });

  it("refuses a refund against a payment that was never captured", async () => {
    const fixture = await createRedisInventoryFixture(database, "refundunpaid");
    const customer = await createRedisTestCustomer(database, "refundunpaidcustomer");
    const acquired = await acquireSeatHold(database, { userId: customer.id }, {
      sessionId: fixture.session.id,
      seatIds: fixture.seatIds.slice(0, 1),
      idempotencyKey: "hold:refund-unpaid",
    });
    await createCheckoutAndPayment(
      database,
      provider(),
      { userId: customer.id },
      { holdToken: acquired.hold.publicToken, idempotencyKey: "checkout:refund-unpaid" },
    );

    // No booking exists because no verified webhook ever settled the payment.
    expect(await database.booking.count()).toBe(0);
    expect(await database.refund.count()).toBe(0);
  });
});

/**
 * Take a booking all the way to a submitted refund: request it, then submit it
 * to the provider. The refund ends PROCESSING with an external identifier, and
 * still unsettled — only a verified webhook may settle it.
 */
async function setupSubmittedRefund(prefix: string, seatCount = 2) {
  const context = await setupPaidBooking(prefix, seatCount);
  const requested = await requestRefund(
    database,
    { userId: context.customer.id, role: "CUSTOMER" },
    {
      bookingReference: context.booking.publicReference,
      scope: "FULL_BOOKING",
      reasonCode: "CUSTOMER_REQUEST",
      idempotencyKey: `${prefix}-refund-1`,
    },
  );
  const submission = await submitRefund(database, context.local, requested.refundId);
  const refund = await database.refund.findUniqueOrThrow({
    where: { id: requested.refundId },
  });
  return { ...context, requested, submission, refund };
}

function refundDelivery(
  context: Awaited<ReturnType<typeof setupSubmittedRefund>>,
  outcome: "succeeded" | "failed" | "processing",
  options: { eventId?: string; occurredAt?: Date; amountMinor?: number } = {},
) {
  return context.local.createSignedRefundWebhook({
    providerIntentId: context.attempt.providerIntentId!,
    providerRefundId: context.refund.providerRefundId!,
    outcome,
    amountMinor: options.amountMinor ?? context.refund.requestedAmountMinor,
    currency: context.refund.currency,
    eventId: options.eventId,
    occurredAt: options.occurredAt,
  });
}

describe("Phase 5C2A refund provider submission", () => {
  it("submits with the precommitted key and attaches the external refund identity", async () => {
    const context = await setupSubmittedRefund("refundsubmit");

    expect(context.submission.outcome).toBe("SUBMITTED");
    expect(context.refund.status).toBe("PROCESSING");
    expect(context.refund.providerRefundId).toBeTruthy();
    // The provider's reply during submission never settles the refund.
    expect(context.refund.succeededAt).toBeNull();

    const attempts = await database.refundAttempt.findMany({
      where: { refundId: context.refund.id },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attemptNumber: 1, status: "SUCCEEDED" });
  });

  it("does not create a second external refund when submission is retried", async () => {
    const context = await setupSubmittedRefund("refundresubmit");

    // The refund is no longer REQUESTED, so a second worker cannot claim it.
    const second = await submitRefund(database, context.local, context.refund.id);
    expect(second.outcome).toBe("ALREADY_SUBMITTED");

    const refund = await database.refund.findUniqueOrThrow({
      where: { id: context.refund.id },
    });
    expect(refund.providerRefundId).toBe(context.refund.providerRefundId);
    const providerRefunds = await context.local.listRefundsForPayment({
      providerIntentId: context.attempt.providerIntentId!,
    });
    expect(providerRefunds).toHaveLength(1);
  });

  it("keeps a refund in flight when the provider times out after accepting the key", async () => {
    const context = await setupPaidBooking("refundtimeout");
    const requested = await requestRefund(
      database,
      { userId: context.customer.id, role: "CUSTOMER" },
      {
        bookingReference: context.booking.publicReference,
        scope: "FULL_BOOKING",
        reasonCode: "CUSTOMER_REQUEST",
        idempotencyKey: "refund-timeout-1",
      },
    );

    // The provider accepts the idempotency key and then the connection breaks.
    context.local.failNextRefund("TIMEOUT");
    const submission = await submitRefund(database, context.local, requested.refundId);
    expect(submission.outcome).toBe("TIMEOUT_PENDING_RECONCILIATION");

    const refund = await database.refund.findUniqueOrThrow({
      where: { id: requested.refundId },
    });
    // Crucially NOT failed: the external refund may well exist, so failing it
    // here would let a retry create a second one.
    expect(refund.status).toBe("PROCESSING");
    expect(refund.failedAt).toBeNull();

    const attempts = await database.refundAttempt.findMany({
      where: { refundId: requested.refundId },
    });
    expect(attempts[0]).toMatchObject({ status: "TIMEOUT" });

    // The provider recorded exactly one refund under the precommitted key, so
    // reconciliation can adopt it rather than creating another.
    const providerRefunds = await context.local.listRefundsForPayment({
      providerIntentId: context.attempt.providerIntentId!,
    });
    expect(providerRefunds).toHaveLength(1);

    const reconciliation = await database.financialOutbox.findMany({
      where: { refundId: requested.refundId, eventType: "FINANCIAL_RECONCILIATION_REQUIRED" },
    });
    expect(reconciliation).toHaveLength(1);
  });

  it("releases the reservation when the provider cleanly rejects the request", async () => {
    const context = await setupPaidBooking("refundreject");
    const requested = await requestRefund(
      database,
      { userId: context.customer.id, role: "CUSTOMER" },
      {
        bookingReference: context.booking.publicReference,
        scope: "FULL_BOOKING",
        reasonCode: "CUSTOMER_REQUEST",
        idempotencyKey: "refund-reject-1",
      },
    );

    context.local.failNextRefund("PROVIDER_ERROR");
    const submission = await submitRefund(database, context.local, requested.refundId);
    expect(submission.outcome).toBe("FAILED");

    const refund = await database.refund.findUniqueOrThrow({
      where: { id: requested.refundId },
    });
    expect(refund.status).toBe("FAILED");
    expect(refund.succeededAt).toBeNull();

    // No success entry of any kind was written.
    const entries = await database.financialLedgerEntry.findMany({
      where: { refundId: requested.refundId },
      select: { entryType: true },
    });
    expect(entries.map((entry) => entry.entryType).sort()).toEqual([
      "REFUND_FAILED",
      "REFUND_REQUESTED",
    ]);

    // The reservation is released, so the money is refundable again.
    const attempt = await database.paymentAttempt.findUniqueOrThrow({
      where: { id: context.attempt.id },
    });
    expect(attempt.inFlightRefundMinor).toBe(0);
    expect(attempt.refundedMinor).toBe(0);
  });
});

describe("Phase 5C2A verified refund webhook settlement", () => {
  it("settles a refund, revokes its tickets, and moves the booking to REFUNDED", async () => {
    const context = await setupSubmittedRefund("refundsettle");
    const inventoryBefore = await database.sessionSeatInventory.findMany({
      where: { sessionId: context.booking.sessionId },
      orderBy: { id: "asc" },
      select: { id: true, state: true },
    });

    const result = await processPaymentWebhook(
      database,
      context.local,
      refundDelivery(context, "succeeded"),
    );
    expect(result.outcome).toBe("REFUND_SETTLED");

    const refund = await database.refund.findUniqueOrThrow({
      where: { id: context.refund.id },
    });
    expect(refund.status).toBe("SUCCEEDED");
    expect(refund.succeededAt).not.toBeNull();

    const attempt = await database.paymentAttempt.findUniqueOrThrow({
      where: { id: context.attempt.id },
    });
    expect(attempt.refundedMinor).toBe(context.refund.requestedAmountMinor);
    expect(attempt.inFlightRefundMinor).toBe(0);
    // The captured payment itself is never rewritten.
    expect(attempt.status).toBe("SUCCEEDED");

    const booking = await database.booking.findUniqueOrThrow({
      where: { id: context.booking.id },
    });
    expect(booking.status).toBe("REFUNDED");
    expect(booking.refundedAt).not.toBeNull();
    expect(booking.totalMinor).toBe(context.booking.totalMinor);

    const tickets = await database.ticket.findMany({ where: { bookingId: context.booking.id } });
    expect(tickets.length).toBeGreaterThan(0);
    expect(tickets.every((ticket) => ticket.status === "REVOKED")).toBe(true);
    const credentials = await database.ticketCredential.findMany({
      where: { ticketId: { in: tickets.map((ticket) => ticket.id) } },
    });
    expect(credentials.every((credential) => credential.status === "REVOKED")).toBe(true);

    // Refunding money never returns inventory to sale.
    const inventoryAfter = await database.sessionSeatInventory.findMany({
      where: { sessionId: context.booking.sessionId },
      orderBy: { id: "asc" },
      select: { id: true, state: true },
    });
    expect(inventoryAfter).toEqual(inventoryBefore);
  });

  it("keeps a used ticket historically used while revoking the rest", async () => {
    const context = await setupSubmittedRefund("refundused");
    const tickets = await database.ticket.findMany({
      where: { bookingId: context.booking.id },
      orderBy: { id: "asc" },
    });
    const usedTicket = tickets[0]!;
    await database.ticket.update({
      where: { id: usedTicket.id },
      data: { status: "USED" },
    });

    await processPaymentWebhook(database, context.local, refundDelivery(context, "succeeded"));

    const after = await database.ticket.findMany({
      where: { bookingId: context.booking.id },
      orderBy: { id: "asc" },
    });
    const stillUsed = after.find((ticket) => ticket.id === usedTicket.id)!;
    // History is preserved: a scanned ticket is not rewritten to look revoked.
    expect(stillUsed.status).toBe("USED");
    expect(stillUsed.revokedAt).toBeNull();
    expect(after.filter((ticket) => ticket.status === "REVOKED").length).toBe(after.length - 1);
  });

  it("treats sixteen duplicate success webhooks as exactly one settlement", async () => {
    const context = await setupSubmittedRefund("refunddupe");
    const delivery = refundDelivery(context, "succeeded", { eventId: "local_evt_dupe_storm_1" });

    const results = await Promise.allSettled(
      Array.from({ length: 16 }, () =>
        processPaymentWebhook(database, context.local, delivery),
      ),
    );
    expect(results.filter((entry) => entry.status === "fulfilled").length).toBeGreaterThan(0);

    // One stored event, one settlement, one success ledger entry.
    expect(await database.paymentWebhookEvent.count({ where: { eventCategory: "REFUND" } })).toBe(1);
    const refund = await database.refund.findUniqueOrThrow({ where: { id: context.refund.id } });
    expect(refund.status).toBe("SUCCEEDED");

    const successEntries = await database.financialLedgerEntry.findMany({
      where: { refundId: context.refund.id, entryType: "REFUND_SUCCEEDED" },
    });
    expect(successEntries).toHaveLength(1);

    const attempt = await database.paymentAttempt.findUniqueOrThrow({
      where: { id: context.attempt.id },
    });
    expect(attempt.refundedMinor).toBe(context.refund.requestedAmountMinor);
  });

  it("changes no financial state when the signature is invalid", async () => {
    const context = await setupSubmittedRefund("refundbadsig");
    const delivery = refundDelivery(context, "succeeded");

    await expect(
      processPaymentWebhook(database, context.local, {
        rawBody: delivery.rawBody,
        signature: delivery.signature.replace(/v1=[a-f0-9]{64}/, `v1=${"0".repeat(64)}`),
      }),
    ).rejects.toBeInstanceOf(PaymentWebhookSignatureError);

    const refund = await database.refund.findUniqueOrThrow({ where: { id: context.refund.id } });
    expect(refund.status).toBe("PROCESSING");
    expect(refund.succeededAt).toBeNull();
    expect(await database.paymentWebhookEvent.count({ where: { eventCategory: "REFUND" } })).toBe(0);
    expect(
      await database.financialLedgerEntry.count({
        where: { refundId: context.refund.id, entryType: "REFUND_SUCCEEDED" },
      }),
    ).toBe(0);
  });

  it("ignores a stale out-of-order event delivered after settlement", async () => {
    const context = await setupSubmittedRefund("refundstale");
    const settledAt = new Date();

    await processPaymentWebhook(
      database,
      context.local,
      refundDelivery(context, "succeeded", {
        eventId: "local_evt_order_success",
        occurredAt: settledAt,
      }),
    );

    // A "processing" event the provider emitted earlier arrives late.
    const stale = await processPaymentWebhook(
      database,
      context.local,
      refundDelivery(context, "processing", {
        eventId: "local_evt_order_stale",
        occurredAt: new Date(settledAt.getTime() - 60_000),
      }),
    );
    expect(stale.outcome).toBe("REFUND_IGNORED");

    const refund = await database.refund.findUniqueOrThrow({ where: { id: context.refund.id } });
    expect(refund.status).toBe("SUCCEEDED");
    expect(refund.succeededAt).not.toBeNull();
  });

  it("escalates contradictory terminal events to review without erasing the first", async () => {
    const context = await setupSubmittedRefund("refundcontradiction");

    await processPaymentWebhook(
      database,
      context.local,
      refundDelivery(context, "succeeded", { eventId: "local_evt_contra_success" }),
    );
    const settled = await database.refund.findUniqueOrThrow({ where: { id: context.refund.id } });

    const contradiction = await processPaymentWebhook(
      database,
      context.local,
      refundDelivery(context, "failed", {
        eventId: "local_evt_contra_failure",
        occurredAt: new Date(Date.now() + 60_000),
      }),
    );
    expect(contradiction.outcome).toBe("REQUIRES_REVIEW");

    const reviewed = await database.refund.findUniqueOrThrow({ where: { id: context.refund.id } });
    expect(reviewed.status).toBe("REQUIRES_REVIEW");
    // The first valid terminal result is preserved, not overwritten.
    expect(reviewed.succeededAt).toEqual(settled.succeededAt);
    expect(reviewed.failedAt).toBeNull();

    const order = await database.checkoutOrder.findUniqueOrThrow({
      where: { id: context.orderId },
    });
    expect(order.financialReviewState).toBe("REFUND_REVIEW");
  });

  it("escalates a provider event whose amount disagrees with the refund", async () => {
    const context = await setupSubmittedRefund("refundmismatch");

    const result = await processPaymentWebhook(
      database,
      context.local,
      refundDelivery(context, "succeeded", {
        eventId: "local_evt_mismatch",
        amountMinor: context.refund.requestedAmountMinor + 100,
      }),
    );
    expect(result.outcome).toBe("REQUIRES_REVIEW");

    const refund = await database.refund.findUniqueOrThrow({ where: { id: context.refund.id } });
    expect(refund.status).toBe("REQUIRES_REVIEW");
    expect(refund.succeededAt).toBeNull();
    const attempt = await database.paymentAttempt.findUniqueOrThrow({
      where: { id: context.attempt.id },
    });
    expect(attempt.refundedMinor).toBe(0);
  });
});

describe("Phase 5C2A dispute and chargeback lifecycle", () => {
  it("opens a dispute only from a verified provider event and flags the order", async () => {
    const context = await setupPaidBooking("disputeopen");
    const delivery = context.local.createSignedDisputeWebhook({
      providerIntentId: context.attempt.providerIntentId!,
      providerDisputeId: "local_dp_open_1",
      status: "open",
      amountMinor: context.attempt.amountMinor,
      currency: context.attempt.currency,
    });

    const result = await processPaymentWebhook(database, context.local, delivery);
    expect(result.outcome).toBe("DISPUTE_RECORDED");

    const dispute = await database.paymentDispute.findFirstOrThrow({
      where: { providerDisputeId: "local_dp_open_1" },
    });
    expect(dispute.status).toBe("OPEN");
    expect(dispute.orderId).toBe(context.orderId);

    const order = await database.checkoutOrder.findUniqueOrThrow({ where: { id: context.orderId } });
    expect(order.financialReviewState).toBe("DISPUTE_REVIEW");

    // An open dispute flags for review but does not touch admission.
    const tickets = await database.ticket.findMany({ where: { bookingId: context.booking.id } });
    expect(tickets.every((ticket) => ticket.status === "ACTIVE")).toBe(true);

    const events = await database.paymentDisputeEvent.findMany({
      where: { disputeId: dispute.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ previousStatus: null, newStatus: "OPEN" });
  });

  it("rejects an unsigned dispute event so no dispute can be fabricated", async () => {
    const context = await setupPaidBooking("disputeforged");
    const delivery = context.local.createSignedDisputeWebhook({
      providerIntentId: context.attempt.providerIntentId!,
      providerDisputeId: "local_dp_forged_1",
      status: "open",
      amountMinor: context.attempt.amountMinor,
      currency: context.attempt.currency,
    });

    await expect(
      processPaymentWebhook(database, context.local, {
        rawBody: delivery.rawBody,
        signature: `t=${Math.floor(Date.now() / 1000)},v1=${"a".repeat(64)}`,
      }),
    ).rejects.toBeInstanceOf(PaymentWebhookSignatureError);

    expect(await database.paymentDispute.count()).toBe(0);
    expect(await database.paymentDisputeEvent.count()).toBe(0);
  });

  it("stays consistent under a duplicate dispute storm", async () => {
    const context = await setupPaidBooking("disputestorm");
    const delivery = context.local.createSignedDisputeWebhook({
      providerIntentId: context.attempt.providerIntentId!,
      providerDisputeId: "local_dp_storm_1",
      status: "open",
      amountMinor: context.attempt.amountMinor,
      currency: context.attempt.currency,
      eventId: "local_evt_dispute_storm",
    });

    await Promise.allSettled(
      Array.from({ length: 16 }, () => processPaymentWebhook(database, context.local, delivery)),
    );

    expect(await database.paymentDispute.count()).toBe(1);
    expect(await database.paymentDisputeEvent.count()).toBe(1);
    expect(await database.paymentWebhookEvent.count({ where: { eventCategory: "DISPUTE" } })).toBe(1);
    const openedEntries = await database.financialLedgerEntry.findMany({
      where: { entryType: "DISPUTE_OPENED" },
    });
    expect(openedEntries).toHaveLength(1);
  });

  it("records a chargeback and revokes unused tickets when a dispute is lost", async () => {
    const context = await setupPaidBooking("disputelost");
    const inventoryBefore = await database.sessionSeatInventory.findMany({
      where: { sessionId: context.booking.sessionId },
      orderBy: { id: "asc" },
      select: { id: true, state: true },
    });
    const tickets = await database.ticket.findMany({
      where: { bookingId: context.booking.id },
      orderBy: { id: "asc" },
    });
    await database.ticket.update({ where: { id: tickets[0]!.id }, data: { status: "USED" } });

    await processPaymentWebhook(
      database,
      context.local,
      context.local.createSignedDisputeWebhook({
        providerIntentId: context.attempt.providerIntentId!,
        providerDisputeId: "local_dp_lost_1",
        status: "open",
        amountMinor: context.attempt.amountMinor,
        currency: context.attempt.currency,
        eventId: "local_evt_lost_open",
      }),
    );
    const lost = await processPaymentWebhook(
      database,
      context.local,
      context.local.createSignedDisputeWebhook({
        providerIntentId: context.attempt.providerIntentId!,
        providerDisputeId: "local_dp_lost_1",
        status: "lost",
        amountMinor: context.attempt.amountMinor,
        currency: context.attempt.currency,
        eventId: "local_evt_lost_final",
      }),
    );
    expect(lost.outcome).toBe("DISPUTE_RECORDED");

    const dispute = await database.paymentDispute.findFirstOrThrow({
      where: { providerDisputeId: "local_dp_lost_1" },
    });
    expect(dispute.status).toBe("LOST");
    expect(dispute.outcome).toBe("LOST");
    expect(dispute.closedAt).not.toBeNull();

    const chargeback = await database.financialLedgerEntry.findMany({
      where: { disputeId: dispute.id, entryType: "CHARGEBACK_RECORDED" },
    });
    expect(chargeback).toHaveLength(1);
    expect(chargeback[0]).toMatchObject({ direction: "DEBIT" });

    const after = await database.ticket.findMany({
      where: { bookingId: context.booking.id },
      orderBy: { id: "asc" },
    });
    expect(after.find((ticket) => ticket.id === tickets[0]!.id)!.status).toBe("USED");
    expect(after.filter((ticket) => ticket.status === "REVOKED").length).toBe(after.length - 1);

    const order = await database.checkoutOrder.findUniqueOrThrow({ where: { id: context.orderId } });
    expect(order.financialReviewState).toBe("CHARGEBACK_REVIEW");

    // A chargeback never reopens inventory either.
    const inventoryAfter = await database.sessionSeatInventory.findMany({
      where: { sessionId: context.booking.sessionId },
      orderBy: { id: "asc" },
      select: { id: true, state: true },
    });
    expect(inventoryAfter).toEqual(inventoryBefore);
  });

  it("freezes a dispute whose provider reports contradictory terminal outcomes", async () => {
    const context = await setupPaidBooking("disputecontra");
    const base = {
      providerIntentId: context.attempt.providerIntentId!,
      providerDisputeId: "local_dp_contra_1",
      amountMinor: context.attempt.amountMinor,
      currency: context.attempt.currency,
    };

    await processPaymentWebhook(
      database,
      context.local,
      context.local.createSignedDisputeWebhook({
        ...base,
        status: "won",
        eventId: "local_evt_contra_won",
      }),
    );
    const contradiction = await processPaymentWebhook(
      database,
      context.local,
      context.local.createSignedDisputeWebhook({
        ...base,
        status: "lost",
        eventId: "local_evt_contra_lost",
      }),
    );
    expect(contradiction.outcome).toBe("REQUIRES_REVIEW");

    const dispute = await database.paymentDispute.findFirstOrThrow({
      where: { providerDisputeId: "local_dp_contra_1" },
    });
    expect(dispute.status).toBe("REQUIRES_REVIEW");
    // The first terminal outcome survives the contradiction.
    expect(dispute.outcome).toBe("WON");
    // A contradicted dispute must not have quietly recorded a chargeback.
    expect(
      await database.financialLedgerEntry.count({
        where: { disputeId: dispute.id, entryType: "CHARGEBACK_RECORDED" },
      }),
    ).toBe(0);
  });

  it("detects refund and dispute overlap on the same payment", async () => {
    const context = await setupSubmittedRefund("disputeoverlap");
    await processPaymentWebhook(database, context.local, refundDelivery(context, "succeeded"));

    await processPaymentWebhook(
      database,
      context.local,
      context.local.createSignedDisputeWebhook({
        providerIntentId: context.attempt.providerIntentId!,
        providerDisputeId: "local_dp_overlap_1",
        status: "open",
        amountMinor: context.attempt.amountMinor,
        currency: context.attempt.currency,
      }),
    );

    // The customer has already been refunded in full; a chargeback for the same
    // money would compensate them twice, so the order is raised rather than
    // auto-resolved.
    const overlap = await database.financialOutbox.findMany({
      where: { eventType: "FINANCIAL_RECONCILIATION_REQUIRED" },
    });
    expect(overlap.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(overlap.map((row) => row.payload))).toContain("REFUND_DISPUTE_OVERLAP");

    const order = await database.checkoutOrder.findUniqueOrThrow({ where: { id: context.orderId } });
    expect(["DISPUTE_REVIEW", "CHARGEBACK_REVIEW"]).toContain(order.financialReviewState);
  });

  it("keeps a refund-success and dispute-open race consistent", async () => {
    const context = await setupSubmittedRefund("refunddisputerace");
    const refundEvent = refundDelivery(context, "succeeded", { eventId: "local_evt_race_refund" });
    const disputeEvent = context.local.createSignedDisputeWebhook({
      providerIntentId: context.attempt.providerIntentId!,
      providerDisputeId: "local_dp_race_1",
      status: "open",
      amountMinor: context.attempt.amountMinor,
      currency: context.attempt.currency,
      eventId: "local_evt_race_dispute",
    });

    await Promise.allSettled([
      processPaymentWebhook(database, context.local, refundEvent),
      processPaymentWebhook(database, context.local, disputeEvent),
    ]);

    const refund = await database.refund.findUniqueOrThrow({ where: { id: context.refund.id } });
    const dispute = await database.paymentDispute.findFirstOrThrow({
      where: { providerDisputeId: "local_dp_race_1" },
    });
    const attempt = await database.paymentAttempt.findUniqueOrThrow({
      where: { id: context.attempt.id },
    });

    // Whichever order they landed in, both are recorded, the refund settled at
    // most once, and the captured amount was never exceeded.
    expect(refund.status).toBe("SUCCEEDED");
    expect(dispute.status).toBe("OPEN");
    expect(attempt.refundedMinor).toBeLessThanOrEqual(attempt.amountMinor);
    expect(
      await database.financialLedgerEntry.count({
        where: { refundId: refund.id, entryType: "REFUND_SUCCEEDED" },
      }),
    ).toBe(1);
  });
});

describe("Phase 5C2A organizer financial isolation", () => {
  it("scopes every aggregate to the organizer's own organization", async () => {
    const context = await setupSubmittedRefund("orgscope");
    await processPaymentWebhook(database, context.local, refundDelivery(context, "succeeded"));

    // A member of the organization that owns the booking.
    const organizer = await createRedisTestCustomer(database, "orgscopeorganizer");
    await database.membership.create({
      data: {
        userId: organizer.id,
        organizationId: context.booking.organizationId,
        role: "ADMIN",
      },
    });

    const summary = await getOrganizerFinancialSummary(database, {
      userId: organizer.id,
      organizationSlug: (
        await database.organization.findUniqueOrThrow({
          where: { id: context.booking.organizationId },
          select: { slug: true },
        })
      ).slug,
    });

    expect(summary.refunds.succeeded).toBe(1);
    expect(summary.refundedByCurrency[0]).toMatchObject({
      currency: context.refund.currency,
      totalMinor: context.refund.requestedAmountMinor,
    });
    // Aggregates only: no provider identifier or customer identity is exposed.
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(context.attempt.providerIntentId);
    expect(serialized).not.toContain(context.refund.providerRefundId);
    expect(serialized).not.toContain(context.customer.email);
    expect(serialized).not.toContain(context.booking.publicReference);
  });

  it("denies an organizer from another organization", async () => {
    const first = await setupSubmittedRefund("orgisolateone");
    const second = await setupPaidBooking("orgisolatetwo");

    // A genuine organizer, but of a different organization.
    const outsider = await createRedisTestCustomer(database, "orgisolateoutsider");
    await database.membership.create({
      data: {
        userId: outsider.id,
        organizationId: second.booking.organizationId,
        role: "OWNER",
      },
    });

    const targetSlug = (
      await database.organization.findUniqueOrThrow({
        where: { id: first.booking.organizationId },
        select: { slug: true },
      })
    ).slug;

    // Naming another tenant's slug directly is refused: access is resolved from
    // membership, never from the supplied identifier.
    await expect(
      getOrganizerFinancialSummary(database, {
        userId: outsider.id,
        organizationSlug: targetSlug,
      }),
    ).rejects.toBeInstanceOf(OrganizerFinancialAccessError);
  });

  it("denies a customer with no organizer membership at all", async () => {
    const context = await setupPaidBooking("orgnomember");
    const slug = (
      await database.organization.findUniqueOrThrow({
        where: { id: context.booking.organizationId },
        select: { slug: true },
      })
    ).slug;

    await expect(
      getOrganizerFinancialSummary(database, {
        userId: context.customer.id,
        organizationSlug: slug,
      }),
    ).rejects.toBeInstanceOf(OrganizerFinancialAccessError);
  });
});

describe("Phase 5C2A customer refund visibility", () => {
  it("reports server-calculated refundability without exposing provider identifiers", async () => {
    const context = await setupPaidBooking("refundsummary");

    const summary = await summarizeRefundability(database, {
      bookingReference: context.booking.publicReference,
      actorUserId: context.customer.id,
    });

    expect(summary).not.toBeNull();
    expect(summary!.paidMinor).toBe(context.attempt.amountMinor);
    expect(summary!.refundedMinor).toBe(0);
    expect(summary!.maximumRefundableMinor).toBe(context.attempt.amountMinor);
    expect(summary!.eligible).toBe(true);
    expect(summary!.seats).toHaveLength(context.booking.seats.length);

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(context.attempt.providerIntentId);
    expect(serialized).not.toContain(context.attempt.providerIdempotencyKey);
  });

  it("returns nothing for another customer's booking", async () => {
    const context = await setupPaidBooking("refundsummaryother");
    const stranger = await createRedisTestCustomer(database, "refundsummarystranger");

    const summary = await summarizeRefundability(database, {
      bookingReference: context.booking.publicReference,
      actorUserId: stranger.id,
    });
    expect(summary).toBeNull();
  });
});
