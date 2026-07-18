import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { getHoldConfiguration } from "@/features/holds/config";
import { runInTransaction } from "@/server/database/run-in-transaction";

/**
 * Free the inventory currently pointed at a set of terminal holds. AVAILABLE is
 * the only state a released or expired hold's seats may end in, and the CHECK
 * constraint guarantees the nullable hold columns are cleared together.
 */
async function releaseInventoryForHolds(
  transaction: Prisma.TransactionClient,
  holdIds: string[],
  now: Date,
) {
  if (holdIds.length === 0) return 0;
  const result = await transaction.sessionSeatInventory.updateMany({
    where: { currentHoldId: { in: holdIds } },
    data: {
      state: "AVAILABLE",
      currentHoldId: null,
      holdExpiresAt: null,
      updatedAt: now,
    },
  });
  return result.count;
}

/**
 * Lazy expiry used during hold acquisition: expire this session's overdue active
 * holds and free their seats so an unavailable scheduler never permanently traps
 * inventory. The status-guarded UPDATE is safe to run concurrently — a hold can
 * be expired only once. Runs inside the caller's transaction.
 */
export async function releaseExpiredHoldsForSession(
  transaction: Prisma.TransactionClient,
  sessionId: string,
  now: Date,
): Promise<number> {
  const expired = await transaction.$queryRaw<Array<{ id: string }>>`
    UPDATE "SeatHold"
    SET "status" = 'EXPIRED', "expiredAt" = ${now}, "updatedAt" = ${now}
    WHERE "sessionId" = ${sessionId}
      AND "status" = 'ACTIVE'
      AND "expiresAt" <= ${now}
    RETURNING "id"
  `;
  await releaseInventoryForHolds(
    transaction,
    expired.map((hold) => hold.id),
    now,
  );
  return expired.length;
}

/**
 * Immediately release every active hold for a session (used when the session is
 * cancelled). Holds move to RELEASED and their seats return to AVAILABLE, while
 * hold history is preserved. Runs inside the caller's transaction.
 */
export async function releaseActiveHoldsForSession(
  transaction: Prisma.TransactionClient,
  sessionId: string,
  now: Date,
): Promise<number> {
  const released = await transaction.$queryRaw<Array<{ id: string }>>`
    UPDATE "SeatHold"
    SET "status" = 'RELEASED', "releasedAt" = ${now}, "updatedAt" = ${now}
    WHERE "sessionId" = ${sessionId}
      AND "status" = 'ACTIVE'
    RETURNING "id"
  `;
  await releaseInventoryForHolds(
    transaction,
    released.map((hold) => hold.id),
    now,
  );
  return released.length;
}

export interface ExpirySweepResult {
  holdsExpired: number;
  seatsReleased: number;
  batches: number;
}

interface ExpirySweepOptions {
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
}

/**
 * The authoritative expiry sweeper. It claims overdue active holds in bounded
 * batches using `FOR UPDATE SKIP LOCKED`, so multiple sweepers (or a sweeper
 * racing lazy cleanup) partition the work without blocking or double-processing.
 * Each batch commits independently; the operation is idempotent and never
 * touches unrelated inventory. Phase 4B will schedule this automatically.
 */
export async function sweepExpiredHolds(
  database: PrismaClient,
  options: ExpirySweepOptions = {},
): Promise<ExpirySweepResult> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? getHoldConfiguration().sweepBatchSize;
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;

  let holdsExpired = 0;
  let seatsReleased = 0;
  let batches = 0;

  while (batches < maxBatches) {
    const processed = await runInTransaction(database, async (transaction) => {
      const claimed = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "SeatHold"
        WHERE "status" = 'ACTIVE' AND "expiresAt" <= ${now}
        ORDER BY "expiresAt" ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      `;
      if (claimed.length === 0) return { holds: 0, seats: 0 };

      const ids = claimed.map((hold) => hold.id);
      const expired = await transaction.seatHold.updateMany({
        where: { id: { in: ids }, status: "ACTIVE" },
        data: { status: "EXPIRED", expiredAt: now },
      });
      const seats = await releaseInventoryForHolds(transaction, ids, now);
      return { holds: expired.count, seats };
    });

    if (processed.holds === 0) break;
    holdsExpired += processed.holds;
    seatsReleased += processed.seats;
    batches += 1;
  }

  return { holdsExpired, seatsReleased, batches };
}
