import type { PrismaClient } from "@/generated/prisma/client";
import type { WorkerHealthStatus, WorkerType } from "@/generated/prisma/enums";
import {
  evaluateWorkerHeartbeat,
  type ProcessRole,
  type WorkerHealthEvaluation,
  type WorkerHeartbeatView,
} from "@/features/operations/health";

/**
 * Durable worker heartbeats.
 *
 * PostgreSQL is used rather than Redis so that worker visibility survives
 * exactly the outage most likely to hide a problem. A Redis-based heartbeat
 * would disappear at the same moment a Redis-dependent worker stopped, leaving
 * an operator with no signal at all.
 *
 * Writes are best-effort: a heartbeat failure must never abort a dispatch batch
 * or a sweep, because observability is not allowed to reduce availability.
 */

const INSTANCE_LABEL_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const VERSION_PATTERN = /^[A-Za-z0-9._:+-]{1,64}$/;

export const WORKER_ROLE_BY_TYPE: Record<WorkerType, ProcessRole> = {
  INVENTORY_OUTBOX_DISPATCHER: "inventory_dispatcher",
  HOLD_EXPIRY_WORKER: "hold_expiry_worker",
  REALTIME_GATEWAY: "realtime_gateway",
  PAYMENT_RECONCILIATION: "payment_reconciliation",
  TICKET_ISSUANCE_DISPATCHER: "ticket_issuance_dispatcher",
  NOTIFICATION_DISPATCHER: "notification_dispatcher",
  REFUND_RECONCILIATION: "refund_reconciliation",
  FINANCIAL_OUTBOX_DISPATCHER: "financial_outbox_dispatcher",
};

/**
 * Reduce an operator-supplied identifier to the stored grammar. Anything that
 * does not fit is replaced rather than truncated into something misleading.
 */
export function normalizeInstanceLabel(value: string | undefined | null) {
  if (!value) return "default";
  const cleaned = value.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 64);
  return INSTANCE_LABEL_PATTERN.test(cleaned) ? cleaned : "default";
}

export function normalizeVersion(value: string | undefined | null) {
  if (!value) return null;
  const cleaned = value.replace(/[^A-Za-z0-9._:+-]/g, "").slice(0, 64);
  return VERSION_PATTERN.test(cleaned) ? cleaned : null;
}

function normalizeEnvironment(value: string | undefined) {
  const candidate = (value ?? process.env.NODE_ENV ?? "development").toLowerCase();
  return /^[a-z][a-z0-9_-]{0,31}$/.test(candidate) ? candidate : "development";
}

export interface RecordHeartbeatInput {
  workerType: WorkerType;
  status: WorkerHealthStatus;
  instanceLabel?: string;
  environment?: string;
  version?: string | null;
  lastRunDurationMs?: number | null;
  consecutiveFailures?: number;
  startedAt?: Date;
  now?: Date;
}

/**
 * Upsert this worker's heartbeat. Deliberately records nothing beyond worker
 * type, environment, an operator label, status, an optional version, timings,
 * and a failure counter — no hostname, address, or command line.
 */
export async function recordWorkerHeartbeat(
  database: PrismaClient,
  input: RecordHeartbeatInput,
) {
  const now = input.now ?? new Date();
  const environment = normalizeEnvironment(input.environment);
  const instanceLabel = normalizeInstanceLabel(
    input.instanceLabel ?? process.env.SEATFLOW_INSTANCE_LABEL ?? process.env.REDIS_WORKER_ID,
  );
  const version = normalizeVersion(input.version ?? process.env.SEATFLOW_RELEASE_VERSION);
  const duration =
    typeof input.lastRunDurationMs === "number" && Number.isFinite(input.lastRunDurationMs)
      ? Math.max(0, Math.round(input.lastRunDurationMs))
      : null;
  const failures = Math.max(0, Math.round(input.consecutiveFailures ?? 0));

  try {
    await database.workerHeartbeat.upsert({
      where: {
        workerType_environment_instanceLabel: {
          workerType: input.workerType,
          environment,
          instanceLabel,
        },
      },
      create: {
        workerType: input.workerType,
        environment,
        instanceLabel,
        status: input.status,
        version,
        startedAt: input.startedAt ?? now,
        lastSeenAt: now,
        lastRunDurationMs: duration,
        consecutiveFailures: failures,
        updatedAt: now,
      },
      update: {
        status: input.status,
        version,
        lastSeenAt: now,
        lastRunDurationMs: duration,
        consecutiveFailures: failures,
        updatedAt: now,
        ...(input.startedAt ? { startedAt: input.startedAt } : {}),
      },
    });
  } catch {
    // Observability must never break the work it observes.
  }
}

export interface WorkerFleetEntry extends WorkerHealthEvaluation {
  workerType: WorkerType;
  role: ProcessRole;
  status: WorkerHealthStatus | null;
  version: string | null;
  instanceCount: number;
}

/**
 * Summarize every expected worker type for the current environment.
 *
 * The freshest instance of each type decides the label, so a fleet with one
 * healthy and one crashed instance still reports healthy for routing purposes
 * while the stale instance remains visible through `instanceCount`.
 */
export async function evaluateWorkerFleet(
  database: PrismaClient,
  input: { environment?: string; staleAfterSeconds: number; now?: Date },
): Promise<WorkerFleetEntry[]> {
  const now = input.now ?? new Date();
  const environment = normalizeEnvironment(input.environment);

  const heartbeats = await database.workerHeartbeat.findMany({
    where: { environment },
    orderBy: { lastSeenAt: "desc" },
    select: {
      workerType: true,
      environment: true,
      status: true,
      version: true,
      lastSeenAt: true,
    },
  });

  const workerTypes = Object.keys(WORKER_ROLE_BY_TYPE) as WorkerType[];
  return workerTypes.map((workerType) => {
    const matching = heartbeats.filter((entry) => entry.workerType === workerType);
    const freshest = matching[0] ?? null;
    const view: WorkerHeartbeatView | null = freshest
      ? {
          workerType: freshest.workerType,
          environment: freshest.environment,
          status: freshest.status,
          version: freshest.version,
          lastSeenAt: freshest.lastSeenAt,
        }
      : null;

    const evaluation = evaluateWorkerHeartbeat({
      heartbeat: view,
      now,
      staleAfterSeconds: input.staleAfterSeconds,
    });

    return {
      workerType,
      role: WORKER_ROLE_BY_TYPE[workerType],
      status: freshest?.status ?? null,
      version: freshest?.version ?? null,
      instanceCount: matching.length,
      ...evaluation,
    };
  });
}

/**
 * Drive a periodic heartbeat for a long-lived process. Returns a stop function
 * that records a final `STOPPED` beat so a planned shutdown is distinguishable
 * from a crash.
 */
export function startWorkerHeartbeat(
  database: PrismaClient,
  input: { workerType: WorkerType; intervalMs?: number; instanceLabel?: string },
) {
  const startedAt = new Date();
  const intervalMs = Math.min(Math.max(input.intervalMs ?? 30_000, 5_000), 300_000);

  const beat = (status: WorkerHealthStatus) =>
    recordWorkerHeartbeat(database, {
      workerType: input.workerType,
      instanceLabel: input.instanceLabel,
      status,
      startedAt,
    });

  void beat("STARTING");
  const timer = setInterval(() => void beat("HEALTHY"), intervalMs);
  // Never hold the event loop open purely for a heartbeat.
  timer.unref?.();

  return async () => {
    clearInterval(timer);
    await beat("STOPPED");
  };
}
