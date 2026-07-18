import { z } from "zod";

export const inventoryEventTypes = [
  "INVENTORY_MATERIALIZED",
  "HOLD_CREATED",
  "HOLD_RELEASED",
  "HOLD_EXPIRED",
  "SESSION_CANCELLED",
] as const;

export const inventoryEventTypeSchema = z.enum(inventoryEventTypes);
export type SafeInventoryEventType = z.infer<typeof inventoryEventTypeSchema>;

export const inventoryEventPayloadSchema = z
  .object({
    eventId: z.uuid(),
    sessionId: z.string().min(1).max(128).regex(/^[a-z0-9_-]+$/i),
    eventType: inventoryEventTypeSchema,
    serverTimestamp: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((payload, context) => {
    if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 2_048) {
      context.addIssue({
        code: "custom",
        message: "Inventory event payload exceeds the safe size limit.",
      });
    }
  });

export type InventoryInvalidationEvent = z.infer<
  typeof inventoryEventPayloadSchema
>;

export function createSafeInventoryEventPayload(input: {
  eventId: string;
  sessionId: string;
  eventType: SafeInventoryEventType;
  now?: Date;
}): InventoryInvalidationEvent {
  return inventoryEventPayloadSchema.parse({
    eventId: input.eventId,
    sessionId: input.sessionId,
    eventType: input.eventType,
    serverTimestamp: (input.now ?? new Date()).toISOString(),
  });
}

export function serializeInventoryEvent(event: InventoryInvalidationEvent) {
  return JSON.stringify(inventoryEventPayloadSchema.parse(event));
}

export function parseInventoryEvent(value: string) {
  if (new TextEncoder().encode(value).byteLength > 2_048) {
    throw new Error("Inventory event exceeds the safe size limit.");
  }
  return inventoryEventPayloadSchema.parse(JSON.parse(value));
}
