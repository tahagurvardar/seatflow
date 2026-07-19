import type { Redis } from "ioredis";

import {
  readApplicationEnvironment,
  readOperationsEnvironment,
  readOptionalInventoryEventEnvironment,
} from "@/env/schema";
import {
  resolveClientAddress,
  truncateAddressForLogs,
  type TrustedProxyPolicy,
} from "@/features/security/client-address";
import {
  decideRateLimit,
  getRateLimitPolicy,
  type RateLimitDecision,
  type RateLimitPolicyName,
} from "@/features/security/rate-limit-policy";
import { createRedisConnection, ensureRedisConnected } from "@/lib/redis";
import { buildRateLimitKey, buildRateLimitSubject } from "@/server/security/client-key";
import { consumeRateLimit } from "@/server/realtime/request-rate-limit";

/**
 * Distributed abuse control.
 *
 * A fixed-window counter is incremented in Redis with one atomic Lua call, so
 * concurrent requests across every web instance share one budget. When Redis is
 * unreachable the process-local limiter from Phase 4B still runs, and the
 * policy's declared failure mode decides what to do with the result.
 *
 * Redis is never consulted for correctness. It cannot grant a hold, confirm a
 * payment, issue a ticket, or accept an entry scan; losing it degrades only how
 * quickly abuse is throttled.
 */

/**
 * INCR then set the expiry on first write. Doing both in one script means a
 * crash between the two cannot leave a key without a TTL, which would otherwise
 * lock a subject out permanently.
 */
const WINDOW_INCREMENT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return current
`;

/** A limiter must never add meaningful latency to a request. */
const REDIS_OPERATION_TIMEOUT_MS = 250;

let limiterRedis: Redis | null = null;
let limiterRedisUnavailableUntil = 0;
/**
 * A single in-flight connect attempt shared by every concurrent caller.
 * Without this, a burst of simultaneous requests each attaches its own
 * `ready`/`error` listeners to the same client and trips Node's max-listener
 * warning — and leaks a listener per request while the connection is pending.
 */
let limiterConnection: Promise<void> | null = null;

/** Back off from a failing Redis so every request does not pay the timeout. */
const REDIS_COOLDOWN_MS = 5_000;

function getLimiterRedis() {
  const environment = readOptionalInventoryEventEnvironment();
  if (!environment) return null;
  if (limiterRedis) return limiterRedis;

  limiterRedis = createRedisConnection({
    environment,
    connectionName: "seatflow-rate-limit",
  });
  // A limiter connection must never crash the process on a transport error.
  limiterRedis.on("error", () => {
    limiterRedisUnavailableUntil = Date.now() + REDIS_COOLDOWN_MS;
    limiterConnection = null;
  });
  return limiterRedis;
}

/** Await the shared connect attempt, creating it only if none is in flight. */
function connectLimiter(redis: Redis) {
  if (redis.status === "ready") return Promise.resolve();
  limiterConnection ??= ensureRedisConnected(redis).finally(() => {
    limiterConnection = null;
  });
  return limiterConnection;
}

/** Test seam: drop the cached connection between suites. */
export async function resetRateLimiterRedis() {
  const existing = limiterRedis;
  limiterRedis = null;
  limiterRedisUnavailableUntil = 0;
  limiterConnection = null;
  if (existing) {
    existing.removeAllListeners("error");
    existing.disconnect();
  }
}

async function withTimeout<Result>(operation: Promise<Result>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("RATE_LIMIT_BACKEND_TIMEOUT")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function getTrustedProxyPolicy(
  environment = readOperationsEnvironment(),
): TrustedProxyPolicy {
  return {
    mode: environment.TRUSTED_PROXY_MODE,
    hopCount: environment.TRUSTED_PROXY_HOP_COUNT,
    headerName: environment.TRUSTED_PROXY_HEADER,
  };
}

export interface RateLimitResult extends RateLimitDecision {
  policyName: string;
  /** Coarsened address for diagnostics; never a full raw address. */
  addressLabel: string | null;
}

export interface EnforceRateLimitInput {
  policyName: RateLimitPolicyName;
  headers: Headers;
  subjectId?: string | null;
  directAddress?: string | null;
  now?: number;
}

/**
 * Consume one unit against a named policy.
 *
 * The returned decision is advisory to the caller, which is responsible for
 * translating a rejection into a 429. Authorization is never delegated here.
 */
export async function enforceRateLimit(
  input: EnforceRateLimitInput,
): Promise<RateLimitResult> {
  const policy = getRateLimitPolicy(input.policyName);
  const operations = readOperationsEnvironment();

  const resolved = resolveClientAddress({
    policy: getTrustedProxyPolicy(operations),
    headers: input.headers,
    directAddress: input.directAddress,
  });
  const addressLabel = truncateAddressForLogs(resolved.address);

  if (!operations.RATE_LIMIT_ENABLED) {
    return {
      allowed: true,
      source: "unavailable",
      retryAfterSeconds: 0,
      policyName: policy.name,
      addressLabel,
    };
  }

  const application = readApplicationEnvironment();
  const subject = buildRateLimitSubject({
    policy,
    subjectId: input.subjectId,
    address: resolved.address,
    environment: operations.NODE_ENV,
    secret: application.BETTER_AUTH_SECRET,
  });

  // No usable identifier: apply the failure mode rather than inventing a shared
  // bucket that one abuser could exhaust for every other caller.
  if (!subject) {
    const decision = decideRateLimit({ policy, count: null, backendAvailable: false });
    return { ...decision, policyName: policy.name, addressLabel };
  }

  const localKey = `${policy.name}:${subject}`;
  const redisEnvironment = readOptionalInventoryEventEnvironment();
  const redis =
    redisEnvironment && Date.now() >= limiterRedisUnavailableUntil ? getLimiterRedis() : null;

  if (redis && redisEnvironment) {
    try {
      const key = buildRateLimitKey({
        prefix: redisEnvironment.REDIS_STREAM_PREFIX,
        policyName: policy.name,
        subject,
      });
      const count = await withTimeout(
        (async () => {
          await connectLimiter(redis);
          return (await redis.eval(
            WINDOW_INCREMENT_SCRIPT,
            1,
            key,
            String(policy.windowSeconds * 1_000),
          )) as number;
        })(),
        REDIS_OPERATION_TIMEOUT_MS,
      );

      const decision = decideRateLimit({
        policy,
        count: Number(count),
        backendAvailable: true,
      });
      return { ...decision, policyName: policy.name, addressLabel };
    } catch {
      limiterRedisUnavailableUntil = Date.now() + REDIS_COOLDOWN_MS;
    }
  }

  // Distributed backend unavailable: consult the process-local fallback.
  const local = consumeRateLimit(localKey, {
    limit: policy.limit,
    windowMs: policy.windowSeconds * 1_000,
    now: input.now,
  });
  const decision = decideRateLimit({
    policy,
    count: null,
    backendAvailable: false,
    localAllowed: local.allowed,
  });
  return { ...decision, policyName: policy.name, addressLabel };
}

/**
 * Whether distributed protection is currently usable. Readiness reports this so
 * an operator learns that abuse control has degraded to per-process counters.
 */
export async function checkDistributedRateLimitAvailable(): Promise<boolean> {
  const environment = readOptionalInventoryEventEnvironment();
  if (!environment) return false;
  const redis = getLimiterRedis();
  if (!redis) return false;
  try {
    return await withTimeout(
      (async () => {
        await connectLimiter(redis);
        return (await redis.ping()) === "PONG";
      })(),
      REDIS_OPERATION_TIMEOUT_MS,
    );
  } catch {
    return false;
  }
}
