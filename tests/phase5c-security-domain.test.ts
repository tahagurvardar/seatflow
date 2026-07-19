import { describe, expect, it } from "vitest";

import {
  isValidIpAddress,
  isValidIpv4,
  isValidIpv6,
  MAX_FORWARDED_HOPS,
  normalizeForwardedEntry,
  parseForwardedChain,
  resolveClientAddress,
  truncateAddressForLogs,
  type TrustedProxyPolicy,
} from "../src/features/security/client-address";
import {
  decideRateLimit,
  getRateLimitPolicy,
  RATE_LIMIT_POLICIES,
} from "../src/features/security/rate-limit-policy";
import {
  buildRateLimitKey,
  buildRateLimitSubject,
  deriveClientKey,
} from "../src/server/security/client-key";

const secret = "phase-5c-rate-limit-secret-0000000000000000";

function headers(values: Record<string, string>) {
  return new Headers(values);
}

describe("IP validation", () => {
  it("accepts well-formed IPv4 and rejects malformed input", () => {
    for (const value of ["203.0.113.9", "0.0.0.0", "255.255.255.255"]) {
      expect(isValidIpv4(value), value).toBe(true);
    }
    for (const value of ["256.0.0.1", "1.2.3", "1.2.3.4.5", "01.2.3.4", "1.2.3.-4", ""]) {
      expect(isValidIpv4(value), value).toBe(false);
    }
  });

  it("accepts well-formed IPv6 including IPv4-mapped forms", () => {
    for (const value of [
      "2001:db8::1",
      "::1",
      "fe80::a00:27ff:fe4e:66a1",
      "::ffff:203.0.113.9",
      "2001:0db8:0000:0000:0000:0000:0000:0001",
    ]) {
      expect(isValidIpv6(value), value).toBe(true);
    }
    for (const value of ["2001:db8::1::2", "gggg::1", "2001:db8:::1", "not-an-ip"]) {
      expect(isValidIpv6(value), value).toBe(false);
    }
  });

  it("recognizes both families", () => {
    expect(isValidIpAddress("203.0.113.9")).toBe(true);
    expect(isValidIpAddress("2001:db8::1")).toBe(true);
    expect(isValidIpAddress("example.com")).toBe(false);
  });
});

describe("forwarded chain parsing", () => {
  it("normalizes ports and brackets", () => {
    expect(normalizeForwardedEntry(" 203.0.113.9 ")).toBe("203.0.113.9");
    expect(normalizeForwardedEntry("203.0.113.9:443")).toBe("203.0.113.9");
    expect(normalizeForwardedEntry("[2001:db8::1]:443")).toBe("2001:db8::1");
    expect(normalizeForwardedEntry("2001:DB8::1")).toBe("2001:db8::1");
  });

  it("rejects a chain containing any invalid entry rather than trusting a prefix", () => {
    expect(parseForwardedChain("203.0.113.9, 198.51.100.4")).toEqual([
      "203.0.113.9",
      "198.51.100.4",
    ]);
    expect(parseForwardedChain("203.0.113.9, evil-host")).toBeNull();
    expect(parseForwardedChain("unknown")).toBeNull();
    expect(parseForwardedChain("")).toBeNull();
    expect(parseForwardedChain(null)).toBeNull();
  });

  it("rejects oversized and header-injecting chains", () => {
    expect(parseForwardedChain(`${"203.0.113.9, ".repeat(MAX_FORWARDED_HOPS + 2)}203.0.113.9`))
      .toBeNull();
    expect(parseForwardedChain("203.0.113.9\r\nX-Admin: 1")).toBeNull();
    expect(parseForwardedChain("2".repeat(2_000))).toBeNull();
  });
});

describe("trusted-proxy resolution", () => {
  const forwarded = headers({ "x-forwarded-for": "203.0.113.9, 198.51.100.4, 198.51.100.5" });

  it("ignores forwarding headers entirely in none mode", () => {
    const policy: TrustedProxyPolicy = { mode: "none" };
    const result = resolveClientAddress({ policy, headers: forwarded });
    expect(result.address).toBeNull();
    expect(result.trusted).toBe(false);
    expect(result.reason).toBe("no_forwarding_configured");
  });

  it("uses the peer address in none mode when the runtime exposes one", () => {
    const result = resolveClientAddress({
      policy: { mode: "none" },
      headers: forwarded,
      directAddress: "192.0.2.7",
    });
    expect(result).toMatchObject({ address: "192.0.2.7", trusted: true });
  });

  it("selects the entry left of the declared trusted suffix", () => {
    expect(
      resolveClientAddress({ policy: { mode: "trusted-hop", hopCount: 1 }, headers: forwarded })
        .address,
    ).toBe("198.51.100.4");
    expect(
      resolveClientAddress({ policy: { mode: "trusted-hop", hopCount: 2 }, headers: forwarded })
        .address,
    ).toBe("203.0.113.9");
  });

  it("refuses when the chain is shorter than the declared proxy count", () => {
    const result = resolveClientAddress({
      policy: { mode: "trusted-hop", hopCount: 3 },
      headers: headers({ "x-forwarded-for": "203.0.113.9" }),
    });
    expect(result).toMatchObject({ address: null, trusted: false, reason: "insufficient_hops" });
  });

  it("does not let a spoofed prefix shift the selected entry", () => {
    // An attacker prepends values; with one trusted proxy the selected entry is
    // still the one the trusted proxy itself appended.
    const spoofed = headers({
      "x-forwarded-for": "1.1.1.1, 2.2.2.2, 203.0.113.9, 198.51.100.4",
    });
    expect(
      resolveClientAddress({ policy: { mode: "trusted-hop", hopCount: 1 }, headers: spoofed })
        .address,
    ).toBe("203.0.113.9");
  });

  it("reads exactly one platform header and rejects a list", () => {
    const policy: TrustedProxyPolicy = {
      mode: "platform-header",
      headerName: "cf-connecting-ip",
    };
    expect(
      resolveClientAddress({ policy, headers: headers({ "cf-connecting-ip": "203.0.113.9" }) }),
    ).toMatchObject({ address: "203.0.113.9", trusted: true });

    expect(
      resolveClientAddress({
        policy,
        headers: headers({ "cf-connecting-ip": "203.0.113.9, 1.1.1.1" }),
      }),
    ).toMatchObject({ address: null, reason: "malformed_chain" });

    expect(resolveClientAddress({ policy, headers: headers({}) })).toMatchObject({
      address: null,
      reason: "missing_header",
    });
  });

  it("never trusts a forwarding header the policy did not declare", () => {
    const result = resolveClientAddress({
      policy: { mode: "platform-header", headerName: "cf-connecting-ip" },
      headers: headers({ "x-forwarded-for": "203.0.113.9" }),
    });
    expect(result.address).toBeNull();
  });
});

describe("privacy-preserving diagnostics", () => {
  it("coarsens addresses for logging", () => {
    expect(truncateAddressForLogs("203.0.113.9")).toBe("203.0.113.0/24");
    expect(truncateAddressForLogs("2001:db8:1234:5678::1")).toBe("2001:db8:1234::/48");
    expect(truncateAddressForLogs(null)).toBeNull();
    expect(truncateAddressForLogs("nonsense")).toBeNull();
  });

  it("derives stable opaque client keys that do not contain the input", () => {
    const key = deriveClientKey({
      value: "203.0.113.9",
      dimension: "ip",
      environment: "production",
      secret,
    });
    expect(key).toMatch(/^[a-f0-9]{32}$/);
    expect(key).not.toContain("203.0.113.9");
    expect(
      deriveClientKey({ value: "203.0.113.9", dimension: "ip", environment: "production", secret }),
    ).toBe(key);
  });

  it("separates dimensions and environments so keys cannot be linked", () => {
    const base = { value: "203.0.113.9", secret };
    const production = deriveClientKey({ ...base, dimension: "ip", environment: "production" });
    const staging = deriveClientKey({ ...base, dimension: "ip", environment: "staging" });
    const subject = deriveClientKey({ ...base, dimension: "subject", environment: "production" });
    expect(new Set([production, staging, subject]).size).toBe(3);
  });

  it("refuses a weak derivation secret", () => {
    expect(() =>
      deriveClientKey({ value: "x", dimension: "ip", environment: "test", secret: "short" }),
    ).toThrow(/secret is invalid/i);
  });
});

describe("rate-limit subjects and keys", () => {
  const environment = "production";

  it("returns null when the policy's identifier is unavailable", () => {
    expect(
      buildRateLimitSubject({
        policy: getRateLimitPolicy("auth.login"),
        address: null,
        environment,
        secret,
      }),
    ).toBeNull();
    expect(
      buildRateLimitSubject({
        policy: getRateLimitPolicy("ticket.qr"),
        subjectId: null,
        environment,
        secret,
      }),
    ).toBeNull();
  });

  it("combines both dimensions so rotating one does not evade the limit", () => {
    const policy = getRateLimitPolicy("checkout.create");
    const both = buildRateLimitSubject({
      policy,
      subjectId: "user-1",
      address: "203.0.113.9",
      environment,
      secret,
    })!;
    const rotatedAddress = buildRateLimitSubject({
      policy,
      subjectId: "user-1",
      address: "203.0.113.10",
      environment,
      secret,
    })!;
    const rotatedUser = buildRateLimitSubject({
      policy,
      subjectId: "user-2",
      address: "203.0.113.9",
      environment,
      secret,
    })!;
    expect(both).not.toBe(rotatedAddress);
    expect(both).not.toBe(rotatedUser);
    expect(both).not.toContain("user-1");
    expect(both).not.toContain("203.0.113.9");
  });

  it("gives the global scope one shared deterministic bucket", () => {
    const policy = getRateLimitPolicy("payment.webhook");
    const first = buildRateLimitSubject({ policy, environment, secret });
    const second = buildRateLimitSubject({ policy, environment, secret });
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{32}$/);
  });

  it("builds namespaced keys and rejects injected segments", () => {
    expect(
      buildRateLimitKey({
        prefix: "seatflow:production",
        policyName: "auth.login",
        subject: "a".repeat(32),
      }),
    ).toBe(`seatflow:production:ratelimit:auth.login:${"a".repeat(32)}`);

    expect(() =>
      buildRateLimitKey({ prefix: "seatflow:production", policyName: "x", subject: "a b" }),
    ).toThrow(/segment is invalid/i);
    expect(() =>
      buildRateLimitKey({ prefix: "bad prefix", policyName: "x", subject: "a" }),
    ).toThrow(/prefix is invalid/i);
  });
});

describe("rate-limit decisions", () => {
  const policy = getRateLimitPolicy("checkout.create");

  it("allows up to the limit and rejects beyond it", () => {
    expect(decideRateLimit({ policy, count: policy.limit, backendAvailable: true })).toMatchObject({
      allowed: true,
      source: "distributed",
    });
    expect(
      decideRateLimit({ policy, count: policy.limit + 1, backendAvailable: true }),
    ).toMatchObject({ allowed: false, source: "distributed" });
  });

  it("returns a retry hint only on rejection", () => {
    expect(decideRateLimit({ policy, count: 1, backendAvailable: true }).retryAfterSeconds).toBe(0);
    expect(
      decideRateLimit({ policy, count: policy.limit + 1, backendAvailable: true })
        .retryAfterSeconds,
    ).toBe(policy.windowSeconds);
  });

  it("honours the local fallback rejection even for a fail-open policy", () => {
    expect(
      decideRateLimit({ policy, count: null, backendAvailable: false, localAllowed: false }),
    ).toMatchObject({ allowed: false, source: "local" });
  });

  it("fails open for customer and provider paths when the backend is gone", () => {
    for (const name of [
      "payment.webhook",
      "ticket.validate",
      "ticket.qr",
      "checkout.create",
      "operations.health",
    ] as const) {
      expect(
        decideRateLimit({
          policy: getRateLimitPolicy(name),
          count: null,
          backendAvailable: false,
        }).allowed,
        name,
      ).toBe(true);
    }
  });

  it("fails closed for mutating administrative operations", () => {
    expect(
      decideRateLimit({
        policy: getRateLimitPolicy("operations.admin"),
        count: null,
        backendAvailable: false,
      }),
    ).toMatchObject({ allowed: false, source: "unavailable" });
  });

  it("keeps every policy bounded and named consistently", () => {
    for (const [name, policyEntry] of Object.entries(RATE_LIMIT_POLICIES)) {
      expect(policyEntry.name, name).toBe(name);
      expect(policyEntry.limit).toBeGreaterThan(0);
      expect(policyEntry.windowSeconds).toBeGreaterThan(0);
      expect(policyEntry.windowSeconds).toBeLessThanOrEqual(3_600);
      expect(name).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    }
  });
});
