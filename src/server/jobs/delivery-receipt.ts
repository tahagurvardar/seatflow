import "server-only";

import type { PrismaClient } from "@/generated/prisma/client";
import type { ServerlessJobOutcome } from "@/generated/prisma/enums";
import type { JobOutcome, ServerlessJobName } from "@/features/jobs/job-contract";

/**
 * Delivery receipts: at-least-once made observable.
 *
 * QStash redelivers on timeout and on any non-2xx response, so the same message
 * id arrives more than once as a matter of routine. Every operation behind
 * these endpoints is already idempotent — that is the property that makes
 * redelivery *safe*. Receipts make it *cheap and visible*: a delivery that
 * already completed is recognized and skipped rather than re-running a batch,
 * and an operator can see retry pressure instead of inferring it.
 *
 * The receipt is never financial authority. If this table were emptied, every
 * job would simply run again — correctly, because each one derives its state
 * from PostgreSQL and claims work under a lock.
 */

function normalizeEnvironment(value: string | undefined) {
  const candidate = (value ?? process.env.NODE_ENV ?? "development").toLowerCase();
  return /^[a-z][a-z0-9_-]{0,31}$/.test(candidate) ? candidate : "development";
}

export type ClaimResult =
  /** First time this message has been seen, or a prior attempt never finished. */
  | { claimed: true; attemptCount: number }
  /** A previous delivery of this exact message already completed. */
  | { claimed: false; reason: "ALREADY_COMPLETED" };

/**
 * Register a delivery, or report that it already completed.
 *
 * A receipt that exists but never completed is deliberately re-claimable: that
 * is what a function killed mid-batch leaves behind, and the correct response
 * is to run the (idempotent) operation again, not to abandon the work.
 */
export async function claimJobDelivery(
  database: PrismaClient,
  input: {
    messageId: string;
    job: ServerlessJobName;
    environment?: string;
    retryCount?: number;
    now?: Date;
  },
): Promise<ClaimResult> {
  const now = input.now ?? new Date();
  const environment = normalizeEnvironment(input.environment);

  const existing = await database.jobDeliveryReceipt.findUnique({
    where: { messageId: input.messageId },
    select: { completedAt: true, attemptCount: true },
  });

  if (existing?.completedAt) {
    return { claimed: false, reason: "ALREADY_COMPLETED" };
  }

  if (existing) {
    const updated = await database.jobDeliveryReceipt.update({
      where: { messageId: input.messageId },
      data: { attemptCount: { increment: 1 } },
      select: { attemptCount: true },
    });
    return { claimed: true, attemptCount: updated.attemptCount };
  }

  try {
    await database.jobDeliveryReceipt.create({
      data: {
        messageId: input.messageId,
        job: input.job,
        environment,
        receivedAt: now,
        attemptCount: Math.max(1, (input.retryCount ?? 0) + 1),
      },
    });
    return { claimed: true, attemptCount: Math.max(1, (input.retryCount ?? 0) + 1) };
  } catch {
    // Two concurrent deliveries of the same message raced to insert. The loser
    // treats it as a duplicate rather than running the batch twice in parallel;
    // the winner is already doing the work.
    return { claimed: false, reason: "ALREADY_COMPLETED" };
  }
}

const OUTCOME_BY_STATUS: Record<
  Exclude<JobOutcome["status"], "duplicate">,
  ServerlessJobOutcome
> = {
  completed: "COMPLETED",
  retryable: "RETRYABLE_FAILURE",
  permanent: "PERMANENT_FAILURE",
};

/**
 * Close out a delivery.
 *
 * A retryable failure is recorded but deliberately left **uncompleted**, so the
 * next delivery of the same message is allowed to claim it again. Marking it
 * completed would make the retry a no-op and strand the work.
 */
export async function recordJobDeliveryOutcome(
  database: PrismaClient,
  input: {
    messageId: string;
    outcome: JobOutcome;
    durationMs: number;
    now?: Date;
  },
) {
  if (input.outcome.status === "duplicate") return;
  const now = input.now ?? new Date();
  const outcome = OUTCOME_BY_STATUS[input.outcome.status];
  const retryable = input.outcome.status === "retryable";

  try {
    await database.jobDeliveryReceipt.update({
      where: { messageId: input.messageId },
      data: {
        // Only a terminal outcome completes the receipt.
        completedAt: retryable ? null : now,
        outcome: retryable ? null : outcome,
        durationMs: Math.max(0, Math.round(input.durationMs)),
        safeErrorCode:
          "safeErrorCode" in input.outcome ? input.outcome.safeErrorCode.slice(0, 80) : null,
      },
    });
  } catch {
    // Observability must never break the work it observes. A receipt that
    // cannot be written costs duplicate-suppression, never correctness.
  }
}

/**
 * Drop receipts older than the retention window.
 *
 * Receipts are pure operational metadata with no downstream reader, so pruning
 * them is safe. Bounded per call to keep a cleanup from becoming an outage.
 */
export async function pruneJobDeliveryReceipts(
  database: PrismaClient,
  input: { olderThanSeconds: number; limit?: number; now?: Date },
) {
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - input.olderThanSeconds * 1_000);
  const stale = await database.jobDeliveryReceipt.findMany({
    where: { receivedAt: { lt: cutoff } },
    orderBy: { receivedAt: "asc" },
    take: Math.min(Math.max(input.limit ?? 500, 1), 5_000),
    select: { messageId: true },
  });
  if (stale.length === 0) return 0;
  const deleted = await database.jobDeliveryReceipt.deleteMany({
    where: { messageId: { in: stale.map((row) => row.messageId) } },
  });
  return deleted.count;
}
