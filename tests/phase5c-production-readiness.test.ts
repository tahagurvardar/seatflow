import { describe, expect, it } from "vitest";

import {
  isWeakSecret,
  REQUIRED_WORKER_DECLARATIONS,
  summarizeFindings,
  validateProductionConfiguration,
  type EnvironmentSource,
} from "../src/features/operations/production-check";
import {
  assertDisposableRestoreTarget,
  assertSafeBackupPath,
  BackupSafetyError,
  compareRowCounts,
  databaseNameFromUrl,
  describeDatabaseTarget,
  isDisposableDatabaseName,
} from "../src/features/operations/backup-safety";
import {
  assertSafeLoadTestTarget,
  boundLoadTestParameters,
  evaluateScenario,
  isDisposableLoadTestDatabase,
  isLoopbackHost,
  LOAD_TEST_MAXIMUMS,
  LoadTestSafetyError,
  summarizeLatencies,
  type ScenarioOutcome,
} from "../src/features/operations/load-test-safety";

/** A configuration with every gate satisfied except the intentional ones. */
function productionEnvironment(overrides: EnvironmentSource = {}): EnvironmentSource {
  return {
    NODE_ENV: "production",
    PAYMENT_PROVIDER: "EXTERNAL",
    NOTIFICATION_PROVIDER: "EXTERNAL",
    TICKET_CREDENTIAL_SECRET: "Kp7wQz2NxV9bLmR4tYs6HjF8gDc3ZaXe",
    BETTER_AUTH_SECRET: "Qv4nB8kM2xW6pJr9tLzH5yGd7CfA3sUe",
    BETTER_AUTH_URL: "https://seatflow.example",
    NEXT_PUBLIC_APP_URL: "https://seatflow.example",
    NEXT_PUBLIC_REALTIME_URL: "https://realtime.seatflow.example",
    DATABASE_URL: "postgresql://app@db.internal:5432/seatflow",
    REDIS_URL: "rediss://cache.internal:6380",
    REDIS_STREAM_PREFIX: "seatflow:production",
    TRUSTED_PROXY_MODE: "platform-header",
    TRUSTED_PROXY_HEADER: "cf-connecting-ip",
    LOG_LEVEL: "info",
    SEATFLOW_DECLARED_WORKERS: REQUIRED_WORKER_DECLARATIONS.join(","),
    ...overrides,
  };
}

function findingIds(env: EnvironmentSource, probes = {}) {
  return validateProductionConfiguration({ env, probes }).map((finding) => finding.id);
}

describe("production configuration validation", () => {
  it("reduces a sanitized production configuration to the intentional provider gates", () => {
    const ids = findingIds(productionEnvironment());
    // Phase 5C1 ships no reviewed external adapter, so these two must remain
    // hard blockers. Everything else should be clean.
    expect(ids).toEqual(["payment_provider_gate", "notification_provider_gate"]);
  });

  it("rejects the development-only providers", () => {
    expect(findingIds(productionEnvironment({ PAYMENT_PROVIDER: "LOCAL_SIGNED" }))).toContain(
      "payment_provider_local",
    );
    expect(findingIds(productionEnvironment({ NOTIFICATION_PROVIDER: "LOCAL_FILE" }))).toContain(
      "notification_provider_local",
    );
  });

  it("rejects leftover local provider configuration", () => {
    expect(
      findingIds(productionEnvironment({ LOCAL_PAYMENT_WEBHOOK_SECRET: "x".repeat(40) })),
    ).toContain("local_payment_secret_present");
    expect(findingIds(productionEnvironment({ LOCAL_EMAIL_CAPTURE_DIR: "tmp/mail" }))).toContain(
      "local_capture_enabled",
    );
  });

  it("rejects weak, missing, placeholder, and reused secrets", () => {
    expect(findingIds(productionEnvironment({ TICKET_CREDENTIAL_SECRET: undefined }))).toContain(
      "ticket_secret_weak",
    );
    expect(findingIds(productionEnvironment({ TICKET_CREDENTIAL_SECRET: "short" }))).toContain(
      "ticket_secret_weak",
    );
    expect(findingIds(productionEnvironment({ BETTER_AUTH_SECRET: "a".repeat(64) }))).toContain(
      "auth_secret_weak",
    );
    expect(
      findingIds(
        productionEnvironment({ BETTER_AUTH_SECRET: "changeme-changeme-changeme-changeme" }),
      ),
    ).toContain("auth_secret_weak");

    const shared = "Kp7wQz2NxV9bLmR4tYs6HjF8gDc3ZaXe";
    expect(
      findingIds(
        productionEnvironment({ TICKET_CREDENTIAL_SECRET: shared, BETTER_AUTH_SECRET: shared }),
      ),
    ).toContain("secret_reuse");
  });

  it("classifies secret strength without exposing the value", () => {
    expect(isWeakSecret(undefined)).toBe(true);
    expect(isWeakSecret("short")).toBe(true);
    expect(isWeakSecret("a".repeat(64))).toBe(true);
    expect(isWeakSecret("placeholder-placeholder-placeholder")).toBe(true);
    expect(isWeakSecret("Kp7wQz2NxV9bLmR4tYs6HjF8gDc3ZaXe")).toBe(false);
  });

  it("never includes a secret value in any finding message", () => {
    const secret = "Sup3rSecretValue-abcdefghijklmnop";
    const findings = validateProductionConfiguration({
      env: productionEnvironment({
        TICKET_CREDENTIAL_SECRET: secret,
        BETTER_AUTH_SECRET: secret,
        DATABASE_URL: "postgresql://user:hunter2@db.internal:5432/seatflow",
      }),
    });
    const serialized = JSON.stringify(findings);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("hunter2");
  });

  it("rejects invalid database URLs and a test alias", () => {
    expect(findingIds(productionEnvironment({ DATABASE_URL: "mysql://host/db" }))).toContain(
      "database_url_invalid",
    );
    expect(findingIds(productionEnvironment({ DIRECT_URL: "not-a-url" }))).toContain(
      "direct_url_invalid",
    );
    expect(
      findingIds(
        productionEnvironment({
          TEST_DATABASE_URL: "postgresql://app@db.internal:5432/seatflow",
        }),
      ),
    ).toContain("test_database_alias");
  });

  it("rejects insecure and loopback origins", () => {
    const ids = findingIds(
      productionEnvironment({ BETTER_AUTH_URL: "http://localhost:3000" }),
    );
    expect(ids).toContain("better_auth_url_insecure");
    expect(ids).toContain("better_auth_url_loopback");
  });

  it("requires Redis and refuses a development namespace", () => {
    expect(findingIds(productionEnvironment({ REDIS_URL: undefined }))).toContain("redis_missing");
    expect(
      validateProductionConfiguration({
        env: productionEnvironment(),
        probes: { redisAvailable: false },
      }).map((finding) => finding.id),
    ).toContain("redis_unavailable");
    expect(
      findingIds(productionEnvironment({ REDIS_STREAM_PREFIX: "seatflow:development" })),
    ).toContain("redis_prefix_unsafe");
  });

  it("rejects an ambiguous trusted-proxy configuration", () => {
    expect(
      findingIds(productionEnvironment({ TRUSTED_PROXY_MODE: "platform-header", TRUSTED_PROXY_HEADER: undefined })),
    ).toContain("trusted_proxy_header_missing");
    expect(
      findingIds(
        productionEnvironment({ TRUSTED_PROXY_MODE: "trusted-hop", TRUSTED_PROXY_HEADER: "cf-connecting-ip" }),
      ),
    ).toContain("trusted_proxy_ambiguous");
    expect(
      findingIds(productionEnvironment({ TRUSTED_PROXY_MODE: "none", TRUSTED_PROXY_HEADER: undefined })),
    ).toContain("trusted_proxy_none");
  });

  it("rejects debug modes and disabled protections", () => {
    expect(findingIds(productionEnvironment({ LOG_LEVEL: "debug" }))).toContain("debug_logging");
    expect(findingIds(productionEnvironment({ NEXT_PUBLIC_DEBUG: "true" }))).toContain("debug_mode");
    expect(findingIds(productionEnvironment({ DEBUG: "seatflow:*" }))).toContain("debug_mode");
    expect(findingIds(productionEnvironment({ RATE_LIMIT_ENABLED: "false" }))).toContain(
      "rate_limit_disabled",
    );
    expect(findingIds(productionEnvironment({ SECURITY_HEADERS_ENABLED: "false" }))).toContain(
      "security_headers_disabled",
    );
  });

  it("requires every worker process to be declared", () => {
    expect(findingIds(productionEnvironment({ SEATFLOW_DECLARED_WORKERS: undefined }))).toContain(
      "workers_undeclared",
    );
    expect(
      findingIds(
        productionEnvironment({ SEATFLOW_DECLARED_WORKERS: "INVENTORY_OUTBOX_DISPATCHER" }),
      ),
    ).toContain("workers_undeclared");
  });

  it("enforces migration and backlog deployment gates from live probes", () => {
    const withProbes = (probes: Record<string, unknown>) =>
      validateProductionConfiguration({ env: productionEnvironment(), probes }).map(
        (finding) => finding.id,
      );

    expect(withProbes({ migrationsBehind: true })).toContain("migrations_behind");
    expect(withProbes({ outboxDeadLetters: 3 })).toContain("outbox_dead_letters_gate");
    expect(withProbes({ notificationDeadLetters: 1 })).toContain("notification_dead_letters_gate");
    expect(withProbes({ paidUnfulfilled: 2 })).toContain("paid_unfulfilled_gate");
    expect(withProbes({ outboxDeadLetters: 0, paidUnfulfilled: 0 })).not.toContain(
      "paid_unfulfilled_gate",
    );
  });

  it("summarizes errors separately from warnings", () => {
    const summary = summarizeFindings([
      { id: "a", severity: "error", message: "" },
      { id: "b", severity: "warning", message: "" },
    ]);
    expect(summary).toEqual({ errorCount: 1, warningCount: 1, passed: false });
    expect(summarizeFindings([{ id: "b", severity: "warning", message: "" }]).passed).toBe(true);
  });
});

describe("backup command safety guards", () => {
  const protectedUrls = [
    "postgresql://app@db.internal:5432/seatflow",
    "postgresql://app@db.internal:5432/seatflow",
  ];

  it("only accepts a database whose name is marked disposable", () => {
    for (const name of ["seatflow_verify", "seatflow-restore", "scratch_db", "seatflow_test"]) {
      expect(isDisposableDatabaseName(name), name).toBe(true);
    }
    for (const name of ["seatflow", "production", "seatflow_prod", "testing"]) {
      expect(isDisposableDatabaseName(name), name).toBe(false);
    }
  });

  it("refuses to restore over a production-shaped target", () => {
    expect(() =>
      assertDisposableRestoreTarget({
        targetUrl: "postgresql://app@db.internal:5432/seatflow",
        protectedUrls,
        confirmed: true,
      }),
    ).toThrow(BackupSafetyError);
  });

  it("refuses a target that matches a protected URL even when disposably named", () => {
    expect(() =>
      assertDisposableRestoreTarget({
        targetUrl: "postgresql://app@db.internal:5432/seatflow_verify",
        protectedUrls: ["postgresql://app@db.internal:5432/seatflow_verify"],
        confirmed: true,
      }),
    ).toThrow(/matches DATABASE_URL/i);
  });

  it("refuses an equivalent URL that resolves to the same host and database", () => {
    expect(() =>
      assertDisposableRestoreTarget({
        targetUrl: "postgresql://other:pw@db.internal:5432/seatflow_verify?sslmode=require",
        protectedUrls: ["postgresql://app@db.internal:5432/seatflow_verify"],
        confirmed: true,
      }),
    ).toThrow(/same host and database/i);
  });

  it("requires explicit confirmation", () => {
    expect(() =>
      assertDisposableRestoreTarget({
        targetUrl: "postgresql://app@db.internal:5432/seatflow_verify",
        protectedUrls,
        confirmed: false,
      }),
    ).toThrow(/--confirm/);
  });

  it("accepts a properly named, distinct, confirmed target", () => {
    expect(
      assertDisposableRestoreTarget({
        targetUrl: "postgresql://app@db.internal:5432/seatflow_verify",
        protectedUrls,
        confirmed: true,
      }),
    ).toBe("seatflow_verify");
  });

  it("rejects non-postgres and malformed targets", () => {
    for (const target of ["mysql://host/seatflow_verify", "not-a-url", "postgresql://host/"]) {
      expect(
        () => assertDisposableRestoreTarget({ targetUrl: target, protectedUrls, confirmed: true }),
        target,
      ).toThrow(BackupSafetyError);
    }
  });

  it("refuses to write a backup inside the repository", () => {
    expect(() =>
      assertSafeBackupPath("C:/repo/seatflow/backups/db.dump", "C:/repo/seatflow"),
    ).toThrow(/inside the repository/i);
    expect(() =>
      assertSafeBackupPath("C:\\repo\\seatflow\\db.dump", "C:/repo/seatflow"),
    ).toThrow(/inside the repository/i);
    expect(assertSafeBackupPath("D:/backups/db.dump", "C:/repo/seatflow")).toBe(
      "D:/backups/db.dump",
    );
  });

  it("rejects traversal and control characters in a backup path", () => {
    for (const bad of ["../../etc/x.dump", "a\nb.dump", ""]) {
      expect(() => assertSafeBackupPath(bad, "C:/repo/seatflow"), bad).toThrow(BackupSafetyError);
    }
  });

  it("describes a target without exposing credentials", () => {
    const described = describeDatabaseTarget("postgresql://app:hunter2@db.internal:5432/seatflow");
    expect(described).toBe("db.internal:5432/seatflow");
    expect(described).not.toContain("hunter2");
    expect(described).not.toContain("app");
    expect(databaseNameFromUrl("postgresql://h/seatflow_verify")).toBe("seatflow_verify");
  });

  it("compares critical row counts and flags differences", () => {
    const comparisons = compareRowCounts(
      { Booking: 10, Ticket: 20 },
      { Booking: 10, Ticket: 19 },
    );
    expect(comparisons).toEqual([
      { table: "Booking", source: 10, restored: 10, matches: true },
      { table: "Ticket", source: 20, restored: 19, matches: false },
    ]);
  });
});

describe("load-test target guards", () => {
  it("refuses to run against production", () => {
    expect(() =>
      assertSafeLoadTestTarget({
        databaseUrl: "postgresql://h/seatflow_test",
        nodeEnv: "production",
      }),
    ).toThrow(/NODE_ENV=production/);
  });

  it("requires a disposably named database", () => {
    expect(() =>
      assertSafeLoadTestTarget({ databaseUrl: "postgresql://h/seatflow", nodeEnv: "development" }),
    ).toThrow(/not marked disposable/i);
    expect(
      assertSafeLoadTestTarget({
        databaseUrl: "postgresql://h/seatflow_test",
        nodeEnv: "development",
      }),
    ).toBe(true);
  });

  it("recognizes disposable database names and loopback hosts", () => {
    expect(isDisposableLoadTestDatabase("postgresql://h/seatflow_loadtest")).toBe(true);
    expect(isDisposableLoadTestDatabase("postgresql://h/seatflow")).toBe(false);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("app.seatflow.example")).toBe(false);
  });

  it("refuses a non-loopback HTTP target unless explicitly allowed", () => {
    const base = {
      databaseUrl: "postgresql://h/seatflow_test",
      nodeEnv: "development",
      baseUrl: "https://seatflow.example",
    };
    expect(() => assertSafeLoadTestTarget(base)).toThrow(/non-loopback/i);
    expect(assertSafeLoadTestTarget({ ...base, allowNonLocalTarget: true })).toBe(true);
  });

  it("does not let the override bypass the production or disposability checks", () => {
    expect(() =>
      assertSafeLoadTestTarget({
        databaseUrl: "postgresql://h/seatflow",
        nodeEnv: "development",
        baseUrl: "https://seatflow.example",
        allowNonLocalTarget: true,
      }),
    ).toThrow(/not marked disposable/i);
    expect(() =>
      assertSafeLoadTestTarget({
        databaseUrl: "postgresql://h/seatflow_test",
        nodeEnv: "production",
        allowNonLocalTarget: true,
      }),
    ).toThrow(LoadTestSafetyError);
  });

  it("clamps operator parameters to bounded maximums", () => {
    const bounded = boundLoadTestParameters({
      concurrency: 10_000,
      durationSeconds: 99_999,
      iterations: 10_000_000,
    });
    expect(bounded).toEqual(LOAD_TEST_MAXIMUMS);
    expect(boundLoadTestParameters({ concurrency: -5 }).concurrency).toBeGreaterThan(0);
    expect(boundLoadTestParameters({}).concurrency).toBeGreaterThan(0);
  });

  it("computes latency percentiles from samples", () => {
    const summary = summarizeLatencies([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(summary.count).toBe(10);
    expect(summary.averageMs).toBe(55);
    expect(summary.p50Ms).toBe(50);
    expect(summary.p95Ms).toBe(100);
    expect(summary.maxMs).toBe(100);
    expect(summarizeLatencies([]).count).toBe(0);
  });

  it("fails a scenario on a broken invariant no matter how fast it ran", () => {
    const fast: ScenarioOutcome = {
      name: "s",
      operations: 100,
      errors: 0,
      latency: summarizeLatencies([1, 1, 1]),
      invariants: [{ description: "one winner", passed: false }],
    };
    const evaluation = evaluateScenario(fast, { maximumErrorRate: 0.1, maximumP95Ms: 1_000 });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failedInvariants).toHaveLength(1);
  });

  it("fails a scenario that exceeds its error or latency budget", () => {
    const outcome: ScenarioOutcome = {
      name: "s",
      operations: 100,
      errors: 50,
      latency: summarizeLatencies([5_000]),
      invariants: [{ description: "ok", passed: true }],
    };
    expect(evaluateScenario(outcome, { maximumErrorRate: 0.1, maximumP95Ms: 1_000 }).passed).toBe(
      false,
    );
    expect(evaluateScenario(outcome, { maximumErrorRate: 1, maximumP95Ms: 10_000 }).passed).toBe(
      true,
    );
  });
});
