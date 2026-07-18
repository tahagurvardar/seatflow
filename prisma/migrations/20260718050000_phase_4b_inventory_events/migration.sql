-- CreateEnum
CREATE TYPE "InventoryEventType" AS ENUM (
  'INVENTORY_MATERIALIZED',
  'HOLD_CREATED',
  'HOLD_RELEASED',
  'HOLD_EXPIRED',
  'SESSION_CANCELLED'
);

-- CreateTable
CREATE TABLE "InventoryEventOutbox" (
  "id" TEXT NOT NULL,
  "eventType" "InventoryEventType" NOT NULL,
  "sessionId" TEXT NOT NULL,
  "aggregateId" TEXT,
  "payload" JSONB NOT NULL,
  "deduplicationKey" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "processedAt" TIMESTAMPTZ(3),
  "lastError" TEXT,
  "deadLetterAt" TIMESTAMPTZ(3),

  CONSTRAINT "InventoryEventOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryEventOutbox_attempt_count_check" CHECK ("attemptCount" >= 0),
  CONSTRAINT "InventoryEventOutbox_terminal_state_check" CHECK (
    NOT ("processedAt" IS NOT NULL AND "deadLetterAt" IS NOT NULL)
  ),
  CONSTRAINT "InventoryEventOutbox_error_length_check" CHECK (
    "lastError" IS NULL OR char_length("lastError") <= 500
  ),
  CONSTRAINT "InventoryEventOutbox_payload_object_check" CHECK (
    jsonb_typeof("payload") = 'object'
  ),
  CONSTRAINT "InventoryEventOutbox_payload_size_check" CHECK (
    octet_length("payload"::text) <= 8192
  )
);

-- CreateTable
CREATE TABLE "InventoryOperationsMetric" (
  "id" TEXT NOT NULL,
  "holdConflictCount" BIGINT NOT NULL DEFAULT 0,
  "transactionRetryCount" BIGINT NOT NULL DEFAULT 0,
  "dispatcherFailureCount" BIGINT NOT NULL DEFAULT 0,
  "lastDispatcherDurationMs" INTEGER,
  "lastDispatcherAt" TIMESTAMPTZ(3),
  "lastExpirySweepDurationMs" INTEGER,
  "lastExpirySweepAt" TIMESTAMPTZ(3),
  "lastExpiryLagMs" INTEGER,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "InventoryOperationsMetric_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryOperationsMetric_nonnegative_check" CHECK (
    "holdConflictCount" >= 0 AND
    "transactionRetryCount" >= 0 AND
    "dispatcherFailureCount" >= 0 AND
    ("lastDispatcherDurationMs" IS NULL OR "lastDispatcherDurationMs" >= 0) AND
    ("lastExpirySweepDurationMs" IS NULL OR "lastExpirySweepDurationMs" >= 0) AND
    ("lastExpiryLagMs" IS NULL OR "lastExpiryLagMs" >= 0)
  )
);

-- CreateIndex
CREATE UNIQUE INDEX "InventoryEventOutbox_deduplicationKey_key"
ON "InventoryEventOutbox"("deduplicationKey");

-- CreateIndex
CREATE INDEX "InventoryEventOutbox_processedAt_deadLetterAt_availableAt_createdAt_idx"
ON "InventoryEventOutbox"("processedAt", "deadLetterAt", "availableAt", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryEventOutbox_sessionId_createdAt_idx"
ON "InventoryEventOutbox"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryEventOutbox_aggregateId_idx"
ON "InventoryEventOutbox"("aggregateId");

-- AddForeignKey
ALTER TABLE "InventoryEventOutbox"
ADD CONSTRAINT "InventoryEventOutbox_sessionId_fkey"
FOREIGN KEY ("sessionId") REFERENCES "EventSession"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
