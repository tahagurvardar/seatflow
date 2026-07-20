import { randomBytes } from "node:crypto";

import {
  decideDisputeTicketConsequence,
  decideDisputeTransition,
  detectRefundDisputeOverlap,
  isTerminalDisputeStatus,
} from "@/features/disputes/lifecycle";
import { Prisma } from "@/generated/prisma/client";
import type {
  DisputeReasonCategory,
  DisputeStatus,
  LedgerEntryType,
} from "@/generated/prisma/enums";
import { appendLedgerEntry, enqueueFinancialEvent } from "@/server/payments/ledger-service";

/**
 * Dispute and chargeback lifecycle.
 *
 * A dispute exists here only because a signature-verified provider webhook
 * created it. There is deliberately no function in this module that an
 * organizer, an admin, or a browser request can call to open, advance, or close
 * one: fabricating a dispute would fabricate a reason to revoke a customer's
 * tickets.
 *
 * The first valid terminal outcome is permanent. A provider that reports WON
 * and later LOST has told us two incompatible things about the same money, so
 * the dispute is frozen for a human rather than flipped.
 */

function generatePublicReference() {
  return randomBytes(24).toString("base64url");
}

export type DisputeProcessingOutcome =
  | { outcome: "OPENED"; disputeId: string }
  | { outcome: "APPLIED"; disputeId: string; status: DisputeStatus }
  | { outcome: "IGNORED"; disputeId: string; reason: string }
  | { outcome: "REVIEW"; disputeId: string; safeCode: string }
  | { outcome: "UNKNOWN_PAYMENT" };

interface DisputeEventInput {
  webhookId: string;
  providerEventId: string;
  eventType: string;
  providerIntentId: string;
  providerDisputeId: string;
  status: DisputeStatus;
  reasonCategory: DisputeReasonCategory;
  amountMinor: number;
  currency: string;
  occurredAt: Date | null;
  evidenceDueAt: Date | null;
  now: Date;
  correlationId?: string | null;
}

const LEDGER_TYPE_BY_STATUS: Partial<Record<DisputeStatus, LedgerEntryType>> = {
  OPEN: "DISPUTE_OPENED",
  NEEDS_RESPONSE: "DISPUTE_UPDATED",
  UNDER_REVIEW: "DISPUTE_UPDATED",
  WON: "DISPUTE_WON",
  LOST: "DISPUTE_LOST",
  CLOSED: "DISPUTE_UPDATED",
};

/**
 * Apply one verified dispute event, creating the dispute if this is the first
 * time we have heard of it. Runs inside the caller's transaction.
 */
export async function applyDisputeFromVerifiedEvent(
  transaction: Prisma.TransactionClient,
  input: DisputeEventInput,
): Promise<DisputeProcessingOutcome> {
  const attempt = await transaction.paymentAttempt.findFirst({
    where: { providerIntentId: input.providerIntentId },
    select: {
      id: true,
      orderId: true,
      provider: true,
      currency: true,
      amountMinor: true,
      refundedMinor: true,
    },
  });
  if (!attempt) return { outcome: "UNKNOWN_PAYMENT" };

  const booking = await transaction.booking.findUnique({
    where: { orderId: attempt.orderId },
    select: { id: true },
  });

  // Lock any existing dispute so concurrent deliveries for the same dispute
  // serialize rather than both deciding they are advancing it.
  const existingRows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "PaymentDispute"
    WHERE "provider" = ${attempt.provider}::"PaymentProviderName"
      AND "providerDisputeId" = ${input.providerDisputeId}
    FOR UPDATE
  `);

  if (!existingRows[0]) {
    return openDispute(transaction, { input, attempt, bookingId: booking?.id ?? null });
  }

  const dispute = await transaction.paymentDispute.findUniqueOrThrow({
    where: { id: existingRows[0].id },
  });
  await transaction.paymentWebhookEvent.update({
    where: { id: input.webhookId },
    data: { disputeId: dispute.id },
  });

  const decision = decideDisputeTransition({
    current: dispute.status,
    incoming: input.status,
  });

  if (decision.outcome === "IGNORE") {
    // Still recorded as history: we heard it, we did not act on it.
    await appendDisputeEvent(transaction, {
      disputeId: dispute.id,
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      previousStatus: dispute.status,
      newStatus: dispute.status,
      effectiveAt: input.occurredAt ?? input.now,
      now: input.now,
      safeMetadata: { ignored: decision.reason },
    });
    return { outcome: "IGNORED", disputeId: dispute.id, reason: decision.reason };
  }

  if (decision.outcome === "REVIEW") {
    await transaction.paymentDispute.update({
      where: { id: dispute.id },
      data: {
        status: "REQUIRES_REVIEW",
        safeProviderStatus: decision.safeCode,
        version: { increment: 1 },
        updatedAt: input.now,
      },
    });
    await transaction.checkoutOrder.update({
      where: { id: dispute.orderId },
      data: { financialReviewState: "DISPUTE_REVIEW", updatedAt: input.now },
    });
    await appendDisputeEvent(transaction, {
      disputeId: dispute.id,
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      previousStatus: dispute.status,
      newStatus: "REQUIRES_REVIEW",
      effectiveAt: input.occurredAt ?? input.now,
      now: input.now,
      safeMetadata: { safeCode: decision.safeCode },
    });
    await enqueueFinancialEvent(transaction, {
      eventType: "FINANCIAL_RECONCILIATION_REQUIRED",
      deduplicationKey: `dispute-review:${dispute.id}`,
      aggregateId: dispute.id,
      orderId: dispute.orderId,
      disputeId: dispute.id,
      bookingId: dispute.bookingId,
      payload: { safeCode: decision.safeCode },
      now: input.now,
    });
    return { outcome: "REVIEW", disputeId: dispute.id, safeCode: decision.safeCode };
  }

  await transaction.paymentDispute.update({
    where: { id: dispute.id },
    data: {
      status: decision.status,
      outcome: decision.disputeOutcome,
      closedAt: isTerminalDisputeStatus(decision.status) ? input.now : null,
      safeProviderStatus: input.eventType.slice(0, 80),
      evidenceDueAt: input.evidenceDueAt ?? dispute.evidenceDueAt,
      version: { increment: 1 },
      updatedAt: input.now,
    },
  });
  await appendDisputeEvent(transaction, {
    disputeId: dispute.id,
    providerEventId: input.providerEventId,
    eventType: input.eventType,
    previousStatus: dispute.status,
    newStatus: decision.status,
    effectiveAt: input.occurredAt ?? input.now,
    now: input.now,
  });

  await recordDisputeLedgerAndConsequences(transaction, {
    disputeId: dispute.id,
    status: decision.status,
    orderId: dispute.orderId,
    paymentAttemptId: dispute.paymentAttemptId,
    bookingId: dispute.bookingId,
    amountMinor: dispute.disputedAmountMinor,
    currency: dispute.currency,
    provider: attempt.provider,
    webhookId: input.webhookId,
    providerDisputeId: input.providerDisputeId,
    effectiveAt: input.occurredAt ?? input.now,
    now: input.now,
    correlationId: input.correlationId,
    capturedMinor: attempt.amountMinor,
    refundedMinor: attempt.refundedMinor,
  });

  return { outcome: "APPLIED", disputeId: dispute.id, status: decision.status };
}

async function openDispute(
  transaction: Prisma.TransactionClient,
  context: {
    input: DisputeEventInput;
    attempt: {
      id: string;
      orderId: string;
      provider: string;
      currency: string;
      amountMinor: number;
      refundedMinor: number;
    };
    bookingId: string | null;
  },
): Promise<DisputeProcessingOutcome> {
  const { input, attempt } = context;

  const dispute = await transaction.paymentDispute.create({
    data: {
      publicReference: generatePublicReference(),
      paymentAttemptId: attempt.id,
      orderId: attempt.orderId,
      bookingId: context.bookingId,
      provider: attempt.provider as never,
      providerDisputeId: input.providerDisputeId,
      status: input.status,
      reasonCategory: input.reasonCategory,
      disputedAmountMinor: input.amountMinor,
      currency: input.currency as never,
      openedAt: input.occurredAt ?? input.now,
      evidenceDueAt: input.evidenceDueAt,
      closedAt: isTerminalDisputeStatus(input.status) ? input.now : null,
      outcome:
        input.status === "WON" ? "WON" : input.status === "LOST" ? "LOST" : null,
      safeProviderStatus: input.eventType.slice(0, 80),
      createdAt: input.now,
      updatedAt: input.now,
    },
  });

  await transaction.paymentWebhookEvent.update({
    where: { id: input.webhookId },
    data: { disputeId: dispute.id },
  });
  await appendDisputeEvent(transaction, {
    disputeId: dispute.id,
    providerEventId: input.providerEventId,
    eventType: input.eventType,
    previousStatus: null,
    newStatus: input.status,
    effectiveAt: input.occurredAt ?? input.now,
    now: input.now,
  });

  // An open dispute flags the order for review but changes nothing about
  // admission: the customer may still attend and the platform may still win.
  await transaction.checkoutOrder.update({
    where: { id: attempt.orderId },
    data: { financialReviewState: "DISPUTE_REVIEW", updatedAt: input.now },
  });
  if (context.bookingId) {
    await transaction.booking.update({
      where: { id: context.bookingId },
      data: { financialReviewState: "DISPUTE_REVIEW" },
    });
  }

  await recordDisputeLedgerAndConsequences(transaction, {
    disputeId: dispute.id,
    status: input.status,
    orderId: attempt.orderId,
    paymentAttemptId: attempt.id,
    bookingId: context.bookingId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    provider: attempt.provider,
    webhookId: input.webhookId,
    providerDisputeId: input.providerDisputeId,
    effectiveAt: input.occurredAt ?? input.now,
    now: input.now,
    correlationId: input.correlationId,
    capturedMinor: attempt.amountMinor,
    refundedMinor: attempt.refundedMinor,
  });

  return { outcome: "OPENED", disputeId: dispute.id };
}

async function appendDisputeEvent(
  transaction: Prisma.TransactionClient,
  input: {
    disputeId: string;
    providerEventId: string;
    eventType: string;
    previousStatus: DisputeStatus | null;
    newStatus: DisputeStatus;
    effectiveAt: Date;
    now: Date;
    safeMetadata?: Prisma.InputJsonValue;
  },
) {
  // Append-only, and unique on (disputeId, providerEventId), so a duplicate
  // delivery cannot lengthen the history.
  await transaction.paymentDisputeEvent.createMany({
    data: [
      {
        disputeId: input.disputeId,
        providerEventId: input.providerEventId,
        eventType: input.eventType.slice(0, 120),
        previousStatus: input.previousStatus,
        newStatus: input.newStatus,
        effectiveAt: input.effectiveAt,
        createdAt: input.now,
        safeMetadata: input.safeMetadata,
      },
    ],
    skipDuplicates: true,
  });
}

/**
 * Ledger entries and downstream consequences of a dispute status.
 *
 * A lost dispute is where money actually leaves, so it writes both the outcome
 * entry and a chargeback entry, revokes unused tickets, and never issues a
 * second refund for the same amount.
 */
async function recordDisputeLedgerAndConsequences(
  transaction: Prisma.TransactionClient,
  input: {
    disputeId: string;
    status: DisputeStatus;
    orderId: string;
    paymentAttemptId: string;
    bookingId: string | null;
    amountMinor: number;
    currency: string;
    provider: string;
    webhookId: string;
    providerDisputeId: string;
    effectiveAt: Date;
    now: Date;
    correlationId?: string | null;
    capturedMinor: number;
    refundedMinor: number;
  },
) {
  const entryType = LEDGER_TYPE_BY_STATUS[input.status];
  if (entryType) {
    await appendLedgerEntry(transaction, {
      entryType,
      amountMinor: input.amountMinor,
      currency: input.currency as never,
      orderId: input.orderId,
      paymentAttemptId: input.paymentAttemptId,
      bookingId: input.bookingId,
      disputeId: input.disputeId,
      provider: input.provider as never,
      causeKey: input.webhookId,
      providerReference: input.providerDisputeId,
      effectiveAt: input.effectiveAt,
      correlationId: input.correlationId ?? null,
    });
  }

  // A customer who was already refunded and then also wins a chargeback would
  // be compensated twice. This never auto-resolves; it raises the order.
  const overlap = detectRefundDisputeOverlap({
    succeededRefundMinor: input.refundedMinor,
    disputedAmountMinor: input.amountMinor,
    capturedMinor: input.capturedMinor,
  });
  if (overlap.overlapping) {
    await transaction.checkoutOrder.update({
      where: { id: input.orderId },
      data: {
        financialReviewState: overlap.exceedsCaptured ? "CHARGEBACK_REVIEW" : "DISPUTE_REVIEW",
        updatedAt: input.now,
      },
    });
    await enqueueFinancialEvent(transaction, {
      eventType: "FINANCIAL_RECONCILIATION_REQUIRED",
      deduplicationKey: `refund-dispute-overlap:${input.disputeId}`,
      aggregateId: input.disputeId,
      orderId: input.orderId,
      disputeId: input.disputeId,
      bookingId: input.bookingId,
      payload: {
        reason: "REFUND_DISPUTE_OVERLAP",
        exceedsCaptured: overlap.exceedsCaptured,
        combinedMinor: overlap.combinedMinor,
      },
      now: input.now,
    });
  }

  if (input.status === "LOST") {
    await appendLedgerEntry(transaction, {
      entryType: "CHARGEBACK_RECORDED",
      amountMinor: input.amountMinor,
      currency: input.currency as never,
      orderId: input.orderId,
      paymentAttemptId: input.paymentAttemptId,
      bookingId: input.bookingId,
      disputeId: input.disputeId,
      provider: input.provider as never,
      causeKey: `${input.webhookId}:chargeback`,
      providerReference: input.providerDisputeId,
      effectiveAt: input.effectiveAt,
      correlationId: input.correlationId ?? null,
    });
    await transaction.checkoutOrder.update({
      where: { id: input.orderId },
      data: { financialReviewState: "CHARGEBACK_REVIEW", updatedAt: input.now },
    });
    if (input.bookingId) {
      await revokeUnusedTicketsForLostDispute(transaction, {
        bookingId: input.bookingId,
        now: input.now,
      });
    }
    await enqueueFinancialEvent(transaction, {
      eventType: "CHARGEBACK_RECORDED",
      deduplicationKey: `chargeback:${input.disputeId}`,
      aggregateId: input.disputeId,
      orderId: input.orderId,
      disputeId: input.disputeId,
      bookingId: input.bookingId,
      payload: { amountMinor: input.amountMinor, currency: input.currency },
      now: input.now,
    });
  }

  const outboxType =
    input.status === "WON"
      ? "DISPUTE_WON"
      : input.status === "LOST"
        ? "DISPUTE_LOST"
        : input.status === "OPEN"
          ? "DISPUTE_OPENED"
          : "DISPUTE_UPDATED";
  await enqueueFinancialEvent(transaction, {
    eventType: outboxType,
    deduplicationKey: `dispute-${outboxType.toLowerCase()}:${input.disputeId}:${input.webhookId}`,
    aggregateId: input.disputeId,
    orderId: input.orderId,
    disputeId: input.disputeId,
    bookingId: input.bookingId,
    payload: { status: input.status, amountMinor: input.amountMinor, currency: input.currency },
    now: input.now,
  });
}

/**
 * A lost dispute revokes admission that has not been used. A ticket already
 * scanned stays USED with its redemption history intact: the event happened,
 * and the books do not get to rewrite it.
 */
async function revokeUnusedTicketsForLostDispute(
  transaction: Prisma.TransactionClient,
  input: { bookingId: string; now: Date },
) {
  const tickets = await transaction.ticket.findMany({
    where: { bookingId: input.bookingId },
    select: { id: true, status: true },
  });

  let revoked = 0;
  for (const ticket of tickets) {
    const decision = decideDisputeTicketConsequence({
      disputeStatus: "LOST",
      ticketStatus: ticket.status,
    });
    if (decision.action !== "REVOKE") continue;

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
  return revoked;
}
