-- =============================================================================
-- Phase 5C2B: serverless job delivery receipts.
--
-- This migration is purely additive: it introduces one enum, one table, and its
-- constraints. It does not alter, backfill, or relax any Phase 0-5C2A table,
-- constraint, trigger, or transactional guarantee. No financial, inventory,
-- booking, or ticket state is touched.
--
-- Why this table exists
-- ---------------------
-- QStash delivers at least once. The bounded operations it triggers are all
-- individually idempotent -- they claim work with FOR UPDATE SKIP LOCKED and
-- guard every state transition -- so a redelivery is already safe. What was
-- missing is *visibility*: without a receipt, a replayed message is
-- indistinguishable from a fresh schedule tick, and an operator cannot tell a
-- retry storm from normal scheduling.
--
-- A receipt records that a delivery arrived and how it ended. It deliberately
-- has no column for the signature, the raw body, a signing key, a caller
-- address, or any booking, payment, refund, or ticket identifier. Nothing here
-- is authoritative for anything: deleting the whole table would cost visibility
-- and duplicate-suppression, never correctness.
-- =============================================================================

CREATE TYPE "ServerlessJobOutcome" AS ENUM (
  'COMPLETED',
  'RETRYABLE_FAILURE',
  'PERMANENT_FAILURE'
);

CREATE TABLE "JobDeliveryReceipt" (
  "messageId"     VARCHAR(128) NOT NULL,
  "job"           VARCHAR(64) NOT NULL,
  "environment"   VARCHAR(32) NOT NULL,
  "receivedAt"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"   TIMESTAMPTZ(3),
  "outcome"       "ServerlessJobOutcome",
  "attemptCount"  INTEGER NOT NULL DEFAULT 1,
  "safeErrorCode" VARCHAR(80),
  "durationMs"    INTEGER,

  CONSTRAINT "JobDeliveryReceipt_pkey" PRIMARY KEY ("messageId"),

  -- Bounded, non-secret identifiers only. The message id comes from the
  -- scheduler, so its grammar is constrained rather than trusted.
  CONSTRAINT "JobDeliveryReceipt_messageId_grammar"
    CHECK ("messageId" ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT "JobDeliveryReceipt_job_grammar"
    CHECK ("job" ~ '^[a-z][a-z0-9-]{0,63}$'),
  CONSTRAINT "JobDeliveryReceipt_environment_grammar"
    CHECK ("environment" ~ '^[a-z][a-z0-9_-]{0,31}$'),
  CONSTRAINT "JobDeliveryReceipt_safeErrorCode_grammar"
    CHECK ("safeErrorCode" IS NULL OR "safeErrorCode" ~ '^[A-Z0-9_:-]{1,80}$'),

  -- A completed receipt states an outcome, and an outcome implies completion.
  -- Half-recorded terminal state would make the duplicate check unreliable.
  CONSTRAINT "JobDeliveryReceipt_completion_coherent"
    CHECK (("completedAt" IS NULL) = ("outcome" IS NULL)),
  CONSTRAINT "JobDeliveryReceipt_completed_after_received"
    CHECK ("completedAt" IS NULL OR "completedAt" >= "receivedAt"),
  CONSTRAINT "JobDeliveryReceipt_attempts_positive"
    CHECK ("attemptCount" >= 1),
  CONSTRAINT "JobDeliveryReceipt_duration_non_negative"
    CHECK ("durationMs" IS NULL OR "durationMs" >= 0)
);

-- Operators scan by job to see scheduling health, and by recency to prune.
CREATE INDEX "JobDeliveryReceipt_job_receivedAt_idx"
  ON "JobDeliveryReceipt" ("job", "receivedAt");
CREATE INDEX "JobDeliveryReceipt_receivedAt_idx"
  ON "JobDeliveryReceipt" ("receivedAt");
