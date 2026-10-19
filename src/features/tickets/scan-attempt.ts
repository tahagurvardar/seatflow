/**
 * Client-side idempotency for entry scans.
 *
 * A scan whose response never arrived may already have been accepted by the
 * server. Retrying it under a fresh key would be evaluated as a second scan and
 * answered ALREADY_USED, turning a legitimate guest away. Retrying under the
 * same key replays the original result instead.
 *
 * The key is therefore kept until the server gives a definitive answer, and only
 * for the identical credential and session; any other scan gets a new key.
 *
 * Pure: the caller supplies key generation.
 */

export interface PendingScanAttempt {
  credential: string;
  sessionId: string;
  idempotencyKey: string;
}

export function resolveScanAttempt(
  pending: PendingScanAttempt | null,
  next: { credential: string; sessionId: string },
  createKey: () => string,
): PendingScanAttempt {
  if (
    pending &&
    pending.credential === next.credential &&
    pending.sessionId === next.sessionId
  ) {
    return pending;
  }
  return { ...next, idempotencyKey: createKey() };
}

/**
 * Whether an attempt must keep its key for a retry. Only outcomes where the
 * server may not have recorded a decision qualify: a network failure, a server
 * error, or a rate limit that rejected the request before evaluation.
 */
export function shouldRetainScanAttempt(response: { status: number } | "network-error") {
  if (response === "network-error") return true;
  return response.status === 429 || response.status >= 500;
}

export function createScanIdempotencyKey() {
  return crypto.randomUUID().replaceAll("-", "");
}
