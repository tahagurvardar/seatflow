import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { calculatePricingCoverage } from "@/features/events/pricing";
import { computeSessionInventoryRows } from "@/features/holds/inventory";
import { runInTransaction } from "@/server/database/run-in-transaction";
import { InventoryError } from "@/server/holds/errors";

const materializationInclude = {
  seatMap: {
    include: {
      sections: {
        orderBy: [{ displayOrder: "asc" }, { code: "asc" }],
        include: {
          rows: {
            orderBy: [{ displayOrder: "asc" }, { label: "asc" }],
            include: {
              seats: { orderBy: [{ displayOrder: "asc" }, { label: "asc" }] },
            },
          },
        },
      },
    },
  },
  priceTiers: true,
  sectionPricing: true,
} satisfies Prisma.EventSessionInclude;

export interface MaterializationResult {
  sessionId: string;
  created: number;
  sellableCapacity: number;
  total: number;
}

/**
 * Idempotently materialize a session's authoritative sellable inventory inside a
 * caller-provided transaction. Rows are derived solely from the immutable
 * published seat map and section pricing; `skipDuplicates` on `(sessionId,
 * seatId)` makes repeated publication safe. Database triggers independently
 * re-check ancestry and price snapshots for every inserted row.
 */
export async function materializeSessionInventory(
  transaction: Prisma.TransactionClient,
  sessionId: string,
): Promise<MaterializationResult> {
  const session = await transaction.eventSession.findUnique({
    where: { id: sessionId },
    include: materializationInclude,
  });
  if (!session) {
    throw new InventoryError("The session no longer exists for materialization.");
  }

  const rows = computeSessionInventoryRows({
    sections: session.seatMap.sections,
    priceTiers: session.priceTiers,
    sectionPricing: session.sectionPricing,
  });

  const created =
    rows.length > 0
      ? await transaction.sessionSeatInventory.createMany({
          data: rows.map((row) => ({ sessionId, ...row })),
          skipDuplicates: true,
        })
      : { count: 0 };

  const total = await transaction.sessionSeatInventory.count({
    where: { sessionId },
  });

  return {
    sessionId,
    created: created.count,
    sellableCapacity: rows.length,
    total,
  };
}

/**
 * Ensure inventory exists for a session as part of its publication transaction,
 * verifying afterwards that the row count equals the session's sellable capacity.
 * A mismatch aborts the surrounding transaction rather than publishing a session
 * with partial inventory.
 */
export async function ensureSessionInventory(
  transaction: Prisma.TransactionClient,
  sessionId: string,
): Promise<MaterializationResult> {
  const result = await materializeSessionInventory(transaction, sessionId);
  if (result.total !== result.sellableCapacity) {
    throw new InventoryError(
      "Materialized inventory does not match the session's sellable capacity.",
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Backfill for sessions published before Phase 4A
// ---------------------------------------------------------------------------

export type BackfillOutcome =
  | "materialized"
  | "skipped_complete"
  | "skipped_ineligible"
  | "refused_inconsistent";

export interface BackfillSessionReport {
  sessionId: string;
  eventTitle: string;
  outcome: BackfillOutcome;
  sellableCapacity: number;
  existingInventory: number;
  createdInventory: number;
  detail?: string;
}

export interface BackfillSummary {
  scanned: number;
  materialized: number;
  skippedComplete: number;
  skippedIneligible: number;
  refusedInconsistent: number;
  sessions: BackfillSessionReport[];
}

/**
 * Idempotent, transactional backfill for eligible published sessions that lack
 * inventory. It re-runs pricing validation, materializes missing inventory,
 * skips sessions that are already complete, and refuses (never silently repairs)
 * partial or inconsistent existing inventory. Draft sessions are never touched
 * and no pricing is invented. The returned summary contains no credentials.
 */
export async function backfillPublishedSessionInventory(
  database: PrismaClient,
): Promise<BackfillSummary> {
  const candidates = await database.eventSession.findMany({
    where: {
      publishedAt: { not: null },
      status: { in: ["SCHEDULED", "ON_SALE", "SALES_PAUSED"] },
      event: { status: "PUBLISHED" },
    },
    orderBy: { publishedAt: "asc" },
    include: {
      event: { select: { title: true } },
      ...materializationInclude,
    },
  });

  const summary: BackfillSummary = {
    scanned: candidates.length,
    materialized: 0,
    skippedComplete: 0,
    skippedIneligible: 0,
    refusedInconsistent: 0,
    sessions: [],
  };

  for (const session of candidates) {
    const coverage = calculatePricingCoverage(
      session.seatMap.sections,
      session.priceTiers,
      session.sectionPricing,
    );
    const expected = computeSessionInventoryRows({
      sections: session.seatMap.sections,
      priceTiers: session.priceTiers,
      sectionPricing: session.sectionPricing,
    });
    const existing = await database.sessionSeatInventory.count({
      where: { sessionId: session.id },
    });

    const report = (
      outcome: BackfillOutcome,
      createdInventory: number,
      detail?: string,
    ): BackfillSessionReport => ({
      sessionId: session.id,
      eventTitle: session.event.title,
      outcome,
      sellableCapacity: expected.length,
      existingInventory: existing,
      createdInventory,
      detail,
    });

    if (coverage.issues.length > 0 || coverage.totalSellable <= 0) {
      summary.skippedIneligible += 1;
      summary.sessions.push(
        report("skipped_ineligible", 0, "Session no longer passes pricing validation."),
      );
      continue;
    }

    if (existing === expected.length) {
      summary.skippedComplete += 1;
      summary.sessions.push(report("skipped_complete", 0));
      continue;
    }

    if (existing !== 0) {
      summary.refusedInconsistent += 1;
      summary.sessions.push(
        report(
          "refused_inconsistent",
          0,
          `Found ${existing} of ${expected.length} expected inventory rows; refusing to repair automatically.`,
        ),
      );
      continue;
    }

    const result = await runInTransaction(database, (transaction) =>
      ensureSessionInventory(transaction, session.id),
    );
    summary.materialized += 1;
    summary.sessions.push(report("materialized", result.created));
  }

  return summary;
}
