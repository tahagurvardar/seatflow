import { Prisma, type PrismaClient } from "@/generated/prisma/client";

function isWriteConflict(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2034"
  );
}

export async function withSerializableRetry<Result>(
  database: PrismaClient,
  operation: (transaction: Prisma.TransactionClient) => Promise<Result>,
  maximumAttempts = 3,
) {
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      return await database.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 10_000,
      });
    } catch (error) {
      if (!isWriteConflict(error) || attempt === maximumAttempts) {
        throw error;
      }
    }
  }

  throw new Error("Serializable transaction retry limit reached.");
}
