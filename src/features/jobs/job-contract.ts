import { z } from "zod";

/**
 * The serverless job contract.
 *
 * Phase 5C2B runs the same bounded operations Phase 4B/5B/5C put behind BullMQ
 * workers, but triggered by a signed QStash delivery instead of a resident
 * process. The operations themselves are unchanged; only the trigger differs.
 *
 * The single most important property here is that a job payload carries **no
 * business state**. It names an operation and, at most, a batch-size override.
 * Every seat, hold, payment, refund, booking, and ticket fact is read from
 * PostgreSQL inside the handler. A caller who forged a payload could therefore
 * ask for work to happen sooner — which the scheduler is allowed to do anyway —
 * but could never assert that a payment succeeded, a refund settled, or a
 * ticket belongs to someone.
 *
 * Pure: no I/O, no clock, no environment access.
 */

export const SERVERLESS_JOB_NAMES = [
  "inventory-outbox-dispatch",
  "hold-expiry-sweep",
  "ticket-issuance-dispatch",
  "notification-dispatch",
  "refund-reconciliation",
  "stale-webhook-reconciliation",
  "ticket-revocation-audit",
] as const;

export type ServerlessJobName = (typeof SERVERLESS_JOB_NAMES)[number];

export function isServerlessJobName(value: string): value is ServerlessJobName {
  return (SERVERLESS_JOB_NAMES as readonly string[]).includes(value);
}

/**
 * Strict on purpose. An unknown key is a rejected delivery rather than an
 * ignored one, so a payload that tries to smuggle `bookingId`, `amountMinor`,
 * or `actorUserId` fails loudly instead of being silently dropped.
 */
export const serverlessJobPayloadSchema = z.strictObject({
  job: z.enum(SERVERLESS_JOB_NAMES),
  /**
   * Bounded override for the handler's batch size. The handler clamps this
   * again against its own configured maximum; this bound only keeps an absurd
   * value from reaching it.
   */
  batchSize: z.number().int().min(1).max(500).optional(),
  /** Scheduler-supplied, used only for logging correlation. Never trusted. */
  scheduledFor: z.iso.datetime({ offset: true }).optional(),
});

export type ServerlessJobPayload = z.infer<typeof serverlessJobPayloadSchema>;

/**
 * Why a delivery was refused before any work happened. Each maps to a fixed
 * response; none is ever echoed back to the caller with detail attached.
 */
export type JobRejection =
  | "SIGNATURE_MISSING"
  | "SIGNATURE_INVALID"
  | "PAYLOAD_TOO_LARGE"
  | "PAYLOAD_INVALID"
  | "JOB_UNKNOWN"
  | "JOB_MODE_DISABLED"
  | "CONFIGURATION_UNAVAILABLE";

/**
 * The result of running a job.
 *
 *  - `completed`   the batch ran; `metrics` are safe counters only
 *  - `duplicate`   this exact delivery already completed; nothing re-ran
 *  - `retryable`   a transient dependency failed; QStash should deliver again
 *  - `permanent`   the job cannot succeed by being retried; stop delivering
 */
export type JobOutcome =
  | { status: "completed"; metrics: Readonly<Record<string, number>> }
  | { status: "duplicate" }
  | { status: "retryable"; safeErrorCode: string }
  | { status: "permanent"; safeErrorCode: string };

/**
 * Map an outcome onto an HTTP status QStash will interpret correctly.
 *
 * QStash retries any non-2xx response. That makes the mapping a correctness
 * decision, not a cosmetic one: a permanent failure must answer 2xx or QStash
 * would redeliver it until the attempt budget is exhausted, burying a real
 * fault under retry noise. The failure is recorded in PostgreSQL either way, so
 * answering 200 loses no visibility.
 */
export function jobOutcomeHttpStatus(outcome: JobOutcome) {
  switch (outcome.status) {
    case "completed":
    case "duplicate":
    case "permanent":
      return 200;
    case "retryable":
      return 503;
  }
}

export function jobRejectionHttpStatus(rejection: JobRejection) {
  switch (rejection) {
    case "SIGNATURE_MISSING":
    case "SIGNATURE_INVALID":
      return 401;
    case "PAYLOAD_TOO_LARGE":
      return 413;
    case "PAYLOAD_INVALID":
    case "JOB_UNKNOWN":
      return 400;
    case "JOB_MODE_DISABLED":
    case "CONFIGURATION_UNAVAILABLE":
      // Not an error the caller can fix by changing the request, and not a
      // permanent refusal either: the deployment may simply not be in
      // serverless mode yet. 503 lets QStash retry rather than discard.
      return 503;
  }
}

/**
 * Reduce an arbitrary thrown value to a bounded, non-identifying code.
 *
 * Job errors reach a scheduler log that this platform does not control, so the
 * message is stripped of endpoints and truncated before it can travel.
 */
export function summarizeJobError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown job failure";
  return (
    message
      .replace(/redis(s)?:\/\/[^\s]+/gi, "[redis endpoint redacted]")
      .replace(/postgres(ql)?:\/\/[^\s]+/gi, "[database endpoint redacted]")
      .replace(/https?:\/\/[^\s]+/gi, "[url redacted]")
      .replace(/[^A-Za-z0-9_:-]+/g, "_")
      .toUpperCase()
      .slice(0, 80) || "JOB_FAILURE"
  );
}

/**
 * Whether a thrown failure is worth another delivery.
 *
 * Defaults to retryable. A transient database blip that is misread as permanent
 * silently stops the work; a permanent fault misread as transient merely costs
 * a bounded number of retries and stays visible. The asymmetry favours retry.
 */
export function classifyJobFailure(error: unknown): JobOutcome {
  const code = summarizeJobError(error);
  if (code.startsWith("PERMANENT_")) {
    return { status: "permanent", safeErrorCode: code };
  }
  return { status: "retryable", safeErrorCode: code };
}

/** Stable per job and schedule slot, so a duplicate delivery is recognizable. */
export function jobIdempotencyKey(job: ServerlessJobName, messageId: string) {
  return `${job}:${messageId}`;
}
