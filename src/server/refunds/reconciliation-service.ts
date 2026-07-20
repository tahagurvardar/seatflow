import { detectRefundDisputeOverlap } from "@/features/disputes/lifecycle";
import { detectLedgerDivergence } from "@/features/ledger/entries";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { runInTransaction } from "@/server/database/run-in-transaction";
import { enqueueFinancialEvent, readLedgerForPayment } from "@/server/payments/ledger-service";
import type { PaymentProvider } from "@/server/payments/payment-provider";
import { processVerifiedWebhookRecord } from "@/server/payments/webhook-service";

/**
 * Financial reconciliation.
 *
 * Everything here is idempotent and read-mostly. There is deliberately **no**
 * function in this module that marks a refund succeeded, closes a dispute, or
 * creates one: a command that could do that would be a way to move money
 * without a provider ever confirming it, which is exactly the authority this
 * phase keeps with verified webhooks.
 *
 * What reconciliation may do is narrow: adopt an external refund the provider
 * already created under our own precommitted key, re-run webhook records that
 * were verified but never processed, and report divergence for a human.
 */

export interface RefundBacklogReport {
  requested: number;
  submitting: number;
  processing: number;
  requiresReview: number;
  failed: number;
  oldestPendingAgeSeconds: number | null;
}

export async function reportRefundBacklog(
  database: PrismaClient,
  now = new Date(),
): Promise<RefundBacklogReport> {
  const [requested, submitting, processing, requiresReview, failed, oldest] = await Promise.all([
    database.refund.count({ where: { status: "REQUESTED" } }),
    database.refund.count({ where: { status: "SUBMITTING" } }),
    database.refund.count({ where: { status: "PROCESSING" } }),
    database.refund.count({ where: { status: "REQUIRES_REVIEW" } }),
    database.refund.count({ where: { status: "FAILED" } }),
    database.refund.findFirst({
      where: { status: { in: ["REQUESTED", "SUBMITTING", "PROCESSING"] } },
      orderBy: { requestedAt: "asc" },
      select: { requestedAt: true },
    }),
  ]);
  return {
    requested,
    submitting,
    processing,
    requiresReview,
    failed,
    oldestPendingAgeSeconds: oldest
      ? Math.max(0, Math.floor((now.getTime() - oldest.requestedAt.getTime()) / 1_000))
      : null,
  };
}

export interface DisputeBacklogReport {
  open: number;
  needsResponse: number;
  underReview: number;
  lost: number;
  requiresReview: number;
  evidenceDueWithin48Hours: number;
}

export async function reportDisputeBacklog(
  database: PrismaClient,
  now = new Date(),
): Promise<DisputeBacklogReport> {
  const soon = new Date(now.getTime() + 48 * 60 * 60 * 1_000);
  const [open, needsResponse, underReview, lost, requiresReview, evidenceDue] = await Promise.all([
    database.paymentDispute.count({ where: { status: "OPEN" } }),
    database.paymentDispute.count({ where: { status: "NEEDS_RESPONSE" } }),
    database.paymentDispute.count({ where: { status: "UNDER_REVIEW" } }),
    database.paymentDispute.count({ where: { status: "LOST" } }),
    database.paymentDispute.count({ where: { status: "REQUIRES_REVIEW" } }),
    database.paymentDispute.count({
      where: {
        status: { in: ["OPEN", "NEEDS_RESPONSE", "UNDER_REVIEW"] },
        evidenceDueAt: { not: null, lte: soon },
      },
    }),
  ]);
  return { open, needsResponse, underReview, lost, requiresReview, evidenceDueWithin48Hours: evidenceDue };
}

/**
 * Resolve refunds whose external outcome is unknown, by asking the provider
 * what exists under the idempotency key we committed before calling it.
 *
 * This can only ever *adopt* an external refund identifier. It never invents a
 * settlement: a refund found at the provider is recorded as PROCESSING and
 * still waits for a verified webhook to settle.
 */
export async function reconcileAmbiguousRefunds(
  database: PrismaClient,
  provider: PaymentProvider,
  options: { batchSize?: number; now?: Date } = {},
) {
  const now = options.now ?? new Date();
  const candidates = await database.refund.findMany({
    where: {
      provider: provider.name,
      status: { in: ["SUBMITTING", "PROCESSING"] },
      providerRefundId: null,
    },
    orderBy: { requestedAt: "asc" },
    take: options.batchSize ?? 50,
    select: {
      id: true,
      providerIdempotencyKey: true,
      requestedAmountMinor: true,
      paymentAttempt: { select: { providerIntentId: true } },
    },
  });

  const result = { inspected: 0, adopted: 0, stillUnknown: 0, failed: 0 };
  for (const refund of candidates) {
    const providerIntentId = refund.paymentAttempt.providerIntentId;
    if (!providerIntentId) continue;
    result.inspected += 1;

    let providerRefunds;
    try {
      providerRefunds = await provider.listRefundsForPayment({ providerIntentId });
    } catch {
      result.failed += 1;
      continue;
    }

    // Match on amount: the provider-side refund we created under our key is the
    // one for exactly this amount that is not already adopted locally.
    const alreadyAdopted = await database.refund
      .findMany({
        where: { providerRefundId: { not: null }, paymentAttemptId: { not: undefined } },
        select: { providerRefundId: true },
      })
      .then((rows) => new Set(rows.map((row) => row.providerRefundId)));
    const candidate = providerRefunds.find(
      (entry) =>
        entry.amountMinor === refund.requestedAmountMinor &&
        !alreadyAdopted.has(entry.providerRefundId),
    );
    if (!candidate) {
      result.stillUnknown += 1;
      continue;
    }

    await runInTransaction(database, async (transaction) => {
      // Adopt the external identity only. Settlement still requires a webhook.
      await transaction.refund.updateMany({
        where: { id: refund.id, providerRefundId: null },
        data: {
          providerRefundId: candidate.providerRefundId,
          status: "PROCESSING",
          version: { increment: 1 },
          updatedAt: now,
        },
      });
    });
    result.adopted += 1;
  }
  return result;
}

/**
 * Re-run webhook records that were verified and stored but never reached a
 * terminal processing state, which is what a crash between storing and
 * processing leaves behind.
 */
export async function reconcileUnprocessedWebhooks(
  database: PrismaClient,
  options: { batchSize?: number; olderThanSeconds?: number; now?: Date } = {},
) {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.olderThanSeconds ?? 60) * 1_000);
  const stuck = await database.paymentWebhookEvent.findMany({
    where: {
      signatureStatus: "VERIFIED",
      processingStatus: { in: ["RECEIVED", "FAILED"] },
      receivedAt: { lte: cutoff },
    },
    orderBy: { receivedAt: "asc" },
    take: options.batchSize ?? 50,
    select: { id: true, eventCategory: true },
  });

  const result = { inspected: stuck.length, reprocessed: 0, failed: 0 };
  for (const webhook of stuck) {
    // Only the payment path is replayable from here; refund and dispute
    // records are replayed by their own verified-event path.
    if (webhook.eventCategory !== "PAYMENT") continue;
    try {
      await processVerifiedWebhookRecord(database, webhook.id, { now });
      result.reprocessed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

export interface DivergenceFinding {
  orderId: string;
  paymentAttemptId: string;
  reason:
    | "LEDGER_DISAGREES_WITH_AGGREGATE"
    | "OVER_REFUND_RISK"
    | "REFUND_DISPUTE_OVERLAP"
    | "REFUNDED_BOOKING_NOT_TERMINAL";
  expectedMinor?: number;
  actualMinor?: number;
}

/**
 * Compare the append-only ledger against the stored aggregates and flag any
 * disagreement.
 *
 * Nothing is corrected here. The ledger cannot be rewritten and the aggregates
 * are trigger-maintained, so a divergence means something needs a human, not a
 * repair script.
 */
export async function detectFinancialDivergence(
  database: PrismaClient,
  options: { batchSize?: number } = {},
): Promise<DivergenceFinding[]> {
  const attempts = await database.paymentAttempt.findMany({
    where: { status: "SUCCEEDED" },
    orderBy: { updatedAt: "desc" },
    take: options.batchSize ?? 200,
    select: {
      id: true,
      orderId: true,
      amountMinor: true,
      refundedMinor: true,
      inFlightRefundMinor: true,
    },
  });

  const findings: DivergenceFinding[] = [];
  for (const attempt of attempts) {
    const entries = await readLedgerForPayment(database, attempt.id);
    const [refundCount, disputeCount] = await Promise.all([
      database.refund.count({ where: { paymentAttemptId: attempt.id } }),
      database.paymentDispute.count({ where: { paymentAttemptId: attempt.id } }),
    ]);
    // Payments captured before Phase 5C2A have no ledger entries, because the
    // ledger did not exist yet. Those are out of scope rather than divergent;
    // counting them would flag every historical payment forever, and writing
    // entries for them now would be inventing financial records after the fact.
    // A payment with refund or dispute activity is different: that activity
    // must have written entries, so their absence is a real divergence.
    const ledgerCoversPayment = entries.length > 0 || refundCount > 0 || disputeCount > 0;

    const divergence = detectLedgerDivergence({
      capturedMinor: attempt.amountMinor,
      refundedMinor: attempt.refundedMinor,
      entries,
    });
    if (ledgerCoversPayment && divergence.diverged) {
      findings.push({
        orderId: attempt.orderId,
        paymentAttemptId: attempt.id,
        reason: "LEDGER_DISAGREES_WITH_AGGREGATE",
        expectedMinor: divergence.expectedMinor,
        actualMinor: divergence.actualMinor,
      });
    }

    if (attempt.refundedMinor + attempt.inFlightRefundMinor > attempt.amountMinor) {
      findings.push({
        orderId: attempt.orderId,
        paymentAttemptId: attempt.id,
        reason: "OVER_REFUND_RISK",
        expectedMinor: attempt.amountMinor,
        actualMinor: attempt.refundedMinor + attempt.inFlightRefundMinor,
      });
    }

    const disputed = await database.paymentDispute.aggregate({
      where: { paymentAttemptId: attempt.id, status: { notIn: ["WON"] } },
      _sum: { disputedAmountMinor: true },
    });
    const overlap = detectRefundDisputeOverlap({
      succeededRefundMinor: attempt.refundedMinor,
      disputedAmountMinor: disputed._sum.disputedAmountMinor ?? 0,
      capturedMinor: attempt.amountMinor,
    });
    if (overlap.overlapping) {
      findings.push({
        orderId: attempt.orderId,
        paymentAttemptId: attempt.id,
        reason: "REFUND_DISPUTE_OVERLAP",
        actualMinor: overlap.combinedMinor,
      });
    }
  }
  return findings;
}

/**
 * Bookings that are fully refunded but still hold an active ticket, which is
 * the backlog a failed revocation leaves behind.
 */
export async function detectTicketRevocationBacklog(database: PrismaClient) {
  const rows = await database.$queryRaw<
    Array<{ bookingId: string; activeTickets: bigint }>
  >(Prisma.sql`
    SELECT booking."id" AS "bookingId", count(ticket."id") AS "activeTickets"
    FROM "Booking" booking
    JOIN "Ticket" ticket ON ticket."bookingId" = booking."id"
    WHERE booking."status" = 'REFUNDED' AND ticket."status" = 'ACTIVE'
    GROUP BY booking."id"
  `);
  return rows.map((row) => ({
    bookingId: row.bookingId,
    activeTickets: Number(row.activeTickets),
  }));
}

/**
 * Raise every current divergence as a reconciliation event. The deduplication
 * key is stable per payment and reason, so repeated runs do not create noise.
 */
export async function raiseDivergenceForReview(
  database: PrismaClient,
  findings: readonly DivergenceFinding[],
  now = new Date(),
) {
  let raised = 0;
  for (const finding of findings) {
    const created = await runInTransaction(database, async (transaction) =>
      enqueueFinancialEvent(transaction, {
        eventType: "FINANCIAL_RECONCILIATION_REQUIRED",
        deduplicationKey: `divergence:${finding.paymentAttemptId}:${finding.reason}`,
        aggregateId: finding.paymentAttemptId,
        orderId: finding.orderId,
        payload: {
          reason: finding.reason,
          expectedMinor: finding.expectedMinor ?? null,
          actualMinor: finding.actualMinor ?? null,
        },
        now,
      }),
    );
    if (created) raised += 1;
  }
  return raised;
}

/**
 * Make eligible notification failures retryable again. Dead-lettered rows are
 * deliberately left alone: they failed permanently and need a human.
 */
export async function retrySafeNotificationFailures(
  database: PrismaClient,
  options: { now?: Date; limit?: number } = {},
) {
  const now = options.now ?? new Date();
  const candidates = await database.notificationOutbox.findMany({
    where: { status: "PENDING", availableAt: { gt: now } },
    orderBy: { createdAt: "asc" },
    take: options.limit ?? 100,
    select: { id: true },
  });
  if (candidates.length === 0) return 0;
  const updated = await database.notificationOutbox.updateMany({
    where: { id: { in: candidates.map((row) => row.id) } },
    data: { availableAt: now, updatedAt: now },
  });
  return updated.count;
}
