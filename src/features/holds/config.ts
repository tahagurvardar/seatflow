import { z } from "zod";

/**
 * Centralized, validated hold configuration. PostgreSQL and server time remain
 * authoritative for every hold decision; these values only tune the server-owned
 * TTL, the all-or-nothing seat ceiling, and the expiry sweeper batch size.
 *
 * Defaults are deliberately conservative and are used verbatim unless an operator
 * sets an environment override, which keeps automated tests deterministic. No
 * secret is read here.
 */
export interface HoldConfiguration {
  /** Server-controlled time-to-live applied to a newly acquired hold. */
  holdDurationMs: number;
  /** Maximum number of seats a single all-or-nothing hold may contain. */
  maxSeatsPerHold: number;
  /** Number of expired holds an expiry sweep claims per bounded batch. */
  sweepBatchSize: number;
}

export const DEFAULT_HOLD_CONFIGURATION: HoldConfiguration = {
  holdDurationMs: 10 * 60 * 1000,
  maxSeatsPerHold: 8,
  sweepBatchSize: 100,
};

// Absolute safety bounds. Even an operator override cannot leave these ranges.
export const HOLD_DURATION_MINUTES_RANGE = { min: 1, max: 60 } as const;
export const MAX_SEATS_PER_HOLD_RANGE = { min: 1, max: 20 } as const;
export const SWEEP_BATCH_SIZE_RANGE = { min: 1, max: 1000 } as const;

const holdEnvironmentSchema = z.object({
  SEAT_HOLD_DURATION_MINUTES: z.coerce
    .number()
    .min(HOLD_DURATION_MINUTES_RANGE.min)
    .max(HOLD_DURATION_MINUTES_RANGE.max)
    .optional(),
  SEAT_HOLD_MAX_SEATS: z.coerce
    .number()
    .int()
    .min(MAX_SEATS_PER_HOLD_RANGE.min)
    .max(MAX_SEATS_PER_HOLD_RANGE.max)
    .optional(),
  SEAT_HOLD_SWEEP_BATCH_SIZE: z.coerce
    .number()
    .int()
    .min(SWEEP_BATCH_SIZE_RANGE.min)
    .max(SWEEP_BATCH_SIZE_RANGE.max)
    .optional(),
});

type HoldEnvironmentSource = Record<string, string | undefined>;

/**
 * Resolve the effective hold configuration from optional environment overrides,
 * falling back to the conservative defaults. Invalid overrides fail loudly.
 */
export function resolveHoldConfiguration(
  source: HoldEnvironmentSource = process.env,
): HoldConfiguration {
  const parsed = holdEnvironmentSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"} ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid SeatFlow hold configuration: ${details}.`);
  }

  return {
    holdDurationMs:
      parsed.data.SEAT_HOLD_DURATION_MINUTES !== undefined
        ? Math.round(parsed.data.SEAT_HOLD_DURATION_MINUTES * 60 * 1000)
        : DEFAULT_HOLD_CONFIGURATION.holdDurationMs,
    maxSeatsPerHold:
      parsed.data.SEAT_HOLD_MAX_SEATS ?? DEFAULT_HOLD_CONFIGURATION.maxSeatsPerHold,
    sweepBatchSize:
      parsed.data.SEAT_HOLD_SWEEP_BATCH_SIZE ??
      DEFAULT_HOLD_CONFIGURATION.sweepBatchSize,
  };
}

let cachedConfiguration: HoldConfiguration | undefined;

/** Server-side accessor with a process-lifetime cache. */
export function getHoldConfiguration(): HoldConfiguration {
  cachedConfiguration ??= resolveHoldConfiguration();
  return cachedConfiguration;
}
