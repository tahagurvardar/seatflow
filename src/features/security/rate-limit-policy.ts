/**
 * Rate-limit policy catalogue.
 *
 * Every protected operation names a bounded policy here rather than passing ad
 * hoc numbers at the call site, so limits are reviewable in one place and the
 * Redis key space stays enumerable.
 *
 * ## Failure modes
 *
 * `failureMode` states what happens when the distributed backend is unavailable
 * *after* the process-local fallback has already been consulted.
 *
 * Most policies are `fail_open`. That is a deliberate decision, not laziness:
 * for every one of them PostgreSQL remains the decisive authority, so losing a
 * counter degrades abuse protection but cannot produce an incorrect financial,
 * inventory, booking, ticket, or entry outcome.
 *
 *  - payment webhooks must never be dropped because a cache is down, or a
 *    verified payment would go unfulfilled;
 *  - checkout and hold acquisition are already exact-once through row locks and
 *    idempotency keys;
 *  - ticket validation cannot falsely accept entry, because acceptance requires
 *    the credential hash to match and the single-use partial unique index to be
 *    free — a skipped rate-limit check cannot forge either;
 *  - customers must still reach their own tickets during an infrastructure
 *    incident.
 *
 * `operations.admin` is `fail_closed`: mutating administrative operations are
 * low volume, an operator can retry, and refusing them while we cannot count is
 * safer than allowing unbounded privileged calls. Read-only operational health
 * stays `fail_open` precisely because it is most needed during an outage.
 */

export type RateLimitFailureMode = "fail_open" | "fail_closed";

/**
 * What the counter is keyed on.
 * - `ip`             anonymous or pre-authentication traffic
 * - `subject`        an authenticated user or other server-derived subject
 * - `subject_and_ip` both, so one compromised account cannot be spread across
 *                    networks and one network cannot spread across accounts
 * - `global`         a single shared counter, used for provider ingress
 */
export type RateLimitScope = "ip" | "subject" | "subject_and_ip" | "global";

export interface RateLimitPolicy {
  name: string;
  limit: number;
  windowSeconds: number;
  scope: RateLimitScope;
  failureMode: RateLimitFailureMode;
}

export const RATE_LIMIT_POLICIES = {
  "auth.login": {
    name: "auth.login",
    limit: 10,
    windowSeconds: 300,
    scope: "ip",
    failureMode: "fail_open",
  },
  "auth.register": {
    name: "auth.register",
    limit: 5,
    windowSeconds: 3_600,
    scope: "ip",
    failureMode: "fail_open",
  },
  "checkout.create": {
    name: "checkout.create",
    limit: 20,
    windowSeconds: 300,
    scope: "subject_and_ip",
    failureMode: "fail_open",
  },
  "payment.initiate": {
    name: "payment.initiate",
    limit: 20,
    windowSeconds: 300,
    scope: "subject_and_ip",
    failureMode: "fail_open",
  },
  "payment.webhook": {
    name: "payment.webhook",
    limit: 600,
    windowSeconds: 60,
    scope: "global",
    failureMode: "fail_open",
  },
  "ticket.qr": {
    name: "ticket.qr",
    limit: 60,
    windowSeconds: 60,
    scope: "subject",
    failureMode: "fail_open",
  },
  "ticket.pdf_grant": {
    name: "ticket.pdf_grant",
    limit: 10,
    windowSeconds: 300,
    scope: "subject",
    failureMode: "fail_open",
  },
  "ticket.pdf_download": {
    name: "ticket.pdf_download",
    limit: 30,
    windowSeconds: 300,
    scope: "subject",
    failureMode: "fail_open",
  },
  "ticket.validate": {
    name: "ticket.validate",
    limit: 120,
    windowSeconds: 60,
    scope: "subject_and_ip",
    failureMode: "fail_open",
  },
  "realtime.room_ticket": {
    name: "realtime.room_ticket",
    limit: 60,
    windowSeconds: 60,
    scope: "subject_and_ip",
    failureMode: "fail_open",
  },
  "inventory.snapshot": {
    name: "inventory.snapshot",
    limit: 120,
    windowSeconds: 60,
    scope: "subject_and_ip",
    failureMode: "fail_open",
  },
  "operations.health": {
    name: "operations.health",
    limit: 60,
    windowSeconds: 60,
    scope: "subject",
    failureMode: "fail_open",
  },
  "operations.admin": {
    name: "operations.admin",
    limit: 30,
    windowSeconds: 60,
    scope: "subject",
    failureMode: "fail_closed",
  },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitPolicyName = keyof typeof RATE_LIMIT_POLICIES;

export function getRateLimitPolicy(name: RateLimitPolicyName): RateLimitPolicy {
  return RATE_LIMIT_POLICIES[name];
}

export interface RateLimitDecisionInput {
  policy: RateLimitPolicy;
  /** Count already consumed in the window, including this request. */
  count: number | null;
  /** True when the distributed backend answered. */
  backendAvailable: boolean;
  /** Result of the process-local fallback, when one ran. */
  localAllowed?: boolean;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** `distributed`, `local`, or `unavailable` — surfaced to metrics only. */
  source: "distributed" | "local" | "unavailable";
  retryAfterSeconds: number;
}

/**
 * Decide from an already-performed count. Kept pure so the policy matrix is
 * unit testable without Redis.
 */
export function decideRateLimit(input: RateLimitDecisionInput): RateLimitDecision {
  const { policy } = input;

  if (input.backendAvailable && typeof input.count === "number") {
    const allowed = input.count <= policy.limit;
    return {
      allowed,
      source: "distributed",
      retryAfterSeconds: allowed ? 0 : policy.windowSeconds,
    };
  }

  // Backend unavailable: the process-local fallback is the remaining signal.
  if (typeof input.localAllowed === "boolean") {
    if (!input.localAllowed) {
      return { allowed: false, source: "local", retryAfterSeconds: policy.windowSeconds };
    }
    return {
      allowed: policy.failureMode === "fail_open",
      source: "local",
      retryAfterSeconds: policy.failureMode === "fail_open" ? 0 : policy.windowSeconds,
    };
  }

  return {
    allowed: policy.failureMode === "fail_open",
    source: "unavailable",
    retryAfterSeconds: policy.failureMode === "fail_open" ? 0 : policy.windowSeconds,
  };
}
