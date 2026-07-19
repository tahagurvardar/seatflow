import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client";
import { createDatabaseClient } from "../../src/lib/database";
import { evaluateWorkerHeartbeat } from "../../src/features/operations/health";
import { Logger, type LogRecord } from "../../src/server/observability/logger";
import { collectOperationalMetrics } from "../../src/server/operations/metrics";
import { evaluateReadiness } from "../../src/server/operations/readiness";
import { resetRateLimiterRedis } from "../../src/server/security/rate-limit";
import {
  evaluateWorkerFleet,
  normalizeInstanceLabel,
  recordWorkerHeartbeat,
} from "../../src/server/operations/worker-heartbeat";
import { acquireSeatHold } from "../../src/server/holds/hold-service";
import {
  createRedisInventoryFixture,
  createRedisTestCustomer,
} from "../redis/inventory-fixture";
import { resetIntegrationDatabase } from "./reset-database";

let database: PrismaClient;

beforeEach(async () => {
  database = createDatabaseClient();
  await resetIntegrationDatabase(database);
});

afterEach(async () => {
  await database.$disconnect();
});

describe("Phase 5C1 worker heartbeats", () => {
  it("records and updates a heartbeat without leaking host details", async () => {
    await recordWorkerHeartbeat(database, {
      workerType: "INVENTORY_OUTBOX_DISPATCHER",
      status: "STARTING",
      instanceLabel: "dispatcher-1",
      version: "1.4.2",
    });

    const created = await database.workerHeartbeat.findFirstOrThrow({
      where: { workerType: "INVENTORY_OUTBOX_DISPATCHER" },
    });
    expect(created.status).toBe("STARTING");
    expect(created.instanceLabel).toBe("dispatcher-1");
    expect(created.version).toBe("1.4.2");

    // The stored row must contain only operational metadata.
    const columns = Object.keys(created);
    for (const forbidden of ["host", "hostname", "address", "ip", "command", "secret", "url"]) {
      expect(columns.some((column) => column.toLowerCase().includes(forbidden))).toBe(false);
    }

    await recordWorkerHeartbeat(database, {
      workerType: "INVENTORY_OUTBOX_DISPATCHER",
      status: "HEALTHY",
      instanceLabel: "dispatcher-1",
      lastRunDurationMs: 42,
    });

    const updated = await database.workerHeartbeat.findFirstOrThrow({
      where: { workerType: "INVENTORY_OUTBOX_DISPATCHER" },
    });
    expect(updated.status).toBe("HEALTHY");
    expect(updated.lastRunDurationMs).toBe(42);
    expect(updated.lastSeenAt.getTime()).toBeGreaterThanOrEqual(created.lastSeenAt.getTime());
    // One row per (type, environment, instance) — a restart must not accumulate.
    expect(await database.workerHeartbeat.count()).toBe(1);
  });

  it("keeps separate instances of the same worker type distinct", async () => {
    for (const label of ["dispatcher-1", "dispatcher-2"]) {
      await recordWorkerHeartbeat(database, {
        workerType: "NOTIFICATION_DISPATCHER",
        status: "HEALTHY",
        instanceLabel: label,
      });
    }
    expect(await database.workerHeartbeat.count()).toBe(2);
  });

  it("detects a stale instance and reports it through the fleet view", async () => {
    const stale = new Date(Date.now() - 3_600_000);
    await recordWorkerHeartbeat(database, {
      workerType: "REALTIME_GATEWAY",
      status: "HEALTHY",
      instanceLabel: "gateway-1",
      startedAt: stale,
      now: stale,
    });

    const fleet = await evaluateWorkerFleet(database, { staleAfterSeconds: 180 });
    const gateway = fleet.find((worker) => worker.workerType === "REALTIME_GATEWAY")!;
    expect(gateway.label).toBe("stale");
    expect(gateway.ageSeconds).toBeGreaterThan(180);

    // Every expected worker type is reported, including ones never seen.
    expect(fleet).toHaveLength(6);
    const missing = fleet.filter((worker) => worker.label === "missing");
    expect(missing.length).toBe(5);
  });

  it("classifies a deliberate shutdown as stopped rather than crashed", async () => {
    const long = new Date(Date.now() - 7_200_000);
    await recordWorkerHeartbeat(database, {
      workerType: "HOLD_EXPIRY_WORKER",
      status: "STOPPED",
      instanceLabel: "worker-1",
      startedAt: long,
      now: long,
    });
    const row = await database.workerHeartbeat.findFirstOrThrow({
      where: { workerType: "HOLD_EXPIRY_WORKER" },
    });
    expect(
      evaluateWorkerHeartbeat({
        heartbeat: row,
        now: new Date(),
        staleAfterSeconds: 180,
      }).label,
    ).toBe("stopped");
  });

  it("rejects an instance label that violates the stored grammar", async () => {
    // The application normalizes before writing, so the database never sees it.
    expect(normalizeInstanceLabel("bad label/with spaces")).toBe("badlabelwithspaces");

    await expect(
      database.workerHeartbeat.create({
        data: {
          workerType: "PAYMENT_RECONCILIATION",
          environment: "test",
          instanceLabel: "bad label",
          status: "HEALTHY",
          startedAt: new Date(),
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects a heartbeat whose last-seen precedes its start", async () => {
    const now = new Date();
    await expect(
      database.workerHeartbeat.create({
        data: {
          workerType: "PAYMENT_RECONCILIATION",
          environment: "test",
          instanceLabel: "reconciler-1",
          status: "HEALTHY",
          startedAt: now,
          lastSeenAt: new Date(now.getTime() - 60_000),
          updatedAt: now,
        },
      }),
    ).rejects.toThrow();
  });
});

describe("Phase 5C1 readiness", () => {
  /**
   * Provider configuration is supplied explicitly rather than inherited from the
   * developer machine, so these assertions describe the code under test and not
   * whichever .env happens to be present.
   */
  const providerEnvironment = {
    PAYMENT_PROVIDER: "LOCAL_SIGNED",
    LOCAL_PAYMENT_WEBHOOK_SECRET: "phase-5c-readiness-webhook-secret-00000000",
    NOTIFICATION_PROVIDER: "LOCAL_FILE",
    LOCAL_EMAIL_CAPTURE_DIR: "tmp/seatflow-mail",
    TICKET_CREDENTIAL_SECRET: "phase-5c-readiness-ticket-secret-000000000",
  } as const;
  let restoreProviderEnvironment: Array<[string, string | undefined]> = [];

  beforeEach(() => {
    restoreProviderEnvironment = Object.entries(providerEnvironment).map(([key, value]) => {
      const previous = process.env[key];
      process.env[key] = value;
      return [key, previous] as [string, string | undefined];
    });
  });

  afterEach(() => {
    for (const [key, previous] of restoreProviderEnvironment) {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it("reports every dependency healthy and only warns about absent workers", async () => {
    const report = await evaluateReadiness(database);

    expect(report.checks.find((check) => check.name === "postgresql")!.status).toBe("pass");
    expect(report.checks.find((check) => check.name === "migrations")!.status).toBe("pass");
    expect(report.checks.find((check) => check.name === "outbox_backlog")!.status).toBe("pass");
    expect(report.checks.find((check) => check.name === "payment_provider")!.status).toBe("pass");
    expect(report.checks.find((check) => check.name === "notification_provider")!.status).toBe(
      "pass",
    );
    expect(report.checks.find((check) => check.name === "ticket_credential")!.status).toBe("pass");
    // Workers have never reported in a fresh database, so readiness is degraded
    // rather than failed: the web tier can still serve.
    expect(report.checks.some((check) => check.status === "fail")).toBe(false);
    expect(report.status).toBe("degraded");
  });

  it("fails readiness when provider configuration is absent", async () => {
    delete process.env.PAYMENT_PROVIDER;
    delete process.env.NOTIFICATION_PROVIDER;

    const report = await evaluateReadiness(database);
    expect(report.checks.find((check) => check.name === "payment_provider")).toMatchObject({
      status: "fail",
      detail: "invalid_configuration",
    });
    expect(report.checks.find((check) => check.name === "notification_provider")).toMatchObject({
      status: "fail",
      detail: "invalid_configuration",
    });
    expect(report.status).toBe("not_ready");
  });

  it("never exposes a URL, credential, hostname, or stack trace", async () => {
    const report = await evaluateReadiness(database);
    const serialized = JSON.stringify(report);

    for (const forbidden of [
      "postgresql://",
      "postgres://",
      "redis://",
      "rediss://",
      "localhost",
      "127.0.0.1",
      "password",
      "secret",
      "at Object.",
      "node_modules",
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    // Check names and details are bounded labels only.
    for (const check of report.checks) {
      expect(check.name).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
      if (check.detail) expect(check.detail).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    }
  });

  it("fails readiness when PostgreSQL is unreachable, without throwing", async () => {
    const offline = createDatabaseClient(
      "postgresql://seatflow:seatflow@127.0.0.1:5599/seatflow_test",
    );
    try {
      const report = await evaluateReadiness(offline);
      expect(report.status).toBe("not_ready");
      expect(report.checks.find((check) => check.name === "postgresql")).toMatchObject({
        status: "fail",
        detail: "unreachable",
      });
    } finally {
      await offline.$disconnect().catch(() => undefined);
    }
  });

  it("degrades rather than failing the web role when Redis is unreachable", async () => {
    const previous = process.env.REDIS_URL;
    process.env.REDIS_URL = "redis://127.0.0.1:6399";
    await resetRateLimiterRedis();
    try {
      const report = await evaluateReadiness(database, { role: "web" });
      const redis = report.checks.find((check) => check.name === "redis")!;
      expect(redis.status).toBe("warn");
      expect(report.checks.some((check) => check.status === "fail")).toBe(false);

      // A Redis-dependent worker role must fail instead.
      const worker = await evaluateReadiness(database, { role: "inventory_dispatcher" });
      expect(worker.checks.find((check) => check.name === "redis")!.status).toBe("fail");
      expect(worker.status).toBe("not_ready");
    } finally {
      if (previous) process.env.REDIS_URL = previous;
      else delete process.env.REDIS_URL;
      await resetRateLimiterRedis();
    }
  });

  it("reports when distributed abuse protection has degraded", async () => {
    const previous = process.env.REDIS_URL;
    process.env.REDIS_URL = "redis://127.0.0.1:6399";
    await resetRateLimiterRedis();
    try {
      const report = await evaluateReadiness(database);
      expect(report.checks.find((check) => check.name === "distributed_rate_limit")).toMatchObject({
        status: "warn",
        detail: "process_local_only",
      });
    } finally {
      if (previous) process.env.REDIS_URL = previous;
      else delete process.env.REDIS_URL;
      await resetRateLimiterRedis();
    }
  });
});

describe("Phase 5C1 operational metrics", () => {
  it("returns bounded aggregates with no unbounded identifier labels", async () => {
    const fixture = await createRedisInventoryFixture(database, "metrics");
    const customer = await createRedisTestCustomer(database, "metrics-customer");
    await acquireSeatHold(
      database,
      { userId: customer.id },
      {
        sessionId: fixture.session.id,
        seatIds: [fixture.seatIds[0]!],
        idempotencyKey: "metrics-hold-1",
      },
    );

    const metrics = await collectOperationalMetrics(database, { staleAfterSeconds: 180 });

    expect(metrics.inventory.outboxPending).toBeGreaterThan(0);
    expect(metrics.tickets.issuancePending).toBe(0);
    expect(metrics.workers).toHaveLength(6);
    expect(typeof metrics.inventory.transactionRetryCount).toBe("string");

    const serialized = JSON.stringify(metrics);
    // No customer, session, event, or ticket identifier may appear as a label.
    expect(serialized).not.toContain(customer.id);
    expect(serialized).not.toContain(customer.email);
    expect(serialized).not.toContain(fixture.session.id);
    expect(serialized).not.toContain(fixture.seatIds[0]!);
    expect(serialized).not.toContain("@example.com");
  });

  it("counts validation outcomes by their closed enum only", async () => {
    const metrics = await collectOperationalMetrics(database, { staleAfterSeconds: 180 });
    const allowed = new Set([
      "ACCEPTED",
      "ALREADY_USED",
      "REVOKED",
      "INVALID",
      "WRONG_SESSION",
      "TOO_EARLY",
      "TOO_LATE",
      "SESSION_CANCELLED",
      "UNAUTHORIZED_SCANNER",
    ]);
    for (const key of Object.keys(metrics.validation.outcomes)) {
      expect(allowed.has(key)).toBe(true);
    }
  });
});

describe("Phase 5C1 log redaction under realistic payloads", () => {
  function capture() {
    const records: LogRecord[] = [];
    return {
      records,
      logger: new Logger({
        environment: "production",
        level: "debug",
        sink: (record) => records.push(record),
      }),
    };
  }

  it("never writes a connection string, credential, cookie, or customer email", async () => {
    const fixture = await createRedisInventoryFixture(database, "logredact");
    const customer = await createRedisTestCustomer(database, "logredact-customer");
    const { records, logger } = capture();

    logger.error("checkout failed", {
      operation: "checkout.create",
      correlationId: "abcd1234efgh5678",
      metadata: {
        // Every one of these must be dropped or scrubbed.
        databaseUrl: process.env.DATABASE_URL ?? "postgresql://u:p@h/db",
        redisUrl: process.env.REDIS_URL ?? "redis://:pw@h:6379",
        customerEmail: customer.email,
        sessionCookie: "seatflow.session_token=abc123",
        credentialHash: "a".repeat(64),
        webhookSignature: "t=1750000000,v1=deadbeefcafe",
        authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
        note: `failure for ${customer.email} on session ${fixture.session.id}`,
        seatCount: 2,
      },
      error: new Error(
        `connect ECONNREFUSED ${process.env.DATABASE_URL ?? "postgresql://u:p@h/db"}`,
      ),
    });

    const serialized = JSON.stringify(records);
    for (const forbidden of [
      "postgresql://",
      "postgres://",
      "redis://",
      "rediss://",
      customer.email,
      "seatflow.session_token",
      "Bearer abcdefghijklmnop",
      "deadbeefcafe",
      "a".repeat(64),
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    // The safe fields survive.
    const record = records[0]!;
    expect(record.metadata?.seatCount).toBe(2);
    expect(record.correlationId).toBe("abcd1234efgh5678");
    expect(record.operation).toBe("checkout.create");
    expect(record.error?.classification).toBe("internal_failure");
  });

  it("keeps a ticket public reference readable while removing its credential", async () => {
    const { records, logger } = capture();
    const publicReference = "T".repeat(32);
    logger.info("ticket validated", {
      operation: "ticket.validate",
      outcome: "accepted",
      metadata: {
        reference: publicReference,
        detail: "SFT1.abcdefghijklmnopqrstuvwxyz012345678901234",
      },
    });

    const record = records[0]!;
    expect(record.metadata?.reference).toBe(publicReference);
    expect(record.metadata?.detail).toBe("[ticket credential redacted]");
  });
});
