import type { PrismaClient } from "@/generated/prisma/client";

const METRIC_ID = "inventory";

async function bestEffort(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch {
    // Metrics are deliberately outside the inventory correctness path.
  }
}

export async function recordHoldConflict(database: PrismaClient) {
  await bestEffort(() =>
    database.inventoryOperationsMetric.upsert({
      where: { id: METRIC_ID },
      create: { id: METRIC_ID, holdConflictCount: BigInt(1) },
      update: { holdConflictCount: { increment: BigInt(1) } },
    }),
  );
}

export async function recordTransactionRetry(database: PrismaClient) {
  await bestEffort(() =>
    database.inventoryOperationsMetric.upsert({
      where: { id: METRIC_ID },
      create: { id: METRIC_ID, transactionRetryCount: BigInt(1) },
      update: { transactionRetryCount: { increment: BigInt(1) } },
    }),
  );
}

export async function recordDispatcherRun(
  database: PrismaClient,
  input: { durationMs: number; failures: number; now?: Date },
) {
  await bestEffort(() =>
    database.inventoryOperationsMetric.upsert({
      where: { id: METRIC_ID },
      create: {
        id: METRIC_ID,
        dispatcherFailureCount: BigInt(input.failures),
        lastDispatcherDurationMs: Math.max(0, Math.round(input.durationMs)),
        lastDispatcherAt: input.now ?? new Date(),
      },
      update: {
        dispatcherFailureCount: { increment: BigInt(input.failures) },
        lastDispatcherDurationMs: Math.max(0, Math.round(input.durationMs)),
        lastDispatcherAt: input.now ?? new Date(),
      },
    }),
  );
}

export async function recordExpirySweep(
  database: PrismaClient,
  input: { durationMs: number; lagMs: number; now?: Date },
) {
  await bestEffort(() =>
    database.inventoryOperationsMetric.upsert({
      where: { id: METRIC_ID },
      create: {
        id: METRIC_ID,
        lastExpirySweepDurationMs: Math.max(0, Math.round(input.durationMs)),
        lastExpiryLagMs: Math.max(0, Math.round(input.lagMs)),
        lastExpirySweepAt: input.now ?? new Date(),
      },
      update: {
        lastExpirySweepDurationMs: Math.max(0, Math.round(input.durationMs)),
        lastExpiryLagMs: Math.max(0, Math.round(input.lagMs)),
        lastExpirySweepAt: input.now ?? new Date(),
      },
    }),
  );
}
