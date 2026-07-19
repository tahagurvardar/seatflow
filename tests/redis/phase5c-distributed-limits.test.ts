import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { readInventoryEventEnvironment } from "../../src/env/schema";
import { createRedisConnection, ensureRedisConnected } from "../../src/lib/redis";
import { getRateLimitPolicy } from "../../src/features/security/rate-limit-policy";
import { buildRateLimitKey, buildRateLimitSubject } from "../../src/server/security/client-key";
import {
  checkDistributedRateLimitAvailable,
  enforceRateLimit,
  resetRateLimiterRedis,
} from "../../src/server/security/rate-limit";
import { resetRateLimitBuckets } from "../../src/server/realtime/request-rate-limit";
import type { Redis } from "ioredis";

/**
 * Real-Redis verification of the distributed limiter.
 *
 * These tests require a live Redis endpoint and never substitute a mock: the
 * whole point is to prove the Lua increment is atomic and that one budget is
 * genuinely shared, which an in-memory fake cannot demonstrate.
 */

const environment = readInventoryEventEnvironment();
let redis: Redis;

/** Remove only this suite's keys; never flush the database. */
async function clearLimiterKeys() {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(
      cursor,
      "MATCH",
      `${environment.REDIS_STREAM_PREFIX}:ratelimit:*`,
      "COUNT",
      200,
    );
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== "0");
}

function headers(values: Record<string, string> = {}) {
  return new Headers(values);
}

beforeAll(async () => {
  redis = createRedisConnection({ environment, connectionName: "phase5c-limit-test" });
  await ensureRedisConnected(redis);
});

afterEach(async () => {
  await clearLimiterKeys();
  resetRateLimitBuckets();
  await resetRateLimiterRedis();
});

afterAll(async () => {
  await redis.quit().catch(() => redis.disconnect());
});

describe("Phase 5C1 distributed rate limiting", () => {
  it("shares one budget across calls and rejects beyond the limit", async () => {
    const policy = getRateLimitPolicy("ticket.pdf_grant");
    const subjectId = `limit-user-${Date.now()}`;

    const decisions = [];
    for (let attempt = 0; attempt < policy.limit + 2; attempt += 1) {
      decisions.push(
        await enforceRateLimit({
          policyName: "ticket.pdf_grant",
          headers: headers(),
          subjectId,
        }),
      );
    }

    const allowed = decisions.filter((decision) => decision.allowed).length;
    expect(allowed).toBe(policy.limit);
    expect(decisions.every((decision) => decision.source === "distributed")).toBe(true);
    expect(decisions.at(-1)).toMatchObject({ allowed: false, source: "distributed" });
    expect(decisions.at(-1)!.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("enforces the limit exactly once under concurrent consumption", async () => {
    const policy = getRateLimitPolicy("ticket.pdf_grant");
    const subjectId = `concurrent-user-${Date.now()}`;
    const attempts = policy.limit + 15;

    // Fire every request simultaneously. Without an atomic INCR several callers
    // would read the same count and all be admitted.
    const decisions = await Promise.all(
      Array.from({ length: attempts }, () =>
        enforceRateLimit({
          policyName: "ticket.pdf_grant",
          headers: headers(),
          subjectId,
        }),
      ),
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(policy.limit);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(attempts - policy.limit);
  });

  it("keeps separate subjects on separate budgets", async () => {
    const first = await enforceRateLimit({
      policyName: "ticket.pdf_grant",
      headers: headers(),
      subjectId: "subject-a",
    });
    const second = await enforceRateLimit({
      policyName: "ticket.pdf_grant",
      headers: headers(),
      subjectId: "subject-b",
    });
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
  });

  it("writes environment-scoped keys with a bounded TTL and no raw identifier", async () => {
    const subjectId = "ttl-user@example.com";
    await enforceRateLimit({
      policyName: "ticket.pdf_grant",
      headers: headers(),
      subjectId,
    });

    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await redis.scan(
        cursor,
        "MATCH",
        `${environment.REDIS_STREAM_PREFIX}:ratelimit:*`,
        "COUNT",
        200,
      );
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");

    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.startsWith(`${environment.REDIS_STREAM_PREFIX}:ratelimit:`)).toBe(true);
      // The subject must be hashed: no email, address, or token in the key space.
      expect(key).not.toContain("ttl-user");
      expect(key).not.toContain("@example.com");

      const ttl = await redis.pttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(
        getRateLimitPolicy("ticket.pdf_grant").windowSeconds * 1_000,
      );
    }
  });

  it("reports distributed protection as available when Redis answers", async () => {
    expect(await checkDistributedRateLimitAvailable()).toBe(true);
  });

  it("falls back to the process-local limiter when Redis is unreachable", async () => {
    const previous = process.env.REDIS_URL;
    process.env.REDIS_URL = "redis://127.0.0.1:6399";
    await resetRateLimiterRedis();
    try {
      const decision = await enforceRateLimit({
        policyName: "ticket.pdf_grant",
        headers: headers(),
        subjectId: "outage-user",
      });
      // Fail-open policy: still allowed, but the source proves the distributed
      // backend was not consulted.
      expect(decision.allowed).toBe(true);
      expect(decision.source).toBe("local");
      expect(await checkDistributedRateLimitAvailable()).toBe(false);
    } finally {
      if (previous) process.env.REDIS_URL = previous;
      else delete process.env.REDIS_URL;
      await resetRateLimiterRedis();
    }
  });

  it("still bounds abuse locally during a Redis outage", async () => {
    const previous = process.env.REDIS_URL;
    process.env.REDIS_URL = "redis://127.0.0.1:6399";
    await resetRateLimiterRedis();
    resetRateLimitBuckets();
    try {
      const policy = getRateLimitPolicy("ticket.pdf_grant");
      const decisions = [];
      for (let attempt = 0; attempt < policy.limit + 3; attempt += 1) {
        decisions.push(
          await enforceRateLimit({
            policyName: "ticket.pdf_grant",
            headers: headers(),
            subjectId: "outage-bounded-user",
          }),
        );
      }
      // The local fallback rejection is honoured even for a fail-open policy:
      // fail-open covers "cannot count", not "counted and exceeded".
      expect(decisions.some((decision) => !decision.allowed)).toBe(true);
      expect(decisions.filter((decision) => decision.allowed)).toHaveLength(policy.limit);
    } finally {
      if (previous) process.env.REDIS_URL = previous;
      else delete process.env.REDIS_URL;
      await resetRateLimiterRedis();
    }
  });

  it("does not let a forged X-Forwarded-For reset a limiter bucket", async () => {
    // TRUSTED_PROXY_MODE defaults to none in the test environment, so forwarding
    // headers must be ignored entirely and every request must land in the same
    // authenticated-subject bucket.
    const subjectId = `spoof-user-${Date.now()}`;
    const policy = getRateLimitPolicy("ticket.pdf_grant");

    const decisions = [];
    for (let attempt = 0; attempt < policy.limit + 3; attempt += 1) {
      decisions.push(
        await enforceRateLimit({
          policyName: "ticket.pdf_grant",
          // A different forged client address on every single request.
          headers: headers({ "x-forwarded-for": `203.0.113.${attempt % 200}` }),
          subjectId,
        }),
      );
    }

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(policy.limit);
    expect(decisions.at(-1)!.allowed).toBe(false);
  });

  it("never places a raw address or credential in a constructed key", () => {
    const policy = getRateLimitPolicy("checkout.create");
    const subject = buildRateLimitSubject({
      policy,
      subjectId: "user-secret-id",
      address: "203.0.113.9",
      environment: "test",
      secret: "phase-5c-integration-secret-0000000000000000",
    })!;
    const key = buildRateLimitKey({
      prefix: environment.REDIS_STREAM_PREFIX,
      policyName: policy.name,
      subject,
    });
    expect(key).not.toContain("user-secret-id");
    expect(key).not.toContain("203.0.113.9");
    expect(key.startsWith(`${environment.REDIS_STREAM_PREFIX}:ratelimit:checkout.create:`)).toBe(
      true,
    );
  });
});
