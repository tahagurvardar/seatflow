import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { InventoryEventEnvironment } from "@/env/schema";
import type { InventoryEventType } from "@/generated/prisma/enums";
import {
  inventoryEventPayloadSchema,
  type InventoryInvalidationEvent,
} from "@/features/inventory-events/event";
import { runInTransaction } from "@/server/database/run-in-transaction";
import type { InventoryEventTransport } from "@/server/inventory-events/redis-transport";
import { recordDispatcherRun } from "@/server/operations/inventory-metrics";

export interface OutboxDispatcherConfiguration {
  batchSize: number;
  maximumAttempts: number;
  backoffBaseMs: number;
  backoffMaximumMs: number;
}

export interface OutboxDispatchResult {
  claimed: number;
  processed: number;
  failed: number;
  deadLettered: number;
  durationMs: number;
}

export function getOutboxDispatcherConfiguration(
  environment: InventoryEventEnvironment,
): OutboxDispatcherConfiguration {
  return {
    batchSize: environment.OUTBOX_DISPATCH_BATCH_SIZE,
    maximumAttempts: environment.OUTBOX_DISPATCH_MAX_ATTEMPTS,
    backoffBaseMs: environment.OUTBOX_DISPATCH_BACKOFF_BASE_MS,
    backoffMaximumMs: environment.OUTBOX_DISPATCH_BACKOFF_MAX_MS,
  };
}

interface ClaimedOutboxRow {
  id: string;
  eventType: InventoryEventType;
  sessionId: string;
  payload: Prisma.JsonValue;
  attemptCount: number;
}

export function calculateOutboxBackoffMs(
  attempt: number,
  baseMs: number,
  maximumMs: number,
) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("Outbox attempt must be a positive integer.");
  }
  return Math.min(maximumMs, baseMs * 2 ** Math.min(attempt - 1, 30));
}

export function summarizeOutboxError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown delivery failure";
  return message
    .replace(/redis(s)?:\/\/[^\s]+/gi, "[redis endpoint redacted]")
    .replace(/postgres(ql)?:\/\/[^\s]+/gi, "[database endpoint redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 500);
}

export function shouldDeadLetterOutboxEvent(
  nextAttemptCount: number,
  maximumAttempts: number,
) {
  return nextAttemptCount >= maximumAttempts;
}

export async function dispatchInventoryEventBatch(
  database: PrismaClient,
  transport: InventoryEventTransport,
  configuration: OutboxDispatcherConfiguration,
  now = new Date(),
): Promise<OutboxDispatchResult> {
  const startedAt = performance.now();
  const result = await runInTransaction(
    database,
    async (transaction) => {
      const claimed = await transaction.$queryRaw<ClaimedOutboxRow[]>(Prisma.sql`
        SELECT "id", "eventType", "sessionId", "payload", "attemptCount"
        FROM "InventoryEventOutbox"
        WHERE "processedAt" IS NULL
          AND "deadLetterAt" IS NULL
          AND "availableAt" <= ${now}
        ORDER BY "createdAt" ASC, "id" ASC
        LIMIT ${configuration.batchSize}
        FOR UPDATE SKIP LOCKED
      `);

      let processed = 0;
      let failed = 0;
      let deadLettered = 0;

      for (const row of claimed) {
        try {
          const event: InventoryInvalidationEvent =
            inventoryEventPayloadSchema.parse(row.payload);
          if (event.eventId !== row.id || event.sessionId !== row.sessionId) {
            throw new Error("Outbox envelope does not match its safe payload.");
          }
          await transport.publish(event);
          await transaction.inventoryEventOutbox.update({
            where: { id: row.id },
            data: { processedAt: now, lastError: null },
          });
          processed += 1;
        } catch (error) {
          const nextAttemptCount = row.attemptCount + 1;
          const deadLetter = shouldDeadLetterOutboxEvent(
            nextAttemptCount,
            configuration.maximumAttempts,
          );
          await transaction.inventoryEventOutbox.update({
            where: { id: row.id },
            data: {
              attemptCount: nextAttemptCount,
              lastError: summarizeOutboxError(error),
              availableAt: new Date(
                now.getTime() +
                  calculateOutboxBackoffMs(
                    nextAttemptCount,
                    configuration.backoffBaseMs,
                    configuration.backoffMaximumMs,
                  ),
              ),
              deadLetterAt: deadLetter ? now : null,
            },
          });
          failed += 1;
          if (deadLetter) deadLettered += 1;
        }
      }

      return { claimed: claimed.length, processed, failed, deadLettered };
    },
    { timeout: 30_000 },
  );

  const durationMs = performance.now() - startedAt;
  await recordDispatcherRun(database, {
    durationMs,
    failures: result.failed,
    now,
  });
  return { ...result, durationMs };
}
