/**
 * Health, readiness, and worker-staleness decisions.
 *
 * Kept pure and free of Prisma, Redis, and `process.env` so the thresholds that
 * decide whether an instance receives traffic can be unit tested exhaustively.
 *
 * Liveness and readiness answer different questions on purpose:
 *
 *  - **Liveness** asks whether this process is running. It performs no
 *    dependency I/O, so a database blip can never cause an orchestrator to kill
 *    an otherwise healthy process and turn a dependency outage into an outage
 *    of everything.
 *  - **Readiness** asks whether this process can safely do its job right now. A
 *    failing readiness check removes the instance from rotation but leaves it
 *    running so it can recover.
 */

export type CheckStatus = "pass" | "warn" | "fail";
export type ReadinessStatus = "ready" | "degraded" | "not_ready";

/** The role a process plays, which decides which dependencies are required. */
export type ProcessRole =
  | "web"
  | "inventory_dispatcher"
  | "hold_expiry_worker"
  | "realtime_gateway"
  | "ticket_issuance_dispatcher"
  | "notification_dispatcher"
  | "payment_reconciliation"
  | "refund_reconciliation"
  | "financial_outbox_dispatcher";

export interface ReadinessCheck {
  /** Bounded label, never a URL, hostname, or connection string. */
  name: string;
  status: CheckStatus;
  /** Optional bounded reason code. Never a stack trace or driver message. */
  detail?: string;
}

/**
 * A single failing check makes the instance unfit to serve. A warning means it
 * can serve but something needs attention, which keeps a backlog alarm from
 * pulling every instance out of rotation and making the backlog worse.
 */
export function decideReadiness(checks: readonly ReadinessCheck[]): ReadinessStatus {
  if (checks.some((check) => check.status === "fail")) return "not_ready";
  if (checks.some((check) => check.status === "warn")) return "degraded";
  return "ready";
}

/** Readiness maps to HTTP: only a hard failure is a 503. */
export function readinessHttpStatus(status: ReadinessStatus) {
  return status === "not_ready" ? 503 : 200;
}

/**
 * Whether Redis is required for a role to function correctly.
 *
 * The web process is deliberately excluded. Phase 4B established that Redis is
 * transport only: the web process can still read PostgreSQL, acquire holds, and
 * fulfil payments while Redis is down, so a Redis outage degrades the web tier
 * rather than removing it from rotation.
 */
export function redisRequiredForRole(role: ProcessRole) {
  return role !== "web";
}

export interface OutboxThresholds {
  maximumBacklog: number;
  maximumAgeSeconds: number;
}

/**
 * Backlog severity. Exceeding a threshold is a warning rather than a failure
 * because a draining backlog needs the dispatcher to keep running, not to be
 * restarted or pulled from rotation.
 */
export function evaluateBacklog(
  input: { backlog: number; oldestAgeSeconds: number },
  thresholds: OutboxThresholds,
): CheckStatus {
  if (
    input.backlog > thresholds.maximumBacklog ||
    input.oldestAgeSeconds > thresholds.maximumAgeSeconds
  ) {
    return "warn";
  }
  return "pass";
}

/** Any dead letter is an operator action item, never an automatic failure. */
export function evaluateDeadLetters(count: number): CheckStatus {
  return count > 0 ? "warn" : "pass";
}

export type WorkerHealthLabel = "healthy" | "degraded" | "stale" | "stopped" | "missing";

export interface WorkerHeartbeatView {
  workerType: string;
  environment: string;
  status: "STARTING" | "HEALTHY" | "DEGRADED" | "STOPPED";
  version: string | null;
  lastSeenAt: Date;
}

export interface WorkerHealthEvaluation {
  label: WorkerHealthLabel;
  ageSeconds: number | null;
}

/**
 * Classify one worker from its last heartbeat.
 *
 * Staleness is derived from `lastSeenAt` rather than from a process reporting
 * its own death, because the failure that matters most — a crashed or wedged
 * worker — is precisely the one that cannot report anything.
 */
export function evaluateWorkerHeartbeat(input: {
  heartbeat: WorkerHeartbeatView | null;
  now: Date;
  staleAfterSeconds: number;
}): WorkerHealthEvaluation {
  if (!input.heartbeat) return { label: "missing", ageSeconds: null };

  const ageSeconds = Math.max(
    0,
    Math.floor((input.now.getTime() - input.heartbeat.lastSeenAt.getTime()) / 1_000),
  );

  // A deliberate shutdown is reported as stopped regardless of age, so a planned
  // maintenance window is distinguishable from a crash.
  if (input.heartbeat.status === "STOPPED") return { label: "stopped", ageSeconds };
  if (ageSeconds > input.staleAfterSeconds) return { label: "stale", ageSeconds };
  if (input.heartbeat.status === "DEGRADED") return { label: "degraded", ageSeconds };
  return { label: "healthy", ageSeconds };
}

/**
 * Which workers this deployment should expect a heartbeat from.
 *
 * A serverless deployment has no resident processes, so the realtime gateway
 * genuinely does not exist there — clients poll instead. Reporting it as a
 * missing worker would leave readiness permanently degraded for a reason that
 * is not a fault, and a signal that is always yellow is a signal nobody reads.
 *
 * The scheduled jobs still report heartbeats, because a scheduler that quietly
 * stops delivering is a real failure and must remain visible. That is the whole
 * point of keeping heartbeats in PostgreSQL rather than in the scheduler.
 */
export function expectedWorkerTypes(input: {
  jobMode: "worker" | "serverless";
}): readonly string[] {
  const scheduled = [
    "INVENTORY_OUTBOX_DISPATCHER",
    "HOLD_EXPIRY_WORKER",
    "TICKET_ISSUANCE_DISPATCHER",
    "NOTIFICATION_DISPATCHER",
    "PAYMENT_RECONCILIATION",
    "REFUND_RECONCILIATION",
  ];
  return input.jobMode === "serverless"
    ? scheduled
    : [...scheduled, "REALTIME_GATEWAY", "FINANCIAL_OUTBOX_DISPATCHER"];
}

/** Map a worker label onto a readiness check status. */
export function workerLabelToCheckStatus(label: WorkerHealthLabel): CheckStatus {
  switch (label) {
    case "healthy":
      return "pass";
    case "degraded":
    case "stale":
    case "stopped":
    case "missing":
      return "warn";
  }
}
