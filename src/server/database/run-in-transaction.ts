import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { recordTransactionRetry } from "@/server/operations/inventory-metrics";

export { Prisma };

function prismaErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String((error as { code: unknown }).code);
  }
  return undefined;
}

/**
 * A serialization failure or deadlock that is safe to retry with the identical
 * request. Read-committed hold acquisition relies on row locks, so the common
 * retryable case is a PostgreSQL deadlock (40P01) or Prisma's write-conflict
 * wrapper (P2034); serializable callers may also see 40001.
 */
export function isRetryableTransactionError(error: unknown) {
  const code = prismaErrorCode(error);
  if (code === "P2034") return true;
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : "";
  return (
    code === "40001" ||
    code === "40P01" ||
    message.includes("40001") ||
    message.includes("40P01") ||
    message.includes("deadlock detected") ||
    message.includes("could not serialize")
  );
}

interface TransactionOptions {
  isolationLevel?: Prisma.TransactionIsolationLevel;
  maximumAttempts?: number;
  timeout?: number;
  maxWait?: number;
}

/**
 * Run a database transaction with bounded retries on retryable serialization or
 * deadlock failures only. Non-retryable validation and conflict errors propagate
 * immediately so a doomed request is never re-run.
 */
export async function runInTransaction<Result>(
  database: PrismaClient,
  operation: (transaction: Prisma.TransactionClient) => Promise<Result>,
  options: TransactionOptions = {},
): Promise<Result> {
  const attempts = options.maximumAttempts ?? 5;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await database.$transaction(operation, {
        isolationLevel: options.isolationLevel,
        maxWait: options.maxWait ?? 5_000,
        timeout: options.timeout ?? 15_000,
      });
    } catch (error) {
      if (!isRetryableTransactionError(error) || attempt === attempts) {
        throw error;
      }
      await recordTransactionRetry(database);
      // Small jittered backoff so contending retriers do not resynchronize.
      await new Promise((resolve) =>
        setTimeout(resolve, attempt * 12 + Math.floor(Math.random() * 24)),
      );
    }
  }

  throw new Error("Transaction retry limit reached.");
}
