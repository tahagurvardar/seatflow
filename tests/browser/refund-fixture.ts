import { createHmac } from "node:crypto";

import { acquireSeatHold } from "../../src/server/holds/hold-service";
import { createCheckoutAndPayment } from "../../src/server/payments/checkout-service";
import { LocalSignedPaymentProvider } from "../../src/server/payments/local-signed-provider";
import { processPaymentWebhook } from "../../src/server/payments/webhook-service";
import { createRedisInventoryFixture } from "../redis/inventory-fixture";
import { createBrowserTestDatabase } from "./seed";

/**
 * A genuinely paid booking for the browser customer.
 *
 * Prior state is created by driving the **real** Phase 5A path — hold,
 * checkout, payment intent, verified webhook — rather than by writing rows.
 * That matters: a hand-built booking would not exercise the constraints and
 * triggers the refund flow then depends on.
 *
 * What this file does NOT do is touch anything the refund test is meant to
 * prove. It never writes a Refund, Booking status, Ticket status, inventory
 * state, ledger entry, or webhook processing row on behalf of the flow under
 * test; the browser drives all of that through the real UI and the real
 * webhook route.
 */

/** Must match the local provider secret the running server verifies against. */
function requireLocalWebhookSecret() {
  const secret = process.env.LOCAL_PAYMENT_WEBHOOK_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "LOCAL_PAYMENT_WEBHOOK_SECRET is required for the browser refund fixture.",
    );
  }
  return secret;
}

export function createLocalProvider() {
  return new LocalSignedPaymentProvider({ current: requireLocalWebhookSecret() }, "test");
}

export interface RefundFixture {
  bookingReference: string;
  providerIntentId: string;
  sessionId: string;
  /** The seat that will stay ACTIVE and is expected to be revoked on refund. */
  refundableSeatLabel: string;
  /** A ticket deliberately marked USED, to prove history is preserved. */
  usedTicketReference: string;
  paidMinor: number;
  currency: string;
}

const CREDENTIAL_SECRET = "browser-refund-fixture-credential-secret-000";

/**
 * Build (or reuse) one paid, ticketed booking owned by the browser customer.
 * Idempotent on the marker below so repeated runs do not pile up fixtures.
 */
export async function ensureRefundFixture(customerId: string): Promise<RefundFixture> {
  const database = createBrowserTestDatabase();
  try {
    // Reuse only a booking that is still genuinely refundable. A booking left
    // over from an earlier run may be CONFIRMED yet already carry a reserved or
    // settled refund, which would make the panel correctly ineligible and turn
    // a rerun into a false failure. `refunds: { none: {} }` is what keeps the
    // suite deterministic across repeated runs.
    const existing = await database.booking.findFirst({
      where: { userId: customerId, status: "CONFIRMED", refunds: { none: {} } },
      include: {
        seats: { orderBy: { id: "asc" } },
        tickets: { orderBy: { id: "asc" } },
        order: { include: { paymentAttempts: true } },
      },
      orderBy: { confirmedAt: "desc" },
    });
    if (existing && existing.tickets.length >= 2) {
      return {
        bookingReference: existing.publicReference,
        providerIntentId: existing.order.paymentAttempts[0]!.providerIntentId!,
        sessionId: existing.sessionId,
        refundableSeatLabel: existing.seats[1]!.seatLabel,
        usedTicketReference:
          existing.tickets.find((ticket) => ticket.status === "USED")?.publicReference ??
          existing.tickets[0]!.publicReference,
        paidMinor: existing.totalMinor,
        currency: existing.currency,
      };
    }

    // A unique prefix per creation. `createRedisInventoryFixture` derives
    // organization, venue, and event slugs from it, so a fixed prefix collides
    // with the fixture a previous run left behind — and that history is
    // financial, so it is kept rather than deleted to make room.
    const prefix = `BrowserRefund${Date.now().toString(36)}`;
    const fixture = await createRedisInventoryFixture(database, prefix);
    const provider = createLocalProvider();

    const acquired = await acquireSeatHold(database, { userId: customerId }, {
      sessionId: fixture.session.id,
      seatIds: fixture.seatIds.slice(0, 2),
      idempotencyKey: `browser-refund-hold-${Date.now()}`,
    });
    const checkout = await createCheckoutAndPayment(
      database,
      provider,
      { userId: customerId },
      {
        holdToken: acquired.hold.publicToken,
        idempotencyKey: `browser-refund-checkout-${Date.now()}`,
      },
    );
    const attempt = await database.paymentAttempt.findFirstOrThrow({
      where: { orderId: checkout.order.orderId },
    });

    // Payment settles through the real verified-webhook path, exactly as a
    // real purchase would.
    const delivery = provider.createSignedWebhook({
      providerIntentId: attempt.providerIntentId!,
      outcome: "success",
      amountMinor: attempt.amountMinor,
      currency: attempt.currency,
    });
    const result = await processPaymentWebhook(database, provider, delivery, {
      ticketCredentialSecret: CREDENTIAL_SECRET,
    });
    if (result.outcome !== "BOOKED") {
      throw new Error(`Browser refund fixture expected BOOKED, got ${result.outcome}`);
    }

    const booking = await database.booking.findUniqueOrThrow({
      where: { publicReference: result.bookingReference },
      include: {
        seats: { orderBy: { id: "asc" } },
        tickets: { orderBy: { id: "asc" } },
      },
    });

    // One ticket is deliberately marked USED so the refund flow can prove that
    // redemption history survives. This is fixture setup for a seat the refund
    // under test does not cover, not a rewrite of the flow's own outcome.
    const usedTicket = booking.tickets[0]!;
    await database.ticket.update({
      where: { id: usedTicket.id },
      data: { status: "USED" },
    });

    return {
      bookingReference: booking.publicReference,
      providerIntentId: attempt.providerIntentId!,
      sessionId: booking.sessionId,
      refundableSeatLabel: booking.seats[1]!.seatLabel,
      usedTicketReference: usedTicket.publicReference,
      paidMinor: booking.totalMinor,
      currency: booking.currency,
    };
  } finally {
    await database.$disconnect();
  }
}

/**
 * Sign a refund webhook exactly as the local provider does, for delivery to the
 * application's own webhook route over HTTP.
 *
 * This produces a valid synthetic signature. It writes nothing: the route, its
 * signature verification, and the settlement transaction are the real ones.
 */
export function buildSignedRefundWebhook(input: {
  providerIntentId: string;
  providerRefundId: string;
  amountMinor: number;
  currency: string;
  outcome?: "succeeded" | "failed";
  eventId?: string;
}) {
  const provider = createLocalProvider();
  return provider.createSignedRefundWebhook({
    providerIntentId: input.providerIntentId,
    providerRefundId: input.providerRefundId,
    outcome: input.outcome ?? "succeeded",
    amountMinor: input.amountMinor,
    currency: input.currency as never,
    eventId: input.eventId,
  });
}

/** An intentionally invalid signature, to prove verification is load-bearing. */
export function forgeInvalidSignature(rawBody: Uint8Array) {
  const timestamp = Math.floor(Date.now() / 1_000);
  const wrong = createHmac("sha256", "not-the-real-secret-000000000000000000")
    .update(String(timestamp))
    .update(".")
    .update(rawBody)
    .digest("hex");
  return `t=${timestamp},v1=${wrong}`;
}
