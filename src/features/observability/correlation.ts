/**
 * Request and operation correlation identifiers.
 *
 * A correlation ID ties one HTTP request, server action, worker batch, or
 * webhook delivery to the log records it produced. It is a debugging aid only:
 * it is never an authentication factor and never an idempotency key, because it
 * is partly client-supplied. Idempotency remains the caller's explicit key plus
 * PostgreSQL uniqueness.
 */

export const CORRELATION_HEADER = "x-correlation-id";
export const REQUEST_ID_HEADER = "x-request-id";

export const MIN_CORRELATION_LENGTH = 8;
export const MAX_CORRELATION_LENGTH = 64;

/**
 * Strict grammar. Rejecting anything outside URL-safe base64 characters is what
 * prevents header injection: a value containing CR, LF, or a separator can
 * never be echoed back into a response header.
 */
const CORRELATION_PATTERN = new RegExp(
  `^[A-Za-z0-9_-]{${MIN_CORRELATION_LENGTH},${MAX_CORRELATION_LENGTH}}$`,
);

export function isValidCorrelationId(value: unknown): value is string {
  return typeof value === "string" && CORRELATION_PATTERN.test(value);
}

/** 128 bits of CSPRNG entropy rendered as 32 lowercase hex characters. */
export function generateCorrelationId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Accept a caller-supplied correlation ID only when it matches the strict
 * grammar, otherwise mint a fresh one. An oversized, malformed, or injected
 * header is silently replaced rather than rejected, because a bad debugging
 * header must never fail an otherwise valid request.
 */
export function resolveCorrelationId(candidate: string | null | undefined) {
  return isValidCorrelationId(candidate) ? candidate : generateCorrelationId();
}

/** Read the correlation ID from request headers, preferring the canonical name. */
export function correlationIdFromHeaders(headers: Headers) {
  const direct = headers.get(CORRELATION_HEADER);
  if (isValidCorrelationId(direct)) return direct;
  const requestId = headers.get(REQUEST_ID_HEADER);
  return resolveCorrelationId(requestId);
}

/**
 * A correlation ID for work that did not arrive over HTTP, such as an outbox
 * dispatch batch or a scheduled sweep. The prefix keeps worker traces greppable
 * while remaining inside the accepted grammar.
 */
export function createOperationCorrelationId(prefix: string) {
  const normalized = prefix.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16) || "op";
  return `${normalized}-${generateCorrelationId()}`.slice(0, MAX_CORRELATION_LENGTH);
}
