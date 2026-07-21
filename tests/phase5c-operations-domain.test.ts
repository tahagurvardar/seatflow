import { describe, expect, it } from "vitest";

import {
  buildContentSecurityPolicy,
  buildSecurityHeaders,
  isLoopbackOrigin,
  isSensitivePath,
  toWebSocketOrigin,
  type SecurityHeaderOptions,
} from "../src/features/security/security-headers";
import {
  decideReadiness,
  evaluateBacklog,
  evaluateDeadLetters,
  evaluateWorkerHeartbeat,
  readinessHttpStatus,
  redisRequiredForRole,
  workerLabelToCheckStatus,
  type ReadinessCheck,
} from "../src/features/operations/health";
import {
  classifyRouteGroup,
  getMetricsRegistry,
  outcomeClassFromStatus,
  ROUTE_GROUPS,
} from "../src/server/observability/metrics-registry";
import {
  normalizeInstanceLabel,
  normalizeVersion,
} from "../src/server/operations/worker-heartbeat";

const baseHeaderOptions: SecurityHeaderOptions = {
  nonce: "dGVzdC1ub25jZS12YWx1ZQ==",
  isDevelopment: false,
  isHttps: true,
  hstsMaxAgeSeconds: 31_536_000,
  realtimeOrigin: "https://realtime.seatflow.example",
};

function directive(policy: string, name: string) {
  return policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));
}

describe("security headers", () => {
  it("gates scripts behind the per-request nonce", () => {
    const policy = buildContentSecurityPolicy(baseHeaderOptions);
    expect(directive(policy, "script-src")).toContain(`'nonce-${baseHeaderOptions.nonce}'`);
    expect(directive(policy, "script-src")).toContain("'strict-dynamic'");
    expect(directive(policy, "script-src")).not.toContain("'unsafe-inline'");
  });

  it("adds unsafe-eval only in development", () => {
    expect(buildContentSecurityPolicy({ ...baseHeaderOptions, isDevelopment: true })).toContain(
      "'unsafe-eval'",
    );
    expect(buildContentSecurityPolicy(baseHeaderOptions)).not.toContain("'unsafe-eval'");
  });

  it("keeps the application's real features working", () => {
    const policy = buildContentSecurityPolicy(baseHeaderOptions);
    // Seat-map inline style attributes.
    expect(directive(policy, "style-src")).toContain("'unsafe-inline'");
    // QR data URIs and PDF blob downloads.
    expect(directive(policy, "img-src")).toContain("data:");
    expect(directive(policy, "img-src")).toContain("blob:");
    // Camera stream for the scanner.
    expect(directive(policy, "media-src")).toContain("blob:");
    // Socket.IO gateway over both HTTP polling and WebSocket upgrade.
    expect(directive(policy, "connect-src")).toContain("https://realtime.seatflow.example");
    expect(directive(policy, "connect-src")).toContain("wss://realtime.seatflow.example");
  });

  it("locks down framing, plugins, and base URI", () => {
    const policy = buildContentSecurityPolicy(baseHeaderOptions);
    expect(directive(policy, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(policy, "object-src")).toBe("object-src 'none'");
    expect(directive(policy, "base-uri")).toBe("base-uri 'self'");
    expect(directive(policy, "form-action")).toBe("form-action 'self'");
  });

  it("upgrades insecure requests only outside development", () => {
    expect(buildContentSecurityPolicy(baseHeaderOptions)).toContain("upgrade-insecure-requests");
    expect(
      buildContentSecurityPolicy({ ...baseHeaderOptions, isDevelopment: true }),
    ).not.toContain("upgrade-insecure-requests");
  });

  it("ignores an unparseable realtime origin instead of injecting it", () => {
    const policy = buildContentSecurityPolicy({
      ...baseHeaderOptions,
      realtimeOrigin: "not a url; script-src 'unsafe-inline'",
    });
    expect(policy).not.toContain("not a url");
    expect(directive(policy, "connect-src")).toBe("connect-src 'self'");
    // The only 'unsafe-inline' in the policy is the deliberate style-src one.
    expect(policy.match(/'unsafe-inline'/g)).toHaveLength(1);
  });

  it("derives WebSocket origins", () => {
    expect(toWebSocketOrigin("https://a.example")).toBe("wss://a.example");
    expect(toWebSocketOrigin("http://localhost:3001")).toBe("ws://localhost:3001");
    expect(toWebSocketOrigin("nonsense")).toBeNull();
  });

  it("recognizes every loopback gateway form", () => {
    for (const origin of [
      "http://localhost:3001",
      "http://127.0.0.1:3001",
      "http://[::1]:3001",
      "http://0.0.0.0:3001",
      "http://dev.local:3001",
      "http://app.localhost:3001",
    ]) {
      expect(isLoopbackOrigin(origin)).toBe(true);
    }
    expect(isLoopbackOrigin("https://realtime.seatflow.example")).toBe(false);
    expect(isLoopbackOrigin("not a url")).toBe(false);
  });

  it("permits the local realtime gateway in development", () => {
    // Local development may still point connect-src at the loopback gateway.
    const policy = buildContentSecurityPolicy({
      ...baseHeaderOptions,
      isDevelopment: true,
      realtimeOrigin: "http://localhost:3001",
    });
    expect(directive(policy, "connect-src")).toContain("http://localhost:3001");
    expect(directive(policy, "connect-src")).toContain("ws://localhost:3001");
  });

  it("never emits a loopback origin in a staging or production CSP", () => {
    // The staging first deployment shipped `connect-src 'self' http://localhost:3001
    // ws://localhost:3001` because a build inlined a loopback NEXT_PUBLIC_REALTIME_URL.
    // Outside development the loopback origin must be dropped entirely.
    for (const realtimeOrigin of [
      "http://localhost:3001",
      "http://127.0.0.1:3001",
      "http://[::1]:3001",
      "http://dev.local:3001",
    ]) {
      const policy = buildContentSecurityPolicy({
        ...baseHeaderOptions,
        isDevelopment: false,
        realtimeOrigin,
      });
      const connect = directive(policy, "connect-src")!;
      // Polling fallback needs only same-origin.
      expect(connect).toBe("connect-src 'self'");
      for (const forbidden of ["localhost", "127.0.0.1", "::1", ".local", "ws://", "http://"]) {
        expect(policy).not.toContain(forbidden);
      }
    }
  });

  it("still emits a real hosted gateway origin in production", () => {
    // Only loopback is dropped; a genuine remote gateway keeps working.
    const policy = buildContentSecurityPolicy({
      ...baseHeaderOptions,
      isDevelopment: false,
      realtimeOrigin: "https://realtime.seatflow.example",
    });
    expect(directive(policy, "connect-src")).toContain("https://realtime.seatflow.example");
    expect(directive(policy, "connect-src")).toContain("wss://realtime.seatflow.example");
  });

  it("uses only 'self' for connect-src when no gateway is configured (polling fallback)", () => {
    const policy = buildContentSecurityPolicy({
      ...baseHeaderOptions,
      isDevelopment: false,
      realtimeOrigin: null,
    });
    expect(directive(policy, "connect-src")).toBe("connect-src 'self'");
  });

  it("sends HSTS only over HTTPS", () => {
    expect(buildSecurityHeaders(baseHeaderOptions)["Strict-Transport-Security"]).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(
      buildSecurityHeaders({ ...baseHeaderOptions, isHttps: false })["Strict-Transport-Security"],
    ).toBeUndefined();
    expect(
      buildSecurityHeaders({ ...baseHeaderOptions, hstsMaxAgeSeconds: 0 })[
        "Strict-Transport-Security"
      ],
    ).toBeUndefined();
  });

  it("permits the camera on this origin and denies unused capabilities", () => {
    const permissions = buildSecurityHeaders(baseHeaderOptions)["Permissions-Policy"]!;
    expect(permissions).toContain("camera=(self)");
    expect(permissions).toContain("microphone=()");
    expect(permissions).toContain("geolocation=()");
  });

  it("sets the remaining hardening headers", () => {
    const headers = buildSecurityHeaders(baseHeaderOptions);
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Cross-Origin-Resource-Policy"]).toBe("same-site");
  });

  it("classifies ticket, payment, booking, and health paths as sensitive", () => {
    for (const path of [
      "/api/tickets/abc/qr",
      "/api/payments/webhooks/local-signed",
      "/api/operations/metrics",
      "/api/health/ready",
      "/customer/bookings",
      "/organizer/dashboard",
      "/admin",
    ]) {
      expect(isSensitivePath(path), path).toBe(true);
    }
    for (const path of ["/", "/events", "/events/summer-fest", "/login"]) {
      expect(isSensitivePath(path), path).toBe(false);
    }
  });
});

describe("health and readiness decisions", () => {
  const check = (status: ReadinessCheck["status"]): ReadinessCheck => ({ name: "x", status });

  it("treats any failure as not ready and any warning as degraded", () => {
    expect(decideReadiness([check("pass"), check("pass")])).toBe("ready");
    expect(decideReadiness([check("pass"), check("warn")])).toBe("degraded");
    expect(decideReadiness([check("warn"), check("fail")])).toBe("not_ready");
    expect(decideReadiness([])).toBe("ready");
  });

  it("keeps a degraded instance in rotation and removes a failed one", () => {
    expect(readinessHttpStatus("ready")).toBe(200);
    expect(readinessHttpStatus("degraded")).toBe(200);
    expect(readinessHttpStatus("not_ready")).toBe(503);
  });

  it("requires Redis for workers but not for the web tier", () => {
    expect(redisRequiredForRole("web")).toBe(false);
    for (const role of [
      "inventory_dispatcher",
      "hold_expiry_worker",
      "realtime_gateway",
      "ticket_issuance_dispatcher",
      "notification_dispatcher",
      "payment_reconciliation",
    ] as const) {
      expect(redisRequiredForRole(role), role).toBe(true);
    }
  });

  it("warns rather than fails on backlog so a draining queue keeps its workers", () => {
    const thresholds = { maximumBacklog: 100, maximumAgeSeconds: 300 };
    expect(evaluateBacklog({ backlog: 10, oldestAgeSeconds: 30 }, thresholds)).toBe("pass");
    expect(evaluateBacklog({ backlog: 101, oldestAgeSeconds: 30 }, thresholds)).toBe("warn");
    expect(evaluateBacklog({ backlog: 10, oldestAgeSeconds: 301 }, thresholds)).toBe("warn");
  });

  it("flags any dead letter", () => {
    expect(evaluateDeadLetters(0)).toBe("pass");
    expect(evaluateDeadLetters(1)).toBe("warn");
  });
});

describe("worker heartbeat staleness", () => {
  const now = new Date("2026-07-19T12:00:00.000Z");
  const heartbeat = (overrides: Partial<Parameters<typeof evaluateWorkerHeartbeat>[0]["heartbeat"]> = {}) => ({
    workerType: "INVENTORY_OUTBOX_DISPATCHER",
    environment: "production",
    status: "HEALTHY" as const,
    version: null,
    lastSeenAt: new Date(now.getTime() - 10_000),
    ...overrides,
  });

  it("reports a missing worker distinctly from a stale one", () => {
    expect(
      evaluateWorkerHeartbeat({ heartbeat: null, now, staleAfterSeconds: 180 }),
    ).toEqual({ label: "missing", ageSeconds: null });

    expect(
      evaluateWorkerHeartbeat({
        heartbeat: heartbeat({ lastSeenAt: new Date(now.getTime() - 600_000) }),
        now,
        staleAfterSeconds: 180,
      }),
    ).toEqual({ label: "stale", ageSeconds: 600 });
  });

  it("treats a fresh healthy beat as healthy", () => {
    expect(
      evaluateWorkerHeartbeat({ heartbeat: heartbeat(), now, staleAfterSeconds: 180 }),
    ).toEqual({ label: "healthy", ageSeconds: 10 });
  });

  it("distinguishes a planned shutdown from a crash regardless of age", () => {
    expect(
      evaluateWorkerHeartbeat({
        heartbeat: heartbeat({
          status: "STOPPED",
          lastSeenAt: new Date(now.getTime() - 86_400_000),
        }),
        now,
        staleAfterSeconds: 180,
      }).label,
    ).toBe("stopped");
  });

  it("prefers staleness over a self-reported degraded status", () => {
    expect(
      evaluateWorkerHeartbeat({
        heartbeat: heartbeat({
          status: "DEGRADED",
          lastSeenAt: new Date(now.getTime() - 600_000),
        }),
        now,
        staleAfterSeconds: 180,
      }).label,
    ).toBe("stale");

    expect(
      evaluateWorkerHeartbeat({
        heartbeat: heartbeat({ status: "DEGRADED" }),
        now,
        staleAfterSeconds: 180,
      }).label,
    ).toBe("degraded");
  });

  it("never reports a negative age from clock skew", () => {
    expect(
      evaluateWorkerHeartbeat({
        heartbeat: heartbeat({ lastSeenAt: new Date(now.getTime() + 60_000) }),
        now,
        staleAfterSeconds: 180,
      }).ageSeconds,
    ).toBe(0);
  });

  it("maps every worker label onto a check status without failing readiness", () => {
    expect(workerLabelToCheckStatus("healthy")).toBe("pass");
    for (const label of ["degraded", "stale", "stopped", "missing"] as const) {
      expect(workerLabelToCheckStatus(label), label).toBe("warn");
    }
  });

  it("normalizes operator labels and versions to the stored grammar", () => {
    expect(normalizeInstanceLabel("dispatcher-1")).toBe("dispatcher-1");
    expect(normalizeInstanceLabel(undefined)).toBe("default");
    expect(normalizeInstanceLabel("host name/with spaces")).toBe("hostnamewithspaces");
    expect(normalizeInstanceLabel("x".repeat(200))).toHaveLength(64);
    expect(normalizeVersion("1.4.2+build.7")).toBe("1.4.2+build.7");
    expect(normalizeVersion(null)).toBeNull();
  });
});

describe("metrics label bounding", () => {
  it("collapses identifier-bearing paths into a closed set of groups", () => {
    expect(classifyRouteGroup("/events/summer-fest-2026/sessions/abc123/seats")).toBe(
      "public_events",
    );
    expect(classifyRouteGroup("/events/winter-gala-2027/sessions/def456/seats")).toBe(
      "public_events",
    );
    expect(classifyRouteGroup("/api/tickets/TICKETREF/qr")).toBe("api_tickets");
    expect(classifyRouteGroup("/api/payments/webhooks/local-signed")).toBe("api_payments");
    expect(classifyRouteGroup("/api/operations/metrics")).toBe("api_operations");
    expect(classifyRouteGroup("/api/health/ready")).toBe("health");
    expect(classifyRouteGroup("/customer/bookings/BOOKINGREF")).toBe("customer");
    expect(classifyRouteGroup("/login")).toBe("auth");
    expect(classifyRouteGroup("relative-path")).toBe("other");
  });

  it("only ever produces a label from the closed set", () => {
    for (const path of [
      "/",
      "/events/x",
      "/customer/tickets/abc",
      "/organizer/organizations/org/events",
      "/venue-operator/dashboard",
      "/admin",
      "/api/auth/session",
      "/nonsense/deep/path",
    ]) {
      expect(ROUTE_GROUPS).toContain(classifyRouteGroup(path));
    }
  });

  it("buckets HTTP status codes into four outcome classes", () => {
    expect(outcomeClassFromStatus(200)).toBe("2xx");
    expect(outcomeClassFromStatus(302)).toBe("3xx");
    expect(outcomeClassFromStatus(429)).toBe("4xx");
    expect(outcomeClassFromStatus(503)).toBe("5xx");
  });

  it("rejects an unknown rate-limit policy name instead of growing the label set", () => {
    const registry = getMetricsRegistry();
    registry.reset();
    registry.recordRateLimitRejection("checkout.create");
    registry.recordRateLimitRejection("attacker-supplied-label");
    registry.recordRateLimitRejection("attacker-supplied-label");

    const snapshot = registry.snapshot();
    expect(snapshot.rateLimitRejections).toEqual({
      "checkout.create": 1,
      unclassified: 2,
    });
    registry.reset();
  });

  it("aggregates request counts, outcome classes, and latency percentiles", () => {
    const registry = getMetricsRegistry();
    registry.reset();
    for (const durationMs of [5, 10, 20, 40, 900]) {
      registry.recordRequest({ group: "api_tickets", outcomeClass: "2xx", durationMs });
    }
    registry.recordRequest({ group: "api_tickets", outcomeClass: "5xx", durationMs: 12 });

    const snapshot = registry.snapshot();
    const route = snapshot.routes.find((entry) => entry.group === "api_tickets")!;
    expect(route.requestCount).toBe(6);
    expect(route.outcomes["2xx"]).toBe(5);
    expect(route.outcomes["5xx"]).toBe(1);
    expect(route.durationMs.maxMs).toBe(900);
    expect(route.durationMs.p95Ms).toBeGreaterThanOrEqual(route.durationMs.p50Ms!);
    expect(snapshot.totals.requestCount).toBe(6);
    registry.reset();
  });
});
