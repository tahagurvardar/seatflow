import { detectLedgerDivergence } from "@/features/ledger/entries";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";

/**
 * Live financial probes for readiness and `production:check`.
 *
 * Three properties matter more than speed:
 *
 *  - **Read-only.** Nothing here writes. This command is routinely pointed at a
 *    production database, and a preflight that mutates financial state would be
 *    worse than no preflight.
 *  - **Bounded.** Every query is either an indexed count or a capped scan, so a
 *    preflight cannot become the thing that takes the database down.
 *  - **Never silently zero.** A probe that fails returns an explicit failure
 *    rather than a comforting 0. Reporting "no backlog" because the query threw
 *    is how a broken check becomes a green light.
 *
 * PostgreSQL is the only source consulted. Redis is never financial authority.
 */

export interface FinancialProbeThresholds {
  /** How long a refund may sit unsettled before it counts as backlog. */
  refundStaleAfterSeconds: number;
  /** Cap on rows examined by the divergence scan. */
  divergenceScanLimit: number;
}

export const DEFAULT_FINANCIAL_PROBE_THRESHOLDS: FinancialProbeThresholds = {
  refundStaleAfterSeconds: 900,
  divergenceScanLimit: 500,
};

export interface FinancialProbeResult {
  refundReconciliationBacklog: number | null;
  unresolvedChargebacks: number | null;
  financialDivergences: number | null;
  ticketRevocationBacklog: number | null;
  /** Names of probes that could not be evaluated. Empty means all succeeded. */
  failures: string[];
}

/**
 * Refunds that have left the customer's hands but have not reached a terminal
 * result within the configured window. A refund still moving normally is not
 * backlog; one stuck in SUBMITTING or PROCESSING past the window is.
 */
async function probeRefundBacklog(
  database: PrismaClient,
  thresholds: FinancialProbeThresholds,
  now: Date,
) {
  const staleBefore = new Date(now.getTime() - thresholds.refundStaleAfterSeconds * 1_000);
  return database.refund.count({
    where: {
      OR: [
        // Stuck mid-flight past the window.
        {
          status: { in: ["SUBMITTING", "PROCESSING"] },
          requestedAt: { lte: staleBefore },
        },
        // Anything awaiting a human counts immediately: it is already known to
        // need attention, so waiting out a window would only delay the signal.
        { status: "REQUIRES_REVIEW" },
      ],
    },
  });
}

/**
 * Disputes the platform has lost, or that need a human, and whose order is
 * still flagged for financial review. A lost dispute whose review has been
 * cleared is resolved; one still flagged is not.
 */
async function probeUnresolvedChargebacks(database: PrismaClient) {
  return database.paymentDispute.count({
    where: {
      status: { in: ["LOST", "REQUIRES_REVIEW"] },
      order: { financialReviewState: { in: ["CHARGEBACK_REVIEW", "DISPUTE_REVIEW"] } },
    },
  });
}

/**
 * Payments whose append-only ledger disagrees with their stored aggregates.
 *
 * The scan is capped and ordered by recency: divergence is overwhelmingly a
 * recent-write problem, and an unbounded scan of every payment ever taken would
 * make this probe unusable on a large database.
 *
 * Payments taken before Phase 5C2A have no ledger entries at all, because the
 * ledger did not exist when they were captured. Those are out of scope rather
 * than divergent — counting them would permanently block every deployment for a
 * historical reason, and backfilling entries for them would mean inventing
 * financial records after the fact.
 *
 * A payment with any refund or dispute activity is a different matter: that
 * activity must have written entries, so their absence is a genuine divergence
 * and is still reported.
 */
async function probeFinancialDivergence(
  database: PrismaClient,
  thresholds: FinancialProbeThresholds,
) {
  const rows = await database.$queryRaw<
    Array<{
      capturedMinor: number;
      refundedMinor: number;
      settledMinor: number | null;
      entryCount: bigint;
      activityCount: bigint;
    }>
  >(Prisma.sql`
    SELECT
      attempt."amountMinor"   AS "capturedMinor",
      attempt."refundedMinor" AS "refundedMinor",
      COALESCE(SUM(
        CASE
          WHEN entry."entryType" IN ('PAYMENT_CAPTURED', 'DISPUTE_WON') THEN entry."amountMinor"
          WHEN entry."entryType" IN ('REFUND_SUCCEEDED', 'DISPUTE_LOST', 'CHARGEBACK_RECORDED')
            THEN -entry."amountMinor"
          ELSE 0
        END
      ), 0)::int AS "settledMinor",
      count(entry."id") AS "entryCount",
      attempt."activityCount" AS "activityCount"
    FROM (
      SELECT
        "PaymentAttempt"."id",
        "PaymentAttempt"."amountMinor",
        "PaymentAttempt"."refundedMinor",
        (
          (SELECT count(*) FROM "Refund" r WHERE r."paymentAttemptId" = "PaymentAttempt"."id")
          + (SELECT count(*) FROM "PaymentDispute" d WHERE d."paymentAttemptId" = "PaymentAttempt"."id")
        ) AS "activityCount"
      FROM "PaymentAttempt"
      WHERE "status" = 'SUCCEEDED'
      ORDER BY "updatedAt" DESC
      LIMIT ${thresholds.divergenceScanLimit}
    ) attempt
    LEFT JOIN "FinancialLedgerEntry" entry ON entry."paymentAttemptId" = attempt."id"
    GROUP BY
      attempt."id", attempt."amountMinor", attempt."refundedMinor", attempt."activityCount"
  `);

  return rows.filter((row) => {
    const ledgerCoversPayment = Number(row.entryCount) > 0 || Number(row.activityCount) > 0;
    if (!ledgerCoversPayment) return false;

    return detectLedgerDivergence({
      capturedMinor: row.capturedMinor,
      refundedMinor: row.refundedMinor,
      // The SQL already reduced the settling entries to one signed total, so it
      // is presented to the shared rule as a single settled credit.
      entries: [
        {
          entryType: "PAYMENT_CAPTURED",
          direction: "CREDIT",
          amountMinor: row.settledMinor ?? 0,
        },
      ],
    }).diverged;
  }).length;
}

/**
 * Refunded admission that is still valid: an active ticket on a fully refunded
 * booking, or on a booking whose dispute was lost.
 */
async function probeTicketRevocationBacklog(database: PrismaClient) {
  const rows = await database.$queryRaw<Array<{ backlog: bigint }>>(Prisma.sql`
    SELECT count(DISTINCT ticket."id") AS "backlog"
    FROM "Ticket" ticket
    JOIN "Booking" booking ON booking."id" = ticket."bookingId"
    LEFT JOIN "PaymentDispute" dispute
      ON dispute."bookingId" = booking."id" AND dispute."status" = 'LOST'
    WHERE ticket."status" = 'ACTIVE'
      AND (booking."status" = 'REFUNDED' OR dispute."id" IS NOT NULL)
  `);
  return Number(rows[0]?.backlog ?? 0);
}

/**
 * Run every financial probe independently.
 *
 * Each is isolated so one failure does not mask the others, and a failure is
 * recorded by name rather than folded into a zero.
 */
export async function collectFinancialProbes(
  database: PrismaClient,
  input: { thresholds?: Partial<FinancialProbeThresholds>; now?: Date } = {},
): Promise<FinancialProbeResult> {
  const thresholds = { ...DEFAULT_FINANCIAL_PROBE_THRESHOLDS, ...input.thresholds };
  const now = input.now ?? new Date();
  const failures: string[] = [];

  async function run<Result>(name: string, operation: () => Promise<Result>) {
    try {
      return await operation();
    } catch {
      // The reason is deliberately not captured: a driver message can quote
      // schema and connection details, and the caller only needs to know that
      // this probe cannot be trusted.
      failures.push(name);
      return null;
    }
  }

  const [refundReconciliationBacklog, unresolvedChargebacks, financialDivergences, ticketRevocationBacklog] =
    await Promise.all([
      run("refund_backlog", () => probeRefundBacklog(database, thresholds, now)),
      run("unresolved_chargebacks", () => probeUnresolvedChargebacks(database)),
      run("financial_divergence", () => probeFinancialDivergence(database, thresholds)),
      run("ticket_revocation_backlog", () => probeTicketRevocationBacklog(database)),
    ]);

  return {
    refundReconciliationBacklog,
    unresolvedChargebacks,
    financialDivergences,
    ticketRevocationBacklog,
    failures,
  };
}
