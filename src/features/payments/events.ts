import { z } from "zod";

import { createSafeInventoryEventPayload } from "@/features/inventory-events/event";

const forbiddenPayloadKeys = [
  "email",
  "userId",
  "holdToken",
  "signature",
  "paymentMethod",
  "providerSecret",
] as const;

export function createSafeCommerceEventPayload(input: {
  eventId: string;
  sessionId: string;
  eventType:
    | "CHECKOUT_CREATED"
    | "PAYMENT_INTENT_CREATED"
    | "PAYMENT_SUCCEEDED"
    | "PAYMENT_FAILED"
    | "INVENTORY_BOOKED"
    | "BOOKING_CONFIRMED"
    | "PAYMENT_REQUIRES_REVIEW";
  now?: Date;
}) {
  const payload = createSafeInventoryEventPayload(input);
  const serialized = JSON.stringify(payload);
  for (const key of forbiddenPayloadKeys) {
    if (serialized.includes(`\"${key}\"`)) {
      throw new Error("Commerce event payload contains a forbidden field.");
    }
  }
  return z.object({
    eventId: z.uuid(),
    sessionId: z.string(),
    eventType: z.string(),
    serverTimestamp: z.string(),
  }).parse(payload);
}

