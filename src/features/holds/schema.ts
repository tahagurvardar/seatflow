import { z } from "zod";

import {
  MAX_SEATS_PER_HOLD_RANGE,
  SWEEP_BATCH_SIZE_RANGE,
} from "@/features/holds/config";

const identifier = z.string().trim().min(1).max(191);

/** Client-generated idempotency key: opaque, bounded, and safe-charactered. */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8, "Use an idempotency key of at least 8 characters.")
  .max(191)
  .regex(
    /^[A-Za-z0-9._:-]+$/,
    "Idempotency keys may use letters, numbers, and . _ : - only.",
  );

/** Unguessable public hold token (URL-safe base64). */
export const holdTokenSchema = z
  .string()
  .trim()
  .min(20)
  .max(120)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid hold reference.");

/**
 * Hold creation input. The client may supply only the session, the selected
 * physical-seat identifiers, and an idempotency key. Ownership, price, currency,
 * expiry, and status are never accepted from the client and are re-derived by
 * the server. The seat ceiling is bounded by validated configuration.
 */
export function holdCreateInputSchema(maxSeatsPerHold: number) {
  const upperBound = Math.min(
    Math.max(maxSeatsPerHold, MAX_SEATS_PER_HOLD_RANGE.min),
    MAX_SEATS_PER_HOLD_RANGE.max,
  );

  return z.object({
    sessionId: identifier,
    seatIds: z
      .array(identifier)
      .min(1, "Select at least one seat.")
      .max(upperBound, `You can hold at most ${upperBound} seats at once.`)
      .refine(
        (seatIds) => new Set(seatIds).size === seatIds.length,
        "Duplicate seats are not allowed.",
      ),
    idempotencyKey: idempotencyKeySchema,
  });
}

export type HoldCreateInput = z.infer<ReturnType<typeof holdCreateInputSchema>>;

export const holdReleaseInputSchema = z.object({
  publicToken: holdTokenSchema,
});

export type HoldReleaseInput = z.infer<typeof holdReleaseInputSchema>;

/** Bounds for the operational expiry-sweep command. */
export const expirySweepCommandSchema = z.object({
  batchSize: z.coerce
    .number()
    .int()
    .min(SWEEP_BATCH_SIZE_RANGE.min)
    .max(SWEEP_BATCH_SIZE_RANGE.max)
    .optional(),
  maxBatches: z.coerce.number().int().min(1).max(100_000).optional(),
});

export type ExpirySweepCommand = z.infer<typeof expirySweepCommandSchema>;

/** Route-parameter guards. */
export const seatSelectionParamsSchema = z.object({
  slug: z.string().trim().min(1).max(191),
  sessionId: identifier,
});

export const holdRouteParamsSchema = z.object({
  holdToken: holdTokenSchema,
});
