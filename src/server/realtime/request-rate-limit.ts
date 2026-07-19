import { readOperationsEnvironment } from "@/env/schema";
import {
  resolveClientAddress,
  type TrustedProxyPolicy,
} from "@/features/security/client-address";

/**
 * Process-local fixed-window limiter.
 *
 * Retained from Phase 4B as the fallback when the distributed limiter in
 * `@/server/security/rate-limit` cannot reach Redis. On its own it only bounds
 * one instance, so it is defence in depth rather than a production abuse-control
 * claim.
 */

interface RateLimitBucket {
  count: number;
  resetsAt: number;
}

const buckets = new Map<string, RateLimitBucket>();

/**
 * Bound the bucket map so a limiter keyed on a rotating subject cannot grow
 * into an unbounded memory leak in a long-lived process.
 */
const MAX_TRACKED_BUCKETS = 10_000;

function evictExpired(now: number) {
  if (buckets.size < MAX_TRACKED_BUCKETS) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetsAt <= now) buckets.delete(key);
  }
  // Still oversized after eviction: drop the oldest insertions.
  if (buckets.size >= MAX_TRACKED_BUCKETS) {
    const excess = buckets.size - MAX_TRACKED_BUCKETS + 1;
    let removed = 0;
    for (const key of buckets.keys()) {
      buckets.delete(key);
      if (++removed >= excess) break;
    }
  }
}

export function consumeRateLimit(
  key: string,
  input: { limit: number; windowMs: number; now?: number },
) {
  const now = input.now ?? Date.now();
  const existing = buckets.get(key);
  if (!existing || existing.resetsAt <= now) {
    evictExpired(now);
    buckets.set(key, { count: 1, resetsAt: now + input.windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (existing.count >= input.limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetsAt - now) / 1_000)),
    };
  }
  existing.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Test seam. */
export function resetRateLimitBuckets() {
  buckets.clear();
}

function readTrustedProxyPolicy(): TrustedProxyPolicy {
  try {
    const environment = readOperationsEnvironment();
    return {
      mode: environment.TRUSTED_PROXY_MODE,
      hopCount: environment.TRUSTED_PROXY_HOP_COUNT,
      headerName: environment.TRUSTED_PROXY_HEADER,
    };
  } catch {
    // A configuration fault must not silently re-enable blind header trust.
    return { mode: "none" };
  }
}

/**
 * Resolve a rate-limit address fragment under the configured trusted-proxy
 * policy.
 *
 * Phase 5C1 hardening: this previously returned the first `X-Forwarded-For`
 * entry unconditionally, which let any caller reset its own limiter bucket by
 * rotating a header it fully controls. Forwarding headers are now honoured only
 * when the deployment declares who is allowed to set them.
 *
 * Returns `"unattributed"` when no address can be trusted. Callers must combine
 * this with an authenticated subject wherever one exists, so an unattributable
 * request cannot consume another caller's budget.
 */
export function clientAddressFromRequest(request: Request) {
  const resolved = resolveClientAddress({
    policy: readTrustedProxyPolicy(),
    headers: request.headers,
  });
  return (resolved.address ?? "unattributed").slice(0, 128);
}
