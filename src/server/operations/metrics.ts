import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { evaluateWorkerFleet } from "@/server/operations/worker-heartbeat";
import { getMetricsRegistry } from "@/server/observability/metrics-registry";

/**
 * Safe aggregate operational metrics.
 *
 * Every value here is a count, an age, or a duration. Nothing is keyed by user,
 * ticket, booking reference, event slug, session, email, or address, so the
 * output can be scraped into a metrics system without becoming a personal-data
 * store or an unbounded label explosion.
 *
 * PostgreSQL is queried directly because it is authoritative. These numbers stay
 * correct across a deployment and across a Redis outage.
 */

/** Duration statistics are windowed so the query cost stays bounded. */
const DELIVERY_WINDOW_HOURS = 24;

function ageSeconds(now: Date, value: Date | null | undefined) {
  if (!value) return 0;
  return Math.max(0, Math.floor((now.getTime() - value.getTime()) / 1_000));
}

export interface OperationalMetrics {
  collectedAt: string;
  inventory: {
    outboxPending: number;
    outboxDeadLetters: number;
    oldestPendingAgeSeconds: number;
    holdConflictCount: string;
    transactionRetryCount: string;
    dispatcherFailureCount: string;
    lastDispatcherDurationMs: number | null;
    overdueHolds: number;
    expiryLagSeconds: number;
  };
  payments: {
    pendingOrders: number;
    paidUnfulfilled: number;
    requiresReview: number;
    webhooksFailed: number;
    webhooksVerifiedUnprocessed: number;
    bookingFulfillmentFailures: number;
    confirmedBookings: number;
  };
  tickets: {
    issuancePending: number;
    issuanceDeadLetters: number;
    missingTickets: number;
    missingCredentials: number;
    activeTickets: number;
  };
  notifications: {
    pending: number;
    deadLetters: number;
    oldestPendingAgeSeconds: number;
    deliveryDurationMs: { averageMs: number | null; maximumMs: number | null; sampleCount: number };
  };
  validation: {
    outcomes: Record<string, number>;
    duplicateScanAttempts: number;
    unauthorizedScannerAttempts: number;
  };
  /**
   * Phase 5C2A financial metrics. Every label is a status, an entry type, or a
   * currency code — all closed sets. Refund references, order ids, booking
   * references, user ids, emails, provider identifiers, and IP addresses are
   * deliberately absent: any of them as a label would make the series unbounded
   * and turn an operational dashboard into a customer-data export.
   */
  financials: {
    refunds: {
      byStatus: Record<string, number>;
      requestedTotal: number;
      reconciliationBacklog: number;
      oldestPendingAgeSeconds: number;
      providerFailures: number;
      providerTimeouts: number;
    };
    /** Keyed by ISO currency code, a closed set of four. */
    refundedAmountMinorByCurrency: Record<string, number>;
    disputes: {
      byStatus: Record<string, number>;
      openTotal: number;
      lostTotal: number;
      evidenceDueSoon: number;
      disputedAmountMinorByCurrency: Record<string, number>;
    };
    ledger: {
      entryCountByType: Record<string, number>;
      divergenceCount: number;
    };
    webhooks: {
      refundEventsUnprocessed: number;
      disputeEventsUnprocessed: number;
      verificationFailures: number;
    };
    ticketRevocationBacklog: number;
  };
  workers: Array<{
    workerType: string;
    role: string;
    label: string;
    ageSeconds: number | null;
    instanceCount: number;
    version: string | null;
  }>;
  process: ReturnType<ReturnType<typeof getMetricsRegistry>["snapshot"]>;
}

/**
 * Financial aggregates, grouped so the label sets stay closed. Collected
 * separately from the main batch to keep each query independently bounded.
 */
async function collectFinancialMetrics(
  database: PrismaClient,
  now: Date,
): Promise<OperationalMetrics["financials"]> {
  const evidenceSoon = new Date(now.getTime() + 48 * 3_600_000);

  const [
    refundsByStatus,
    oldestPendingRefund,
    refundAttemptFailures,
    refundAttemptTimeouts,
    refundedByCurrency,
    disputesByStatus,
    disputedByCurrency,
    evidenceDueSoon,
    ledgerByType,
    refundEventsUnprocessed,
    disputeEventsUnprocessed,
    revocationBacklog,
  ] = await Promise.all([
    database.refund.groupBy({ by: ["status"], _count: { _all: true } }),
    database.refund.findFirst({
      where: { status: { in: ["REQUESTED", "SUBMITTING", "PROCESSING"] } },
      orderBy: { requestedAt: "asc" },
      select: { requestedAt: true },
    }),
    database.refundAttempt.count({ where: { status: "FAILED" } }),
    database.refundAttempt.count({ where: { status: "TIMEOUT" } }),
    database.refund.groupBy({
      by: ["currency"],
      where: { succeededAt: { not: null } },
      _sum: { requestedAmountMinor: true },
    }),
    database.paymentDispute.groupBy({ by: ["status"], _count: { _all: true } }),
    database.paymentDispute.groupBy({
      by: ["currency"],
      where: { status: { notIn: ["WON"] } },
      _sum: { disputedAmountMinor: true },
    }),
    database.paymentDispute.count({
      where: {
        status: { in: ["OPEN", "NEEDS_RESPONSE", "UNDER_REVIEW"] },
        evidenceDueAt: { not: null, lte: evidenceSoon },
      },
    }),
    database.financialLedgerEntry.groupBy({ by: ["entryType"], _count: { _all: true } }),
    database.paymentWebhookEvent.count({
      where: { eventCategory: "REFUND", processingStatus: { in: ["RECEIVED", "FAILED"] } },
    }),
    database.paymentWebhookEvent.count({
      where: { eventCategory: "DISPUTE", processingStatus: { in: ["RECEIVED", "FAILED"] } },
    }),
    database.ticket.count({ where: { status: "ACTIVE", booking: { status: "REFUNDED" } } }),
  ]);

  const refundStatusCounts: Record<string, number> = {};
  let requestedTotal = 0;
  for (const row of refundsByStatus) {
    refundStatusCounts[row.status] = row._count._all;
    requestedTotal += row._count._all;
  }

  const disputeStatusCounts: Record<string, number> = {};
  for (const row of disputesByStatus) {
    disputeStatusCounts[row.status] = row._count._all;
  }

  const ledgerCounts: Record<string, number> = {};
  for (const row of ledgerByType) {
    ledgerCounts[row.entryType] = row._count._all;
  }

  const refundedAmounts: Record<string, number> = {};
  for (const row of refundedByCurrency) {
    refundedAmounts[row.currency] = row._sum.requestedAmountMinor ?? 0;
  }

  const disputedAmounts: Record<string, number> = {};
  for (const row of disputedByCurrency) {
    disputedAmounts[row.currency] = row._sum.disputedAmountMinor ?? 0;
  }

  const reconciliationBacklog =
    (refundStatusCounts.REQUIRES_REVIEW ?? 0) +
    (refundStatusCounts.SUBMITTING ?? 0) +
    (refundStatusCounts.PROCESSING ?? 0);

  return {
    refunds: {
      byStatus: refundStatusCounts,
      requestedTotal,
      reconciliationBacklog,
      oldestPendingAgeSeconds: ageSeconds(now, oldestPendingRefund?.requestedAt),
      providerFailures: refundAttemptFailures,
      providerTimeouts: refundAttemptTimeouts,
    },
    refundedAmountMinorByCurrency: refundedAmounts,
    disputes: {
      byStatus: disputeStatusCounts,
      openTotal:
        (disputeStatusCounts.OPEN ?? 0) +
        (disputeStatusCounts.NEEDS_RESPONSE ?? 0) +
        (disputeStatusCounts.UNDER_REVIEW ?? 0),
      lostTotal: disputeStatusCounts.LOST ?? 0,
      evidenceDueSoon,
      disputedAmountMinorByCurrency: disputedAmounts,
    },
    ledger: {
      entryCountByType: ledgerCounts,
      divergenceCount: disputeStatusCounts.REQUIRES_REVIEW ?? 0,
    },
    webhooks: {
      refundEventsUnprocessed,
      disputeEventsUnprocessed,
      // Invalid signatures are never stored, so this counts stored envelopes
      // that failed processing rather than failed verification attempts.
      verificationFailures: refundEventsUnprocessed + disputeEventsUnprocessed,
    },
    ticketRevocationBacklog: revocationBacklog,
  };
}

export async function collectOperationalMetrics(
  database: PrismaClient,
  input: { staleAfterSeconds: number; now?: Date },
): Promise<OperationalMetrics> {
  const now = input.now ?? new Date();
  const deliveryWindowStart = new Date(now.getTime() - DELIVERY_WINDOW_HOURS * 3_600_000);

  const [
    outboxPending,
    outboxDeadLetters,
    oldestOutbox,
    inventoryMetric,
    overdueHolds,
    oldestOverdueHold,
    pendingOrders,
    paidUnfulfilled,
    requiresReview,
    webhooksFailed,
    webhooksVerifiedUnprocessed,
    confirmedBookings,
    issuancePending,
    issuanceDeadLetters,
    missingTickets,
    missingCredentials,
    activeTickets,
    notificationsPending,
    notificationsDeadLettered,
    oldestNotification,
    redemptionOutcomes,
    deliveryDurations,
    workers,
  ] = await Promise.all([
    database.inventoryEventOutbox.count({ where: { processedAt: null, deadLetterAt: null } }),
    database.inventoryEventOutbox.count({ where: { deadLetterAt: { not: null } } }),
    database.inventoryEventOutbox.findFirst({
      where: { processedAt: null, deadLetterAt: null },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    database.inventoryOperationsMetric.findUnique({ where: { id: "inventory" } }),
    database.seatHold.count({ where: { status: "ACTIVE", expiresAt: { lte: now } } }),
    database.seatHold.findFirst({
      where: { status: "ACTIVE", expiresAt: { lte: now } },
      orderBy: { expiresAt: "asc" },
      select: { expiresAt: true },
    }),
    database.checkoutOrder.count({ where: { status: { in: ["PENDING", "PAYMENT_PENDING"] } } }),
    database.checkoutOrder.count({ where: { status: "PAID_UNFULFILLED" } }),
    database.checkoutOrder.count({ where: { status: "REQUIRES_REVIEW" } }),
    database.paymentWebhookEvent.count({ where: { processingStatus: "FAILED" } }),
    database.paymentWebhookEvent.count({
      where: { signatureStatus: "VERIFIED", processingStatus: { in: ["RECEIVED", "REQUIRES_REVIEW"] } },
    }),
    database.booking.count({ where: { status: "CONFIRMED" } }),
    database.ticketIssuanceRequest.count({ where: { status: "PENDING" } }),
    database.ticketIssuanceRequest.count({ where: { status: "DEAD_LETTER" } }),
    database.bookingSeat.count({ where: { ticket: null, booking: { status: "CONFIRMED" } } }),
    database.ticket.count({
      where: { status: "ACTIVE", credentials: { none: { status: "ACTIVE" } } },
    }),
    database.ticket.count({ where: { status: "ACTIVE" } }),
    database.notificationOutbox.count({ where: { status: "PENDING" } }),
    database.notificationOutbox.count({ where: { status: "DEAD_LETTER" } }),
    database.notificationOutbox.findFirst({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    database.ticketRedemptionEvent.groupBy({ by: ["outcome"], _count: { _all: true } }),
    database.$queryRaw<Array<{ average: number | null; maximum: number | null; samples: bigint }>>(
      Prisma.sql`
        SELECT
          AVG(EXTRACT(EPOCH FROM ("completedAt" - "startedAt")) * 1000)::float8 AS "average",
          MAX(EXTRACT(EPOCH FROM ("completedAt" - "startedAt")) * 1000)::float8 AS "maximum",
          COUNT(*)::bigint AS "samples"
        FROM "NotificationDeliveryAttempt"
        WHERE "completedAt" IS NOT NULL
          AND "startedAt" >= ${deliveryWindowStart}
      `,
    ),
    evaluateWorkerFleet(database, { staleAfterSeconds: input.staleAfterSeconds, now }),
  ]);

  const outcomes: Record<string, number> = {};
  for (const row of redemptionOutcomes) {
    outcomes[row.outcome] = row._count._all;
  }

  const duration = deliveryDurations[0];
  const financials = await collectFinancialMetrics(database, now);

  return {
    collectedAt: now.toISOString(),
    financials,
    inventory: {
      outboxPending,
      outboxDeadLetters,
      oldestPendingAgeSeconds: ageSeconds(now, oldestOutbox?.createdAt),
      holdConflictCount: (inventoryMetric?.holdConflictCount ?? BigInt(0)).toString(),
      transactionRetryCount: (inventoryMetric?.transactionRetryCount ?? BigInt(0)).toString(),
      dispatcherFailureCount: (inventoryMetric?.dispatcherFailureCount ?? BigInt(0)).toString(),
      lastDispatcherDurationMs: inventoryMetric?.lastDispatcherDurationMs ?? null,
      overdueHolds,
      expiryLagSeconds: ageSeconds(now, oldestOverdueHold?.expiresAt),
    },
    payments: {
      pendingOrders,
      paidUnfulfilled,
      requiresReview,
      webhooksFailed,
      webhooksVerifiedUnprocessed,
      // A verified payment that produced no booking is the fulfillment failure
      // signal that must never be allowed to sit unnoticed.
      bookingFulfillmentFailures: paidUnfulfilled + requiresReview,
      confirmedBookings,
    },
    tickets: {
      issuancePending,
      issuanceDeadLetters,
      missingTickets,
      missingCredentials,
      activeTickets,
    },
    notifications: {
      pending: notificationsPending,
      deadLetters: notificationsDeadLettered,
      oldestPendingAgeSeconds: ageSeconds(now, oldestNotification?.createdAt),
      deliveryDurationMs: {
        averageMs: duration?.average != null ? Math.round(duration.average) : null,
        maximumMs: duration?.maximum != null ? Math.round(duration.maximum) : null,
        sampleCount: Number(duration?.samples ?? 0),
      },
    },
    validation: {
      outcomes,
      duplicateScanAttempts: outcomes.ALREADY_USED ?? 0,
      unauthorizedScannerAttempts: outcomes.UNAUTHORIZED_SCANNER ?? 0,
    },
    workers: workers.map((worker) => ({
      workerType: worker.workerType,
      role: worker.role,
      label: worker.label,
      ageSeconds: worker.ageSeconds,
      instanceCount: worker.instanceCount,
      version: worker.version,
    })),
    process: getMetricsRegistry().snapshot(),
  };
}
