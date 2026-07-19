-- =============================================================================
-- Phase 5C1: durable worker heartbeats for readiness and stale-process alerting.
--
-- This migration is purely additive: it introduces two enums, one table, and
-- its constraints. It does not alter, backfill, or relax any Phase 0-5B table,
-- constraint, trigger, or transactional guarantee.
--
-- Heartbeat rows are operational metadata only. The table deliberately has no
-- column for a hostname, IP address, connection string, secret, environment
-- dump, or process command line, and the CHECK constraints below keep the
-- operator-supplied identifier and version bounded and free of control
-- characters so a heartbeat can never become a log-injection or leak vector.
-- =============================================================================

CREATE TYPE "WorkerType" AS ENUM (
  'INVENTORY_OUTBOX_DISPATCHER',
  'HOLD_EXPIRY_WORKER',
  'REALTIME_GATEWAY',
  'PAYMENT_RECONCILIATION',
  'TICKET_ISSUANCE_DISPATCHER',
  'NOTIFICATION_DISPATCHER'
);

CREATE TYPE "WorkerHealthStatus" AS ENUM ('STARTING', 'HEALTHY', 'DEGRADED', 'STOPPED');

CREATE TABLE "WorkerHeartbeat" (
  "workerType"          "WorkerType" NOT NULL,
  "environment"         VARCHAR(32) NOT NULL,
  "instanceLabel"       VARCHAR(64) NOT NULL,
  "status"              "WorkerHealthStatus" NOT NULL,
  "version"             VARCHAR(64),
  "startedAt"           TIMESTAMPTZ(3) NOT NULL,
  "lastSeenAt"          TIMESTAMPTZ(3) NOT NULL,
  "lastRunDurationMs"   INTEGER,
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "createdAt"           TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "WorkerHeartbeat_pkey"
    PRIMARY KEY ("workerType", "environment", "instanceLabel"),

  -- Bounded, non-secret operator labels only.
  CONSTRAINT "WorkerHeartbeat_environment_grammar"
    CHECK ("environment" ~ '^[a-z][a-z0-9_-]{0,31}$'),
  CONSTRAINT "WorkerHeartbeat_instanceLabel_grammar"
    CHECK ("instanceLabel" ~ '^[A-Za-z0-9._:-]{1,64}$'),
  CONSTRAINT "WorkerHeartbeat_version_grammar"
    CHECK ("version" IS NULL OR "version" ~ '^[A-Za-z0-9._:+-]{1,64}$'),

  -- Coherent lifecycle and bounded counters.
  CONSTRAINT "WorkerHeartbeat_lastSeen_after_start"
    CHECK ("lastSeenAt" >= "startedAt"),
  CONSTRAINT "WorkerHeartbeat_duration_non_negative"
    CHECK ("lastRunDurationMs" IS NULL OR "lastRunDurationMs" >= 0),
  CONSTRAINT "WorkerHeartbeat_failures_non_negative"
    CHECK ("consecutiveFailures" >= 0)
);

-- Readiness scans by recency to find stale workers.
CREATE INDEX "WorkerHeartbeat_lastSeenAt_idx" ON "WorkerHeartbeat" ("lastSeenAt");
