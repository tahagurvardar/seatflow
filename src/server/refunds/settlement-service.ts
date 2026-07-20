import { decideRefundTicketConsequence } from "@/features/refunds/authorization";
import { decideRefundTransition, isStaleProviderEvent } from "@/features/refunds/lifecycle";
import { Prisma } from "@/generated/prisma/client";
import type { RefundStatus } from "@/generated/prisma/enums";
import { appendLedgerEntry, enqueueFinancialEvent } from "@/server/payments/ledger-service";

/**
 * Refund settlement from a verified provider webhook.
 *
 * This is the only path that may set `succeededAt` on a refund. A browser
 * redirect, a client response, an organizer action, and the provider's own
 * reply during submission all cannot; only a signature-verified event reaching
 * this function settles money.
 *
 * Everything below runs inside one transaction supplied by the caller, and the
 * webhook row is only marked processed at the very end of it, so a failure
 * anywhere leaves the event to be retried rather than silently swallowed.
 */

export type RefundSettlementOutcome =
  | { outcome: "APPLIED"; status: RefundStatus }
  | { outcome: "IGNORED"; reason: string }
  | { outcome: "REVIEW"; safeCode: string }
  | { outcome: "UNKNOWN_REFUND" };

interface SettleInput {
  webhookId: string;
  providerRefundId: string;
  incomingStatus: RefundStatus;
  amountMinor: number;
  currency: string;
  occurredAt: Date | null;
  now: Date;
  correlationId?: string | null;
}

/**
 * Revoke the admission a refund paid for.
 *
 * Three rules hold regardless of scope: a ticket already USED stays USED and
 * keeps its redemption history, nothing is ever deleted, and inventory is not
 * touched at all — the Phase 5A trigger makes BOOKED terminal, so a refunded
 * seat does not quietly return to sale.
 */
async function applyTicketConsequences(
  transaction: Prisma.TransactionClient,
  input: { refundId: string; bookingId: string; scope: string; now: Date },
) {
  // A seat-scoped refund revokes only the seats it actually covered.
  const refundedSeatIds =
    input.scope === "SELECTED_SEATS"
      ? await transaction.refundSeat
          .findMany({ where: { refundId: input.refundId }, select: { bookingSeatId: true } })
          .then((rows) => rows.map((row) => row.bookingSeatId))
      : null;

  const tickets = await transaction.ticket.findMany({
    where: {
      bookingId: input.bookingId,
      ...(refundedSeatIds ? { bookingSeatId: { in: refundedSeatIds } } : {}),
    },
    select: { id: true, status: true },
  });

  let revoked = 0;
  let preservedUsed = 0;
  for (const ticket of tickets) {
    const decision = decideRefundTicketConsequence({
      ticketStatus: ticket.status,
      seatWasRefunded: true,
    });
    if (decision.action !== "REVOKE") {
      if (ticket.status === "USED") preservedUsed += 1;
      continue;
    }

    // The credential is revoked with the ticket so the QR stops validating,
    // while both rows remain readable as history.
    await transaction.ticketCredential.updateMany({
      where: { ticketId: ticket.id, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAt: input.now },
    });
    await transaction.ticket.update({
      where: { id: ticket.id },
      data: {
        status: "REVOKED",
        revokedAt: input.now,
        revocationReason: decision.safeReason,
        updatedAt: input.now,
      },
    });
    await transaction.ticketAuditEvent.create({
      data: {
        ticketId: ticket.id,
        action: "REVOKED",
        safeReason: decision.safeReason,
        createdAt: input.now,
      },
    });
    revoked += 1;
  }
  return { revoked, preservedUsed, considered: tickets.length };
}

/**
 * Apply one verified refund event.
 *
 * Duplicate delivery is safe twice over: the caller's unique
 * `(provider, providerEventId)` insert means a repeat never reaches here, and
 * the ledger's deterministic idempotency key means even a repeat that did
 * could not write a second entry.
 */
export async function settleRefundFromVerifiedEvent(
  transaction: Prisma.TransactionClient,
  input: SettleInput,
): Promise<RefundSettlementOutcome> {
  // Lock the refund before reading its status so two concurrent deliveries
  // cannot both decide they are the one advancing it.
  const locked = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "Refund" WHERE "providerRefundId" = ${input.providerRefundId} FOR UPDATE
  `);
  if (!locked[0]) return { outcome: "UNKNOWN_REFUND" };

  const refund = await transaction.refund.findUniqueOrThrow({
    where: { id: locked[0].id },
    select: {
      id: true,
      status: true,
      orderId: true,
      paymentAttemptId: true,
      bookingId: true,
      requestedAmountMinor: true,
      currency: true,
      provider: true,
      scope: true,
      succeededAt: true,
      failedAt: true,
      publicReference: true,
    },
  });

  await transaction.paymentWebhookEvent.update({
    where: { id: input.webhookId },
    data: { refundId: refund.id },
  });

  // A provider event whose amount or currency disagrees with the refund we
  // created is never applied; it is escalated instead.
  if (
    input.amountMinor !== refund.requestedAmountMinor ||
    input.currency !== refund.currency
  ) {
    await markRefundUnderReview(transaction, {
      refund,
      safeCode: "REFUND_AMOUNT_OR_CURRENCY_MISMATCH",
      now: input.now,
      correlationId: input.correlationId,
    });
    return { outcome: "REVIEW", safeCode: "REFUND_AMOUNT_OR_CURRENCY_MISMATCH" };
  }

  // An event older than the outcome already recorded is stale delivery, not
  // new information.
  if (
    isStaleProviderEvent({
      lastAppliedAt: refund.succeededAt ?? refund.failedAt,
      incomingOccurredAt: input.occurredAt,
    })
  ) {
    return { outcome: "IGNORED", reason: "STALE_PROVIDER_EVENT" };
  }

  const decision = decideRefundTransition({
    current: refund.status,
    incoming: input.incomingStatus,
  });

  if (decision.outcome === "IGNORE") {
    return { outcome: "IGNORED", reason: decision.reason };
  }
  if (decision.outcome === "REVIEW") {
    await markRefundUnderReview(transaction, {
      refund,
      safeCode: decision.safeCode,
      now: input.now,
      correlationId: input.correlationId,
    });
    return { outcome: "REVIEW", safeCode: decision.safeCode };
  }

  if (decision.status === "SUCCEEDED") {
    await transaction.refund.update({
      where: { id: refund.id },
      data: {
        status: "SUCCEEDED",
        succeededAt: input.now,
        safeFailureCode: null,
        version: { increment: 1 },
        updatedAt: input.now,
      },
    });
    await appendLedgerEntry(transaction, {
      entryType: "REFUND_SUCCEEDED",
      amountMinor: refund.requestedAmountMinor,
      currency: refund.currency,
      orderId: refund.orderId,
      paymentAttemptId: refund.paymentAttemptId,
      bookingId: refund.bookingId,
      refundId: refund.id,
      provider: refund.provider,
      // Keyed on the provider event, so redelivery cannot double-write.
      causeKey: input.webhookId,
      providerReference: input.providerRefundId,
      effectiveAt: input.occurredAt ?? input.now,
      correlationId: input.correlationId ?? null,
    });

    const consequences = await applyTicketConsequences(transaction, {
      refundId: refund.id,
      bookingId: refund.bookingId,
      scope: refund.scope,
      now: input.now,
    });

    await maybeMarkBookingFullyRefunded(transaction, {
      bookingId: refund.bookingId,
      paymentAttemptId: refund.paymentAttemptId,
      now: input.now,
    });

    await enqueueFinancialEvent(transaction, {
      eventType: "REFUND_SUCCEEDED",
      deduplicationKey: `refund-succeeded:${refund.id}`,
      aggregateId: refund.id,
      orderId: refund.orderId,
      refundId: refund.id,
      bookingId: refund.bookingId,
      payload: {
        refundReference: refund.publicReference,
        amountMinor: refund.requestedAmountMinor,
        currency: refund.currency,
        ticketsRevoked: consequences.revoked,
        usedTicketsPreserved: consequences.preservedUsed,
      },
      now: input.now,
    });
    if (consequences.revoked > 0) {
      await enqueueFinancialEvent(transaction, {
        eventType: "TICKET_REVOCATION_REQUESTED",
        deduplicationKey: `refund-revocation:${refund.id}`,
        aggregateId: refund.id,
        orderId: refund.orderId,
        refundId: refund.id,
        bookingId: refund.bookingId,
        payload: { revoked: consequences.revoked },
        now: input.now,
      });
    }
    return { outcome: "APPLIED", status: "SUCCEEDED" };
  }

  if (decision.status === "FAILED") {
    await transaction.refund.update({
      where: { id: refund.id },
      data: {
        status: "FAILED",
        failedAt: input.now,
        safeFailureCode: "PROVIDER_REPORTED_FAILURE",
        version: { increment: 1 },
        updatedAt: input.now,
      },
    });
    // No success entry of any kind is written for a failed refund.
    await appendLedgerEntry(transaction, {
      entryType: "REFUND_FAILED",
      amountMinor: refund.requestedAmountMinor,
      currency: refund.currency,
      orderId: refund.orderId,
      paymentAttemptId: refund.paymentAttemptId,
      bookingId: refund.bookingId,
      refundId: refund.id,
      provider: refund.provider,
      causeKey: input.webhookId,
      providerReference: input.providerRefundId,
      effectiveAt: input.occurredAt ?? input.now,
      correlationId: input.correlationId ?? null,
    });
    await enqueueFinancialEvent(transaction, {
      eventType: "REFUND_FAILED",
      deduplicationKey: `refund-failed:${refund.id}`,
      aggregateId: refund.id,
      orderId: refund.orderId,
      refundId: refund.id,
      bookingId: refund.bookingId,
      payload: { safeCode: "PROVIDER_REPORTED_FAILURE" },
      now: input.now,
    });
    return { outcome: "APPLIED", status: "FAILED" };
  }

  // PROCESSING and other advancing non-terminal states.
  await transaction.refund.update({
    where: { id: refund.id },
    data: {
      status: decision.status,
      submittedAt: input.now,
      version: { increment: 1 },
      updatedAt: input.now,
    },
  });
  return { outcome: "APPLIED", status: decision.status };
}

async function markRefundUnderReview(
  transaction: Prisma.TransactionClient,
  input: {
    refund: {
      id: string;
      orderId: string;
      paymentAttemptId: string;
      bookingId: string;
      requestedAmountMinor: number;
      currency: string;
      provider: string;
      publicReference: string;
    };
    safeCode: string;
    now: Date;
    correlationId?: string | null;
  },
) {
  await transaction.refund.update({
    where: { id: input.refund.id },
    data: {
      status: "REQUIRES_REVIEW",
      reviewRequiredAt: input.now,
      safeFailureCode: input.safeCode,
      version: { increment: 1 },
      updatedAt: input.now,
    },
  });
  // The order is flagged so the refund stops being invisible to operators.
  await transaction.checkoutOrder.update({
    where: { id: input.refund.orderId },
    data: { financialReviewState: "REFUND_REVIEW", updatedAt: input.now },
  });
  await enqueueFinancialEvent(transaction, {
    eventType: "REFUND_REQUIRES_REVIEW",
    deduplicationKey: `refund-review:${input.refund.id}`,
    aggregateId: input.refund.id,
    orderId: input.refund.orderId,
    refundId: input.refund.id,
    bookingId: input.refund.bookingId,
    payload: { safeCode: input.safeCode, refundReference: input.refund.publicReference },
    now: input.now,
  });
}

/**
 * Move a booking to the terminal REFUNDED state once succeeded refunds cover
 * what was captured. A database trigger re-checks the same condition, so an
 * application bug cannot label a booking refunded before the money returned.
 */
async function maybeMarkBookingFullyRefunded(
  transaction: Prisma.TransactionClient,
  input: { bookingId: string; paymentAttemptId: string; now: Date },
) {
  const attempt = await transaction.paymentAttempt.findUniqueOrThrow({
    where: { id: input.paymentAttemptId },
    select: { amountMinor: true, refundedMinor: true },
  });
  if (attempt.refundedMinor < attempt.amountMinor) return false;

  const booking = await transaction.booking.findUniqueOrThrow({
    where: { id: input.bookingId },
    select: { status: true },
  });
  if (booking.status !== "CONFIRMED") return false;

  await transaction.booking.update({
    where: { id: input.bookingId },
    data: { status: "REFUNDED", refundedAt: input.now },
  });
  return true;
}
