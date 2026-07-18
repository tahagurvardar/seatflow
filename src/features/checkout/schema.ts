import { z } from "zod";

import { idempotencyKeySchema, holdTokenSchema } from "@/features/holds/schema";

export const checkoutCreateInputSchema = z
  .object({
    holdToken: holdTokenSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export const orderReferenceSchema = z
  .string()
  .trim()
  .min(24)
  .max(191)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid checkout reference.");

export const bookingReferenceSchema = z
  .string()
  .trim()
  .min(24)
  .max(191)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid booking reference.");

export const checkoutRouteParamsSchema = z.object({
  orderReference: orderReferenceSchema,
});

export const bookingRouteParamsSchema = z.object({
  bookingReference: bookingReferenceSchema,
});

export const expireCheckoutCommandSchema = z.object({
  batchSize: z.coerce.number().int().min(1).max(1_000).default(100),
  maxBatches: z.coerce.number().int().min(1).max(100_000).default(10),
});

