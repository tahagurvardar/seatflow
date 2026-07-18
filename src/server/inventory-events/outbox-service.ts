import { randomUUID } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import type { InventoryEventType } from "@/generated/prisma/enums";
import { createSafeInventoryEventPayload } from "@/features/inventory-events/event";

export interface EnqueueInventoryEventInput {
  eventType: InventoryEventType;
  sessionId: string;
  aggregateId?: string;
  deduplicationKey: string;
  now?: Date;
}

export async function enqueueInventoryEvent(
  transaction: Prisma.TransactionClient,
  input: EnqueueInventoryEventInput,
) {
  const id = randomUUID();
  const now = input.now ?? new Date();
  const payload = createSafeInventoryEventPayload({
    eventId: id,
    sessionId: input.sessionId,
    eventType: input.eventType,
    now,
  });

  return transaction.inventoryEventOutbox.create({
    data: {
      id,
      eventType: input.eventType,
      sessionId: input.sessionId,
      aggregateId: input.aggregateId,
      deduplicationKey: input.deduplicationKey,
      createdAt: now,
      availableAt: now,
      payload: payload as Prisma.InputJsonValue,
    },
  });
}

export async function enqueueExpiredHoldEvents(
  transaction: Prisma.TransactionClient,
  input: { sessionId: string; holdIds: string[]; now: Date },
) {
  for (const holdId of input.holdIds) {
    await enqueueInventoryEvent(transaction, {
      eventType: "HOLD_EXPIRED",
      sessionId: input.sessionId,
      aggregateId: holdId,
      deduplicationKey: `hold-expired:${holdId}`,
      now: input.now,
    });
  }
}
