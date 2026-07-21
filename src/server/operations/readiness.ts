import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import {
  readNotificationEnvironment,
  readOperationsEnvironment,
  readOptionalInventoryEventEnvironment,
  readPaymentEnvironment,
  readServerlessJobEnvironment,
  readTicketEnvironment,
} from "@/env/schema";
import { resolveDeploymentProfile } from "@/features/operations/deployment-profile";
import {
  decideReadiness,
  evaluateBacklog,
  evaluateDeadLetters,
  expectedWorkerTypes,
  redisRequiredForRole,
  workerLabelToCheckStatus,
  type ProcessRole,
  type ReadinessCheck,
  type ReadinessStatus,
} from "@/features/operations/health";
import { createRedisConnection, ensureRedisConnected } from "@/lib/redis";
import { evaluateWorkerFleet } from "@/server/operations/worker-heartbeat";
import { checkDistributedRateLimitAvailable } from "@/server/security/rate-limit";

/**
 * Readiness evaluation.
 *
 * Every probe is bounded so readiness cannot itself become a source of latency
 * or a way to amplify a dependency outage. Results are reduced to a check name
 * plus a pass/warn/fail and an optional short reason code — never a URL,
 * username, hostname, schema name, internal ID, secret, or stack trace.
 */

/**
 * The newest migration this build expects. Readiness fails when the database is
 * behind it, which catches the dangerous deployment ordering where new code
 * reaches production before its migration has been applied.
 */
export const EXPECTED_LATEST_MIGRATION = "20260720000000_phase_5c2b_serverless_job_delivery";

const PROBE_TIMEOUT_MS = 2_000;

async function withTimeout<Result>(operation: Promise<Result>, timeoutMs = PROBE_TIMEOUT_MS) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("PROBE_TIMEOUT")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkDatabase(database: PrismaClient): Promise<ReadinessCheck> {
  try {
    await withTimeout(database.$queryRaw(Prisma.sql`SELECT 1`));
    return { name: "postgresql", status: "pass" };
  } catch {
    return { name: "postgresql", status: "fail", detail: "unreachable" };
  }
}

async function checkMigrations(database: PrismaClient): Promise<ReadinessCheck> {
  try {
    const rows = await withTimeout(
      database.$queryRaw<Array<{ migration_name: string; finished_at: Date | null }>>(Prisma.sql`
        SELECT "migration_name", "finished_at"
        FROM "_prisma_migrations"
        ORDER BY "migration_name" DESC
        LIMIT 25
      `),
    );

    if (rows.some((row) => row.finished_at === null)) {
      return { name: "migrations", status: "fail", detail: "incomplete_migration" };
    }
    const latest = rows[0]?.migration_name ?? "";
    if (latest < EXPECTED_LATEST_MIGRATION) {
      return { name: "migrations", status: "fail", detail: "database_behind_code" };
    }
    return { name: "migrations", status: "pass" };
  } catch {
    return { name: "migrations", status: "fail", detail: "unreadable" };
  }
}

async function checkRedis(role: ProcessRole): Promise<ReadinessCheck> {
  const environment = readOptionalInventoryEventEnvironment();
  const required = redisRequiredForRole(role);

  if (!environment) {
    return {
      name: "redis",
      status: required ? "fail" : "warn",
      detail: "not_configured",
    };
  }

  const redis = createRedisConnection({ environment, connectionName: "seatflow-readiness" });
  try {
    const pong = await withTimeout(
      (async () => {
        await ensureRedisConnected(redis);
        return redis.ping();
      })(),
    );
    return pong === "PONG"
      ? { name: "redis", status: "pass" }
      : { name: "redis", status: required ? "fail" : "warn", detail: "unhealthy" };
  } catch {
    // The web tier degrades rather than failing: Phase 4B established that
    // PostgreSQL alone is sufficient for correct holds, payments, and entry.
    return { name: "redis", status: required ? "fail" : "warn", detail: "unreachable" };
  } finally {
    redis.disconnect();
  }
}

function checkProviderConfiguration(): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];

  try {
    readPaymentEnvironment();
    checks.push({ name: "payment_provider", status: "pass" });
  } catch {
    checks.push({ name: "payment_provider", status: "fail", detail: "invalid_configuration" });
  }

  try {
    readNotificationEnvironment();
    checks.push({ name: "notification_provider", status: "pass" });
  } catch {
    checks.push({ name: "notification_provider", status: "fail", detail: "invalid_configuration" });
  }

  try {
    readTicketEnvironment();
    checks.push({ name: "ticket_credential", status: "pass" });
  } catch {
    checks.push({ name: "ticket_credential", status: "fail", detail: "invalid_configuration" });
  }

  return checks;
}

export interface ReadinessReport {
  status: ReadinessStatus;
  role: ProcessRole;
  /** Which world this deployment is. Non-secret and safe to report. */
  profile: string;
  jobMode: "worker" | "serverless";
  checkedAt: string;
  checks: ReadinessCheck[];
}

export async function evaluateReadiness(
  database: PrismaClient,
  input: { role?: ProcessRole; now?: Date } = {},
): Promise<ReadinessReport> {
  const now = input.now ?? new Date();
  const operations = readOperationsEnvironment();
  const role = input.role ?? "web";
  const profile = resolveDeploymentProfile(process.env);
  // Readiness must answer even when job configuration is incomplete, so an
  // unparseable serverless section degrades to worker mode rather than throwing.
  let serverlessJobs;
  try {
    serverlessJobs = readServerlessJobEnvironment();
  } catch {
    serverlessJobs = { SEATFLOW_JOB_MODE: "worker" as const };
  }

  const checks: ReadinessCheck[] = [];
  const databaseCheck = await checkDatabase(database);
  checks.push(databaseCheck);

  // Everything below needs a working database; probing it would only produce
  // misleading secondary failures.
  if (databaseCheck.status === "fail") {
    return {
      status: "not_ready",
      role,
      profile,
      jobMode: serverlessJobs.SEATFLOW_JOB_MODE,
      checkedAt: now.toISOString(),
      checks: [...checks, ...checkProviderConfiguration()],
    };
  }

  const [migrations, redis, backlog, deadLetters, notificationDeadLetters, workers, distributed] =
    await Promise.all([
      checkMigrations(database),
      checkRedis(role),
      (async () => {
        const [pending, oldest] = await Promise.all([
          database.inventoryEventOutbox.count({ where: { processedAt: null, deadLetterAt: null } }),
          database.inventoryEventOutbox.findFirst({
            where: { processedAt: null, deadLetterAt: null },
            orderBy: { createdAt: "asc" },
            select: { createdAt: true },
          }),
        ]);
        const oldestAgeSeconds = oldest
          ? Math.max(0, Math.floor((now.getTime() - oldest.createdAt.getTime()) / 1_000))
          : 0;
        return evaluateBacklog(
          { backlog: pending, oldestAgeSeconds },
          {
            maximumBacklog: operations.READINESS_MAX_OUTBOX_BACKLOG,
            maximumAgeSeconds: operations.READINESS_MAX_OUTBOX_AGE_SECONDS,
          },
        );
      })(),
      database.inventoryEventOutbox.count({ where: { deadLetterAt: { not: null } } }),
      database.notificationOutbox.count({ where: { status: "DEAD_LETTER" } }),
      evaluateWorkerFleet(database, {
        staleAfterSeconds: operations.WORKER_HEARTBEAT_STALE_SECONDS,
        now,
      }),
      checkDistributedRateLimitAvailable(),
    ]);

  checks.push(migrations, redis);
  checks.push({ name: "outbox_backlog", status: backlog });
  checks.push({
    name: "outbox_dead_letters",
    status: evaluateDeadLetters(deadLetters),
    ...(deadLetters > 0 ? { detail: "present" } : {}),
  });
  checks.push({
    name: "notification_dead_letters",
    status: evaluateDeadLetters(notificationDeadLetters),
    ...(notificationDeadLetters > 0 ? { detail: "present" } : {}),
  });

  // A serverless deployment has no realtime gateway process, so its absence is
  // expected rather than a fault. Reporting it as missing would leave readiness
  // permanently degraded, and a signal that is always yellow gets ignored.
  const expected = new Set(
    expectedWorkerTypes({ jobMode: serverlessJobs.SEATFLOW_JOB_MODE }),
  );
  for (const worker of workers) {
    if (!expected.has(worker.workerType)) continue;
    checks.push({
      name: `worker_${worker.workerType.toLowerCase()}`,
      status: workerLabelToCheckStatus(worker.label),
      detail: worker.label,
    });
  }

  // Production readiness must state when abuse control has degraded to
  // per-process counters, because that is invisible from the outside.
  checks.push({
    name: "distributed_rate_limit",
    status: distributed ? "pass" : "warn",
    ...(distributed ? {} : { detail: "process_local_only" }),
  });

  checks.push(...checkProviderConfiguration());

  return {
    status: decideReadiness(checks),
    role,
    profile,
    jobMode: serverlessJobs.SEATFLOW_JOB_MODE,
    checkedAt: now.toISOString(),
    checks,
  };
}
