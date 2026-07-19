/**
 * Safe error serialization.
 *
 * Two distinct outputs are produced from one thrown value:
 *
 *  - a log record, which keeps a stable classification and a scrubbed message
 *    so operators can correlate failures without reading secrets;
 *  - a client body, which for an internal failure carries nothing but a generic
 *    sentence and the correlation ID.
 *
 * Nothing here serializes an error object wholesale. Prisma errors in
 * particular embed query text and connection details, so only their code is
 * ever surfaced.
 */

import { MAX_LOG_MESSAGE_LENGTH, safeText } from "./redaction";

/**
 * `expected_rejection` is a request the system correctly refused: unauthorized,
 * invalid, conflicting, or ineligible. It is not an alarm. `internal_failure`
 * is an unhandled or infrastructure fault and is what should page someone.
 */
export type ErrorClassification = "expected_rejection" | "internal_failure";

export interface SafeErrorRecord {
  classification: ErrorClassification;
  code: string;
  message: string;
  correlationId?: string;
}

export const MAX_ERROR_CODE_LENGTH = 64;
const GENERIC_INTERNAL_MESSAGE = "An unexpected error occurred.";

/** Class-name suffixes that indicate a deliberate, expected domain rejection. */
const EXPECTED_REJECTION_SUFFIXES = [
  "AuthenticationError",
  "AuthorizationError",
  "ValidationError",
  "ConflictError",
  "EligibilityError",
  "LifecycleError",
  "SignatureError",
  "NotFoundError",
  "PayloadTooLargeError",
  "RateLimitError",
] as const;

/**
 * Prisma codes that represent a refused request rather than a fault. P2002 is a
 * uniqueness collision, which in this codebase is how exact-once fulfillment and
 * one-active-hold invariants surface. P2025 is a missing required record.
 */
const EXPECTED_PRISMA_CODES = new Set(["P2002", "P2003", "P2004", "P2025"]);

function errorName(error: unknown) {
  if (error instanceof Error && typeof error.name === "string" && error.name) {
    return error.name;
  }
  if (typeof error === "object" && error !== null) {
    const constructorName = (error as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof constructorName === "string" && constructorName) return constructorName;
  }
  return "UnknownError";
}

function prismaErrorCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code: unknown }).code;
  if (typeof code !== "string") return undefined;
  return /^P\d{4}$/.test(code) ? code : undefined;
}

/** Convert a class name such as `HoldConflictError` into `HOLD_CONFLICT`. */
export function deriveErrorCode(name: string) {
  const withoutSuffix = name.replace(/Error$/, "") || name;
  return withoutSuffix
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .toUpperCase()
    .slice(0, MAX_ERROR_CODE_LENGTH) || "UNKNOWN";
}

export function classifyError(error: unknown): ErrorClassification {
  const prismaCode = prismaErrorCode(error);
  if (prismaCode) {
    return EXPECTED_PRISMA_CODES.has(prismaCode) ? "expected_rejection" : "internal_failure";
  }

  const name = errorName(error);
  if (name === "ZodError") return "expected_rejection";
  if (EXPECTED_REJECTION_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return "expected_rejection";
  }
  return "internal_failure";
}

/**
 * Build the log-safe view of a thrown value. The message is retained only for
 * expected rejections, where it is authored by this codebase and useful. An
 * internal failure keeps its message too — logs are trusted output — but it is
 * scrubbed and bounded first, because it may quote a driver or provider string.
 */
export function serializeError(
  error: unknown,
  options: { correlationId?: string } = {},
): SafeErrorRecord {
  const classification = classifyError(error);
  const prismaCode = prismaErrorCode(error);
  const code = prismaCode ? `PRISMA_${prismaCode}` : deriveErrorCode(errorName(error));
  const rawMessage =
    error instanceof Error && typeof error.message === "string" ? error.message : "";

  return {
    classification,
    code,
    message: rawMessage ? safeText(rawMessage, MAX_LOG_MESSAGE_LENGTH) : code,
    ...(options.correlationId ? { correlationId: options.correlationId } : {}),
  };
}

/**
 * Build the client-facing body. An expected rejection may explain itself; an
 * internal failure must not, so the caller learns only that something broke and
 * which correlation ID to quote to support. No stack trace, driver message,
 * provider response, or schema detail is ever included.
 */
export function toClientErrorBody(record: SafeErrorRecord) {
  return {
    error:
      record.classification === "expected_rejection"
        ? record.message
        : GENERIC_INTERNAL_MESSAGE,
    ...(record.correlationId ? { correlationId: record.correlationId } : {}),
  };
}
