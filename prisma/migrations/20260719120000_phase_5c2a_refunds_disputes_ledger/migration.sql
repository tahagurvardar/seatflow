-- =============================================================================
-- Phase 5C2A: external provider adapters, refunds, disputes, and the
-- append-only financial ledger.
--
-- Design rules enforced here rather than only in application code:
--   * A refund never rewrites the original payment. It adds new, independently
--     auditable state plus append-only ledger entries.
--   * Over-refunding is prevented by PostgreSQL. Every refund write updates two
--     aggregates on PaymentAttempt, which takes a row lock and therefore
--     serializes concurrent refund creation for one payment. A CHECK constraint
--     then enforces refundedMinor + inFlightRefundMinor <= amountMinor.
--   * Ledger rows are append-only: a trigger rejects every UPDATE and DELETE.
--   * Only a verified provider webhook can mark an external refund succeeded or
--     move a dispute. Redis is never financial authority.
--   * Refunding money never returns inventory to AVAILABLE. The Phase 5A
--     SessionSeatInventory trigger already makes BOOKED terminal; nothing here
--     weakens it.
-- =============================================================================

CREATE TYPE "PaymentWebhookEventCategory" AS ENUM ('PAYMENT', 'REFUND', 'DISPUTE');

CREATE TYPE "RefundStatus" AS ENUM (
  'REQUESTED',
  'SUBMITTING',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'REQUIRES_REVIEW'
);

CREATE TYPE "RefundReasonCode" AS ENUM (
  'CUSTOMER_REQUEST',
  'EVENT_CANCELLED',
  'SESSION_RESCHEDULED',
  'DUPLICATE_PAYMENT',
  'GOODWILL',
  'OPERATIONAL_ERROR',
  'DISPUTE_RESOLUTION',
  'FRAUD_REVIEW'
);

CREATE TYPE "RefundScope" AS ENUM ('FULL_BOOKING', 'SELECTED_SEATS', 'FIXED_AMOUNT');

CREATE TYPE "RefundInitiator" AS ENUM ('CUSTOMER', 'ORGANIZER', 'PLATFORM_ADMIN', 'SYSTEM');

CREATE TYPE "RefundAttemptStatus" AS ENUM ('STARTED', 'SUCCEEDED', 'FAILED', 'TIMEOUT');

CREATE TYPE "DisputeStatus" AS ENUM (
  'OPEN',
  'NEEDS_RESPONSE',
  'UNDER_REVIEW',
  'WON',
  'LOST',
  'CLOSED',
  'REQUIRES_REVIEW'
);

CREATE TYPE "DisputeReasonCategory" AS ENUM (
  'FRAUDULENT',
  'PRODUCT_NOT_RECEIVED',
  'DUPLICATE',
  'CREDIT_NOT_PROCESSED',
  'SUBSCRIPTION_CANCELED',
  'GENERAL',
  'UNRECOGNIZED'
);

CREATE TYPE "DisputeOutcome" AS ENUM ('WON', 'LOST', 'WITHDRAWN', 'UNRESOLVED');

CREATE TYPE "LedgerEntryType" AS ENUM (
  'PAYMENT_AUTHORIZED',
  'PAYMENT_CAPTURED',
  'PAYMENT_FAILED',
  'REFUND_REQUESTED',
  'REFUND_PROCESSING',
  'REFUND_SUCCEEDED',
  'REFUND_FAILED',
  'REFUND_CANCELLED',
  'DISPUTE_OPENED',
  'DISPUTE_UPDATED',
  'DISPUTE_WON',
  'DISPUTE_LOST',
  'CHARGEBACK_RECORDED',
  'MANUAL_ADJUSTMENT_REQUESTED'
);

CREATE TYPE "LedgerDirection" AS ENUM ('CREDIT', 'DEBIT');

CREATE TYPE "FinancialReviewState" AS ENUM (
  'NONE',
  'REFUND_REVIEW',
  'DISPUTE_REVIEW',
  'CHARGEBACK_REVIEW',
  'DIVERGENCE_REVIEW'
);

CREATE TYPE "FinancialOutboxEventType" AS ENUM (
  'REFUND_REQUESTED',
  'REFUND_SUBMITTED',
  'REFUND_PROCESSING',
  'REFUND_SUCCEEDED',
  'REFUND_FAILED',
  'REFUND_REQUIRES_REVIEW',
  'DISPUTE_OPENED',
  'DISPUTE_UPDATED',
  'DISPUTE_WON',
  'DISPUTE_LOST',
  'CHARGEBACK_RECORDED',
  'TICKET_REVOCATION_REQUESTED',
  'FINANCIAL_RECONCILIATION_REQUIRED'
);

CREATE TYPE "FinancialOutboxStatus" AS ENUM ('PENDING', 'PROCESSED', 'DEAD_LETTER');

ALTER TYPE "BookingStatus" ADD VALUE 'REFUNDED';
ALTER TYPE "PaymentProviderName" ADD VALUE 'STRIPE';
ALTER TYPE "NotificationProviderName" ADD VALUE 'RESEND';
ALTER TYPE "NotificationType" ADD VALUE 'REFUND_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'REFUND_SUCCEEDED';
ALTER TYPE "NotificationType" ADD VALUE 'REFUND_FAILED';
ALTER TYPE "NotificationType" ADD VALUE 'REFUND_REQUIRES_REVIEW';
ALTER TYPE "NotificationType" ADD VALUE 'DISPUTE_OPENED';
ALTER TYPE "WorkerType" ADD VALUE 'REFUND_RECONCILIATION';
ALTER TYPE "WorkerType" ADD VALUE 'FINANCIAL_OUTBOX_DISPATCHER';

-- ---------------------------------------------------------------------------
-- Existing tables gain refund/dispute awareness without losing any Phase 5A
-- guarantee. Every added column is nullable or defaulted, so deployment against
-- a populated database is non-destructive and existing rows stay valid.
-- ---------------------------------------------------------------------------

ALTER TABLE "Booking"
  ADD COLUMN "refundedAt" TIMESTAMPTZ(3),
  ADD COLUMN "financialReviewState" "FinancialReviewState" NOT NULL DEFAULT 'NONE';

ALTER TABLE "CheckoutOrder"
  ADD COLUMN "financialReviewState" "FinancialReviewState" NOT NULL DEFAULT 'NONE';

ALTER TABLE "PaymentAttempt"
  ADD COLUMN "refundedMinor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "inFlightRefundMinor" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "PaymentWebhookEvent"
  ADD COLUMN "eventCategory" "PaymentWebhookEventCategory" NOT NULL DEFAULT 'PAYMENT',
  ADD COLUMN "normalizedRefundStatus" "RefundStatus",
  ADD COLUMN "normalizedDisputeStatus" "DisputeStatus",
  ADD COLUMN "providerRefundId" TEXT,
  ADD COLUMN "providerDisputeId" TEXT,
  ADD COLUMN "refundId" TEXT,
  ADD COLUMN "disputeId" TEXT,
  ALTER COLUMN "normalizedStatus" DROP NOT NULL;

-- The refund aggregates are the authoritative over-refund guard.
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_refund_aggregate_check" CHECK (
  "refundedMinor" >= 0
  AND "inFlightRefundMinor" >= 0
  AND "refundedMinor" + "inFlightRefundMinor" <= "amountMinor"
);

-- Money may only be refunded against a captured payment.
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_refund_requires_capture_check" CHECK (
  ("refundedMinor" = 0 AND "inFlightRefundMinor" = 0) OR "status" = 'SUCCEEDED'
);

-- Exactly one category's columns are populated per verified webhook row.
ALTER TABLE "PaymentWebhookEvent" ADD CONSTRAINT "PaymentWebhookEvent_category_check" CHECK (
  ("eventCategory" = 'PAYMENT'
    AND "normalizedStatus" IS NOT NULL
    AND "normalizedRefundStatus" IS NULL AND "normalizedDisputeStatus" IS NULL
    AND "providerRefundId" IS NULL AND "providerDisputeId" IS NULL
    AND "refundId" IS NULL AND "disputeId" IS NULL)
  OR ("eventCategory" = 'REFUND'
    AND "normalizedStatus" IS NULL
    AND "normalizedRefundStatus" IS NOT NULL AND "normalizedDisputeStatus" IS NULL
    AND "providerRefundId" IS NOT NULL AND "providerDisputeId" IS NULL
    AND "disputeId" IS NULL)
  OR ("eventCategory" = 'DISPUTE'
    AND "normalizedStatus" IS NULL
    AND "normalizedRefundStatus" IS NULL AND "normalizedDisputeStatus" IS NOT NULL
    AND "providerDisputeId" IS NOT NULL AND "providerRefundId" IS NULL
    AND "refundId" IS NULL)
);

ALTER TABLE "PaymentWebhookEvent" ADD CONSTRAINT "PaymentWebhookEvent_financial_identity_check" CHECK (
  ("providerRefundId" IS NULL OR char_length("providerRefundId") BETWEEN 1 AND 191)
  AND ("providerDisputeId" IS NULL OR char_length("providerDisputeId") BETWEEN 1 AND 191)
);

-- A fully refunded booking is a deliberate terminal state. totalMinor stays
-- exactly what the customer paid.
--
-- The comparison goes through ::text deliberately. PostgreSQL forbids using an
-- enum value added earlier in the same transaction, and 'REFUNDED' is added by
-- this very migration, so an enum-typed literal here would fail on a fresh
-- replay of the chain.
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_refund_lifecycle_check" CHECK (
  ("status"::text = 'CONFIRMED' AND "refundedAt" IS NULL)
  OR ("status"::text = 'REFUNDED' AND "refundedAt" IS NOT NULL AND "refundedAt" >= "confirmedAt")
);

-- ---------------------------------------------------------------------------
-- Refunds
-- ---------------------------------------------------------------------------

CREATE TABLE "Refund" (
  "id" TEXT NOT NULL,
  "publicReference" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "paymentAttemptId" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "requestedByUserId" TEXT,
  "approvedByUserId" TEXT,
  "initiator" "RefundInitiator" NOT NULL,
  "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
  "reasonCode" "RefundReasonCode" NOT NULL,
  "scope" "RefundScope" NOT NULL,
  "requestedAmountMinor" INTEGER NOT NULL,
  "currency" "Currency" NOT NULL,
  "provider" "PaymentProviderName" NOT NULL,
  "providerRefundId" TEXT,
  "providerIdempotencyKey" TEXT NOT NULL,
  "requestedAt" TIMESTAMPTZ(3) NOT NULL,
  "submittedAt" TIMESTAMPTZ(3),
  "succeededAt" TIMESTAMPTZ(3),
  "failedAt" TIMESTAMPTZ(3),
  "cancelledAt" TIMESTAMPTZ(3),
  "reviewRequiredAt" TIMESTAMPTZ(3),
  "safeFailureCode" TEXT,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "Refund_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Refund_public_reference_check" CHECK (
    char_length("publicReference") BETWEEN 24 AND 191
    AND "publicReference" ~ '^[A-Za-z0-9_-]+$'
  ),
  -- A refund is always for a strictly positive amount. There is no negative
  -- adjustment path and no client-supplied total.
  CONSTRAINT "Refund_amount_check" CHECK ("requestedAmountMinor" > 0),
  CONSTRAINT "Refund_idempotency_key_check" CHECK (
    char_length("providerIdempotencyKey") BETWEEN 24 AND 191
    AND "providerIdempotencyKey" ~ '^[A-Za-z0-9_:-]+$'
  ),
  CONSTRAINT "Refund_provider_refund_check" CHECK (
    "providerRefundId" IS NULL OR char_length("providerRefundId") BETWEEN 1 AND 191
  ),
  CONSTRAINT "Refund_failure_code_check" CHECK (
    "safeFailureCode" IS NULL
    OR (char_length("safeFailureCode") BETWEEN 1 AND 80 AND "safeFailureCode" ~ '^[A-Z0-9_:-]+$')
  ),
  CONSTRAINT "Refund_version_check" CHECK ("version" >= 0),
  CONSTRAINT "Refund_time_order_check" CHECK (
    ("submittedAt" IS NULL OR "submittedAt" >= "requestedAt")
    AND ("succeededAt" IS NULL OR "succeededAt" >= "requestedAt")
    AND ("failedAt" IS NULL OR "failedAt" >= "requestedAt")
    AND ("cancelledAt" IS NULL OR "cancelledAt" >= "requestedAt")
    AND ("reviewRequiredAt" IS NULL OR "reviewRequiredAt" >= "requestedAt")
  ),
  -- Money can only ever have moved once: succeeded, failed, and cancelled are
  -- mutually exclusive outcomes.
  CONSTRAINT "Refund_outcome_exclusivity_check" CHECK (
    (CASE WHEN "succeededAt" IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN "failedAt" IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN "cancelledAt" IS NOT NULL THEN 1 ELSE 0 END) <= 1
  ),
  CONSTRAINT "Refund_lifecycle_check" CHECK (
    ("status" = 'REQUESTED'
      AND "submittedAt" IS NULL AND "succeededAt" IS NULL AND "failedAt" IS NULL
      AND "cancelledAt" IS NULL AND "reviewRequiredAt" IS NULL)
    OR ("status" IN ('SUBMITTING', 'PROCESSING')
      AND "submittedAt" IS NOT NULL AND "succeededAt" IS NULL AND "failedAt" IS NULL
      AND "cancelledAt" IS NULL AND "reviewRequiredAt" IS NULL)
    OR ("status" = 'SUCCEEDED'
      AND "succeededAt" IS NOT NULL AND "failedAt" IS NULL AND "cancelledAt" IS NULL
      AND "reviewRequiredAt" IS NULL AND "safeFailureCode" IS NULL)
    OR ("status" = 'FAILED'
      AND "failedAt" IS NOT NULL AND "succeededAt" IS NULL AND "cancelledAt" IS NULL
      AND "reviewRequiredAt" IS NULL AND "safeFailureCode" IS NOT NULL)
    OR ("status" = 'CANCELLED'
      AND "cancelledAt" IS NOT NULL AND "succeededAt" IS NULL AND "failedAt" IS NULL
      AND "reviewRequiredAt" IS NULL)
    -- REQUIRES_REVIEW is a one-way escalation that preserves whatever outcome
    -- timestamp was already recorded, so contradictory provider events never
    -- erase the first valid terminal result.
    OR ("status" = 'REQUIRES_REVIEW'
      AND "reviewRequiredAt" IS NOT NULL AND "safeFailureCode" IS NOT NULL)
  )
);

CREATE TABLE "RefundSeat" (
  "id" TEXT NOT NULL,
  "refundId" TEXT NOT NULL,
  "bookingSeatId" TEXT NOT NULL,
  "priceMinor" INTEGER NOT NULL,
  "currency" "Currency" NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RefundSeat_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RefundSeat_price_check" CHECK ("priceMinor" >= 0)
);

CREATE TABLE "RefundAttempt" (
  "id" TEXT NOT NULL,
  "refundId" TEXT NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "provider" "PaymentProviderName" NOT NULL,
  "providerRequestReference" TEXT,
  "status" "RefundAttemptStatus" NOT NULL,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "completedAt" TIMESTAMPTZ(3),
  "safeFailureCode" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RefundAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RefundAttempt_number_check" CHECK ("attemptNumber" >= 1),
  CONSTRAINT "RefundAttempt_idempotency_key_check" CHECK (
    char_length("idempotencyKey") BETWEEN 24 AND 191
    AND "idempotencyKey" ~ '^[A-Za-z0-9_:-]+$'
  ),
  CONSTRAINT "RefundAttempt_reference_check" CHECK (
    "providerRequestReference" IS NULL
    OR char_length("providerRequestReference") BETWEEN 1 AND 191
  ),
  CONSTRAINT "RefundAttempt_failure_code_check" CHECK (
    "safeFailureCode" IS NULL
    OR (char_length("safeFailureCode") BETWEEN 1 AND 80 AND "safeFailureCode" ~ '^[A-Z0-9_:-]+$')
  ),
  CONSTRAINT "RefundAttempt_lifecycle_check" CHECK (
    ("status" = 'STARTED' AND "completedAt" IS NULL)
    OR ("status" = 'SUCCEEDED' AND "completedAt" IS NOT NULL AND "safeFailureCode" IS NULL)
    OR ("status" IN ('FAILED', 'TIMEOUT') AND "completedAt" IS NOT NULL AND "safeFailureCode" IS NOT NULL)
  )
);

-- ---------------------------------------------------------------------------
-- Disputes
-- ---------------------------------------------------------------------------

CREATE TABLE "PaymentDispute" (
  "id" TEXT NOT NULL,
  "publicReference" TEXT NOT NULL,
  "paymentAttemptId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "bookingId" TEXT,
  "provider" "PaymentProviderName" NOT NULL,
  "providerDisputeId" TEXT NOT NULL,
  "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
  "reasonCategory" "DisputeReasonCategory" NOT NULL DEFAULT 'UNRECOGNIZED',
  "disputedAmountMinor" INTEGER NOT NULL,
  "currency" "Currency" NOT NULL,
  "openedAt" TIMESTAMPTZ(3) NOT NULL,
  "evidenceDueAt" TIMESTAMPTZ(3),
  "closedAt" TIMESTAMPTZ(3),
  "outcome" "DisputeOutcome",
  "safeProviderStatus" TEXT,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "PaymentDispute_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentDispute_public_reference_check" CHECK (
    char_length("publicReference") BETWEEN 24 AND 191
    AND "publicReference" ~ '^[A-Za-z0-9_-]+$'
  ),
  CONSTRAINT "PaymentDispute_amount_check" CHECK ("disputedAmountMinor" > 0),
  CONSTRAINT "PaymentDispute_provider_identity_check" CHECK (
    char_length("providerDisputeId") BETWEEN 1 AND 191
  ),
  CONSTRAINT "PaymentDispute_provider_status_check" CHECK (
    "safeProviderStatus" IS NULL OR char_length("safeProviderStatus") <= 80
  ),
  CONSTRAINT "PaymentDispute_version_check" CHECK ("version" >= 0),
  CONSTRAINT "PaymentDispute_time_order_check" CHECK (
    ("closedAt" IS NULL OR "closedAt" >= "openedAt")
    AND ("evidenceDueAt" IS NULL OR "evidenceDueAt" >= "openedAt")
  ),
  CONSTRAINT "PaymentDispute_lifecycle_check" CHECK (
    ("status" IN ('OPEN', 'NEEDS_RESPONSE', 'UNDER_REVIEW')
      AND "closedAt" IS NULL AND "outcome" IS NULL)
    OR ("status" = 'WON' AND "closedAt" IS NOT NULL AND "outcome" = 'WON')
    OR ("status" = 'LOST' AND "closedAt" IS NOT NULL AND "outcome" = 'LOST')
    OR ("status" = 'CLOSED' AND "closedAt" IS NOT NULL AND "outcome" IS NOT NULL)
    OR ("status" = 'REQUIRES_REVIEW')
  )
);

CREATE TABLE "PaymentDisputeEvent" (
  "id" TEXT NOT NULL,
  "disputeId" TEXT NOT NULL,
  "providerEventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "previousStatus" "DisputeStatus",
  "newStatus" "DisputeStatus" NOT NULL,
  "effectiveAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "safeMetadata" JSONB,

  CONSTRAINT "PaymentDisputeEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentDisputeEvent_identity_check" CHECK (
    char_length("providerEventId") BETWEEN 1 AND 191
    AND char_length("eventType") BETWEEN 1 AND 120
  )
);

-- ---------------------------------------------------------------------------
-- Append-only financial ledger
-- ---------------------------------------------------------------------------

CREATE TABLE "FinancialLedgerEntry" (
  "id" TEXT NOT NULL,
  "publicReference" TEXT NOT NULL,
  "entryType" "LedgerEntryType" NOT NULL,
  "direction" "LedgerDirection" NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "currency" "Currency" NOT NULL,
  "orderId" TEXT NOT NULL,
  "paymentAttemptId" TEXT NOT NULL,
  "bookingId" TEXT,
  "refundId" TEXT,
  "disputeId" TEXT,
  "provider" "PaymentProviderName" NOT NULL,
  "providerReferenceHash" CHAR(64),
  "effectiveAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idempotencyKey" TEXT NOT NULL,
  "correlationId" TEXT,
  "metadataVersion" INTEGER NOT NULL DEFAULT 1,
  "safeMetadata" JSONB,

  CONSTRAINT "FinancialLedgerEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinancialLedgerEntry_public_reference_check" CHECK (
    char_length("publicReference") BETWEEN 24 AND 191
    AND "publicReference" ~ '^[A-Za-z0-9_-]+$'
  ),
  CONSTRAINT "FinancialLedgerEntry_amount_check" CHECK ("amountMinor" >= 0),
  CONSTRAINT "FinancialLedgerEntry_idempotency_key_check" CHECK (
    char_length("idempotencyKey") BETWEEN 8 AND 191
    AND "idempotencyKey" ~ '^[A-Za-z0-9_:.-]+$'
  ),
  -- Only a hash of the provider reference is stored, never the raw identifier.
  CONSTRAINT "FinancialLedgerEntry_reference_hash_check" CHECK (
    "providerReferenceHash" IS NULL OR "providerReferenceHash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "FinancialLedgerEntry_correlation_check" CHECK (
    "correlationId" IS NULL
    OR (char_length("correlationId") BETWEEN 1 AND 80 AND "correlationId" ~ '^[A-Za-z0-9_:-]+$')
  ),
  CONSTRAINT "FinancialLedgerEntry_metadata_version_check" CHECK ("metadataVersion" >= 1),
  -- Direction is fixed per entry type so a refund can never be recorded as a
  -- credit that cancels out the original capture.
  CONSTRAINT "FinancialLedgerEntry_direction_check" CHECK (
    ("entryType" IN ('PAYMENT_AUTHORIZED', 'PAYMENT_CAPTURED', 'DISPUTE_WON') AND "direction" = 'CREDIT')
    OR ("entryType" IN (
          'REFUND_SUCCEEDED', 'DISPUTE_LOST', 'CHARGEBACK_RECORDED'
        ) AND "direction" = 'DEBIT')
    OR "entryType" IN (
         'PAYMENT_FAILED', 'REFUND_REQUESTED', 'REFUND_PROCESSING', 'REFUND_FAILED',
         'REFUND_CANCELLED', 'DISPUTE_OPENED', 'DISPUTE_UPDATED',
         'MANUAL_ADJUSTMENT_REQUESTED'
       )
  ),
  CONSTRAINT "FinancialLedgerEntry_refund_link_check" CHECK (
    "entryType" NOT IN (
      'REFUND_REQUESTED', 'REFUND_PROCESSING', 'REFUND_SUCCEEDED',
      'REFUND_FAILED', 'REFUND_CANCELLED'
    ) OR "refundId" IS NOT NULL
  ),
  CONSTRAINT "FinancialLedgerEntry_dispute_link_check" CHECK (
    "entryType" NOT IN (
      'DISPUTE_OPENED', 'DISPUTE_UPDATED', 'DISPUTE_WON', 'DISPUTE_LOST', 'CHARGEBACK_RECORDED'
    ) OR "disputeId" IS NOT NULL
  )
);

CREATE TABLE "FinancialOutbox" (
  "id" TEXT NOT NULL,
  "eventType" "FinancialOutboxEventType" NOT NULL,
  "aggregateId" TEXT,
  "orderId" TEXT,
  "refundId" TEXT,
  "disputeId" TEXT,
  "bookingId" TEXT,
  "payload" JSONB NOT NULL,
  "deduplicationKey" TEXT NOT NULL,
  "status" "FinancialOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "processedAt" TIMESTAMPTZ(3),
  "lastError" TEXT,
  "deadLetterAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "FinancialOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinancialOutbox_attempt_check" CHECK ("attemptCount" >= 0),
  CONSTRAINT "FinancialOutbox_error_check" CHECK (
    "lastError" IS NULL OR char_length("lastError") <= 240
  ),
  CONSTRAINT "FinancialOutbox_status_check" CHECK (
    ("status" = 'PENDING' AND "processedAt" IS NULL AND "deadLetterAt" IS NULL)
    OR ("status" = 'PROCESSED' AND "processedAt" IS NOT NULL AND "deadLetterAt" IS NULL)
    OR ("status" = 'DEAD_LETTER' AND "deadLetterAt" IS NOT NULL)
  )
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "Refund_publicReference_key" ON "Refund"("publicReference");
CREATE UNIQUE INDEX "Refund_providerIdempotencyKey_key" ON "Refund"("providerIdempotencyKey");
CREATE UNIQUE INDEX "Refund_provider_providerRefundId_key" ON "Refund"("provider", "providerRefundId");
CREATE INDEX "Refund_orderId_requestedAt_idx" ON "Refund"("orderId", "requestedAt");
CREATE INDEX "Refund_bookingId_requestedAt_idx" ON "Refund"("bookingId", "requestedAt");
CREATE INDEX "Refund_paymentAttemptId_status_idx" ON "Refund"("paymentAttemptId", "status");
CREATE INDEX "Refund_status_requestedAt_idx" ON "Refund"("status", "requestedAt");
CREATE INDEX "Refund_requestedByUserId_requestedAt_idx" ON "Refund"("requestedByUserId", "requestedAt");

CREATE UNIQUE INDEX "RefundSeat_refundId_bookingSeatId_key" ON "RefundSeat"("refundId", "bookingSeatId");
CREATE INDEX "RefundSeat_bookingSeatId_idx" ON "RefundSeat"("bookingSeatId");

CREATE UNIQUE INDEX "RefundAttempt_idempotencyKey_key" ON "RefundAttempt"("idempotencyKey");
CREATE UNIQUE INDEX "RefundAttempt_refundId_attemptNumber_key" ON "RefundAttempt"("refundId", "attemptNumber");
CREATE INDEX "RefundAttempt_status_startedAt_idx" ON "RefundAttempt"("status", "startedAt");

CREATE UNIQUE INDEX "PaymentDispute_publicReference_key" ON "PaymentDispute"("publicReference");
CREATE UNIQUE INDEX "PaymentDispute_provider_providerDisputeId_key"
  ON "PaymentDispute"("provider", "providerDisputeId");
CREATE INDEX "PaymentDispute_orderId_openedAt_idx" ON "PaymentDispute"("orderId", "openedAt");
CREATE INDEX "PaymentDispute_bookingId_openedAt_idx" ON "PaymentDispute"("bookingId", "openedAt");
CREATE INDEX "PaymentDispute_status_openedAt_idx" ON "PaymentDispute"("status", "openedAt");
CREATE INDEX "PaymentDispute_status_evidenceDueAt_idx" ON "PaymentDispute"("status", "evidenceDueAt");

CREATE UNIQUE INDEX "PaymentDisputeEvent_disputeId_providerEventId_key"
  ON "PaymentDisputeEvent"("disputeId", "providerEventId");
CREATE INDEX "PaymentDisputeEvent_disputeId_effectiveAt_idx"
  ON "PaymentDisputeEvent"("disputeId", "effectiveAt");

CREATE UNIQUE INDEX "FinancialLedgerEntry_publicReference_key"
  ON "FinancialLedgerEntry"("publicReference");
CREATE UNIQUE INDEX "FinancialLedgerEntry_idempotencyKey_key"
  ON "FinancialLedgerEntry"("idempotencyKey");
CREATE INDEX "FinancialLedgerEntry_orderId_effectiveAt_idx"
  ON "FinancialLedgerEntry"("orderId", "effectiveAt");
CREATE INDEX "FinancialLedgerEntry_paymentAttemptId_effectiveAt_idx"
  ON "FinancialLedgerEntry"("paymentAttemptId", "effectiveAt");
CREATE INDEX "FinancialLedgerEntry_bookingId_effectiveAt_idx"
  ON "FinancialLedgerEntry"("bookingId", "effectiveAt");
CREATE INDEX "FinancialLedgerEntry_refundId_effectiveAt_idx"
  ON "FinancialLedgerEntry"("refundId", "effectiveAt");
CREATE INDEX "FinancialLedgerEntry_disputeId_effectiveAt_idx"
  ON "FinancialLedgerEntry"("disputeId", "effectiveAt");
CREATE INDEX "FinancialLedgerEntry_entryType_effectiveAt_idx"
  ON "FinancialLedgerEntry"("entryType", "effectiveAt");
CREATE INDEX "FinancialLedgerEntry_currency_entryType_idx"
  ON "FinancialLedgerEntry"("currency", "entryType");

CREATE UNIQUE INDEX "FinancialOutbox_deduplicationKey_key" ON "FinancialOutbox"("deduplicationKey");
CREATE INDEX "FinancialOutbox_status_availableAt_createdAt_idx"
  ON "FinancialOutbox"("status", "availableAt", "createdAt");
CREATE INDEX "FinancialOutbox_eventType_createdAt_idx" ON "FinancialOutbox"("eventType", "createdAt");
CREATE INDEX "FinancialOutbox_refundId_idx" ON "FinancialOutbox"("refundId");
CREATE INDEX "FinancialOutbox_disputeId_idx" ON "FinancialOutbox"("disputeId");

CREATE INDEX "PaymentWebhookEvent_eventCategory_processingStatus_received_idx"
  ON "PaymentWebhookEvent"("eventCategory", "processingStatus", "receivedAt");
CREATE INDEX "PaymentWebhookEvent_refundId_receivedAt_idx"
  ON "PaymentWebhookEvent"("refundId", "receivedAt");
CREATE INDEX "PaymentWebhookEvent_disputeId_receivedAt_idx"
  ON "PaymentWebhookEvent"("disputeId", "receivedAt");

-- ---------------------------------------------------------------------------
-- Foreign keys. Every financial reference is RESTRICT: nothing in this phase
-- may cascade a delete through payment, booking, refund, or dispute history.
-- ---------------------------------------------------------------------------

ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "CheckoutOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_paymentAttemptId_fkey"
  FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_requestedByUserId_fkey"
  FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_approvedByUserId_fkey"
  FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RefundSeat" ADD CONSTRAINT "RefundSeat_refundId_fkey"
  FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RefundSeat" ADD CONSTRAINT "RefundSeat_bookingSeatId_fkey"
  FOREIGN KEY ("bookingSeatId") REFERENCES "BookingSeat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RefundAttempt" ADD CONSTRAINT "RefundAttempt_refundId_fkey"
  FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentDispute" ADD CONSTRAINT "PaymentDispute_paymentAttemptId_fkey"
  FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentDispute" ADD CONSTRAINT "PaymentDispute_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "CheckoutOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentDispute" ADD CONSTRAINT "PaymentDispute_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentDisputeEvent" ADD CONSTRAINT "PaymentDisputeEvent_disputeId_fkey"
  FOREIGN KEY ("disputeId") REFERENCES "PaymentDispute"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FinancialLedgerEntry" ADD CONSTRAINT "FinancialLedgerEntry_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "CheckoutOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinancialLedgerEntry" ADD CONSTRAINT "FinancialLedgerEntry_paymentAttemptId_fkey"
  FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinancialLedgerEntry" ADD CONSTRAINT "FinancialLedgerEntry_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinancialLedgerEntry" ADD CONSTRAINT "FinancialLedgerEntry_refundId_fkey"
  FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinancialLedgerEntry" ADD CONSTRAINT "FinancialLedgerEntry_disputeId_fkey"
  FOREIGN KEY ("disputeId") REFERENCES "PaymentDispute"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentWebhookEvent" ADD CONSTRAINT "PaymentWebhookEvent_refundId_fkey"
  FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentWebhookEvent" ADD CONSTRAINT "PaymentWebhookEvent_disputeId_fkey"
  FOREIGN KEY ("disputeId") REFERENCES "PaymentDispute"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Refund ancestry: currency, provider, order, and booking all derive from the
-- captured payment, never from the caller.
-- ---------------------------------------------------------------------------

CREATE FUNCTION "Refund_enforce_ancestry"() RETURNS trigger AS $$
DECLARE
  attempt_record RECORD;
  booking_record RECORD;
BEGIN
  SELECT "orderId", "provider", "currency", "amountMinor", "status"
    INTO attempt_record
  FROM "PaymentAttempt" WHERE "id" = NEW."paymentAttemptId";
  SELECT "orderId" INTO booking_record FROM "Booking" WHERE "id" = NEW."bookingId";

  IF attempt_record."orderId" IS DISTINCT FROM NEW."orderId"
     OR booking_record."orderId" IS DISTINCT FROM NEW."orderId" THEN
    RAISE EXCEPTION 'Refund ancestry must match one order, payment attempt, and booking';
  END IF;
  IF attempt_record."status" IS DISTINCT FROM 'SUCCEEDED' THEN
    RAISE EXCEPTION 'A refund requires a successfully captured payment';
  END IF;
  IF attempt_record."currency" IS DISTINCT FROM NEW."currency" THEN
    RAISE EXCEPTION 'Refund currency must equal the original payment currency';
  END IF;
  IF attempt_record."provider" IS DISTINCT FROM NEW."provider" THEN
    RAISE EXCEPTION 'Refund provider must equal the original payment provider';
  END IF;
  IF NEW."requestedAmountMinor" > attempt_record."amountMinor" THEN
    RAISE EXCEPTION 'Refund cannot exceed the captured payment amount';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Refund_enforce_ancestry_trigger"
BEFORE INSERT ON "Refund"
FOR EACH ROW EXECUTE FUNCTION "Refund_enforce_ancestry"();

CREATE FUNCTION "Refund_protect_identity"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Refund history is permanent and cannot be deleted';
  END IF;

  IF NEW."publicReference" IS DISTINCT FROM OLD."publicReference"
     OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
     OR NEW."paymentAttemptId" IS DISTINCT FROM OLD."paymentAttemptId"
     OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId"
     OR NEW."requestedByUserId" IS DISTINCT FROM OLD."requestedByUserId"
     OR NEW."initiator" IS DISTINCT FROM OLD."initiator"
     OR NEW."scope" IS DISTINCT FROM OLD."scope"
     OR NEW."requestedAmountMinor" IS DISTINCT FROM OLD."requestedAmountMinor"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."providerIdempotencyKey" IS DISTINCT FROM OLD."providerIdempotencyKey"
     OR NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Refund identity and financial snapshot are immutable';
  END IF;

  -- The external refund identifier is attached exactly once, after the provider
  -- call, so a provider retry can never rebind it to a second external refund.
  IF OLD."providerRefundId" IS NOT NULL
     AND NEW."providerRefundId" IS DISTINCT FROM OLD."providerRefundId" THEN
    RAISE EXCEPTION 'Provider refund identity is immutable once attached';
  END IF;

  -- Outcome timestamps are write-once, so the first valid terminal result is
  -- preserved even when a contradictory provider event arrives later.
  IF (OLD."succeededAt" IS NOT NULL AND NEW."succeededAt" IS DISTINCT FROM OLD."succeededAt")
     OR (OLD."failedAt" IS NOT NULL AND NEW."failedAt" IS DISTINCT FROM OLD."failedAt")
     OR (OLD."cancelledAt" IS NOT NULL AND NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt")
     OR (OLD."submittedAt" IS NOT NULL AND NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt") THEN
    RAISE EXCEPTION 'Refund outcome timestamps are immutable once set';
  END IF;

  IF OLD."status" = 'REQUIRES_REVIEW' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'A refund under review cannot leave review automatically';
  END IF;

  -- A terminal refund may only escalate to REQUIRES_REVIEW. It can never be
  -- revived, re-succeeded, or quietly rewritten.
  IF OLD."status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
     AND NEW."status" IS DISTINCT FROM OLD."status"
     AND NEW."status" IS DISTINCT FROM 'REQUIRES_REVIEW' THEN
    RAISE EXCEPTION 'A terminal refund result is immutable';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Refund_protect_identity_trigger"
BEFORE UPDATE OR DELETE ON "Refund"
FOR EACH ROW EXECUTE FUNCTION "Refund_protect_identity"();

-- ---------------------------------------------------------------------------
-- The over-refund guard.
--
-- Recomputing both aggregates on the parent PaymentAttempt takes a row lock on
-- it, which serializes every concurrent refund write for one payment. The CHECK
-- constraint on PaymentAttempt then rejects any total that would exceed the
-- captured amount. This is what makes concurrent over-refunding impossible
-- without relying on callers to lock anything themselves.
--
-- succeededAt, not status, decides what counts as refunded, so a refund that is
-- escalated to REQUIRES_REVIEW after succeeding is never counted twice.
-- ---------------------------------------------------------------------------

CREATE FUNCTION "Refund_maintain_payment_aggregate"() RETURNS trigger AS $$
DECLARE
  attempt_id TEXT;
BEGIN
  attempt_id := COALESCE(NEW."paymentAttemptId", OLD."paymentAttemptId");

  UPDATE "PaymentAttempt" SET
    "refundedMinor" = COALESCE((
      SELECT sum("requestedAmountMinor") FROM "Refund"
      WHERE "paymentAttemptId" = attempt_id AND "succeededAt" IS NOT NULL
    ), 0),
    "inFlightRefundMinor" = COALESCE((
      SELECT sum("requestedAmountMinor") FROM "Refund"
      WHERE "paymentAttemptId" = attempt_id
        AND "succeededAt" IS NULL
        AND "status" IN ('REQUESTED', 'SUBMITTING', 'PROCESSING', 'REQUIRES_REVIEW')
    ), 0)
  WHERE "id" = attempt_id;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Refund_maintain_payment_aggregate_trigger"
AFTER INSERT OR UPDATE OF "status", "succeededAt" ON "Refund"
FOR EACH ROW EXECUTE FUNCTION "Refund_maintain_payment_aggregate"();

-- ---------------------------------------------------------------------------
-- Seat-scoped refunds: ownership, snapshot fidelity, and no double refund.
-- ---------------------------------------------------------------------------

CREATE FUNCTION "RefundSeat_enforce_snapshot"() RETURNS trigger AS $$
DECLARE
  refund_record RECORD;
  seat_record RECORD;
  live_refund_count INTEGER;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Refunded-seat snapshots are immutable';
  END IF;

  SELECT "bookingId", "currency" INTO refund_record FROM "Refund" WHERE "id" = NEW."refundId";
  SELECT "bookingId", "priceMinor", "currency" INTO seat_record
  FROM "BookingSeat" WHERE "id" = NEW."bookingSeatId";

  IF seat_record."bookingId" IS DISTINCT FROM refund_record."bookingId" THEN
    RAISE EXCEPTION 'A refunded seat must belong to the refunded booking';
  END IF;
  IF seat_record."priceMinor" IS DISTINCT FROM NEW."priceMinor"
     OR seat_record."currency" IS DISTINCT FROM NEW."currency"
     OR refund_record."currency" IS DISTINCT FROM NEW."currency" THEN
    RAISE EXCEPTION 'Refunded-seat snapshot must match the original booked-seat price';
  END IF;

  -- A booked seat may never be refunded twice. Failed and cancelled refunds
  -- release their seats so a later retry is still possible.
  SELECT count(*) INTO live_refund_count
  FROM "RefundSeat" other_seat
  JOIN "Refund" other_refund ON other_refund."id" = other_seat."refundId"
  WHERE other_seat."bookingSeatId" = NEW."bookingSeatId"
    AND other_seat."refundId" <> NEW."refundId"
    AND (
      other_refund."succeededAt" IS NOT NULL
      OR other_refund."status" IN ('REQUESTED', 'SUBMITTING', 'PROCESSING', 'REQUIRES_REVIEW')
    );
  IF live_refund_count > 0 THEN
    RAISE EXCEPTION 'This seat is already covered by a live or completed refund';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RefundSeat_enforce_snapshot_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "RefundSeat"
FOR EACH ROW EXECUTE FUNCTION "RefundSeat_enforce_snapshot"();

-- A seat-scoped refund's amount must equal the sum of the seats it names.
CREATE FUNCTION "Refund_verify_seat_total"() RETURNS trigger AS $$
DECLARE
  target_refund_id TEXT;
  refund_record RECORD;
  seat_count INTEGER;
  seat_total BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'Refund' THEN
    target_refund_id := COALESCE(NEW."id", OLD."id");
  ELSE
    target_refund_id := COALESCE(NEW."refundId", OLD."refundId");
  END IF;

  SELECT "scope", "requestedAmountMinor" INTO refund_record
  FROM "Refund" WHERE "id" = target_refund_id;
  IF refund_record."scope" IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  SELECT count(*), COALESCE(sum("priceMinor"), 0) INTO seat_count, seat_total
  FROM "RefundSeat" WHERE "refundId" = target_refund_id;

  IF refund_record."scope" = 'SELECTED_SEATS' THEN
    IF seat_count < 1 OR seat_total <> refund_record."requestedAmountMinor" THEN
      RAISE EXCEPTION 'A seat-scoped refund must exactly equal the sum of its refunded seats';
    END IF;
  ELSIF refund_record."scope" = 'FULL_BOOKING' THEN
    IF seat_count > 0 AND seat_total <> refund_record."requestedAmountMinor" THEN
      RAISE EXCEPTION 'A full-booking refund that names seats must equal their total';
    END IF;
  ELSIF seat_count > 0 THEN
    RAISE EXCEPTION 'A fixed-amount refund must not name individual seats';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "Refund_verify_seat_total_refund_trigger"
AFTER INSERT OR UPDATE ON "Refund"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "Refund_verify_seat_total"();

CREATE CONSTRAINT TRIGGER "Refund_verify_seat_total_seat_trigger"
AFTER INSERT ON "RefundSeat"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "Refund_verify_seat_total"();

CREATE FUNCTION "RefundAttempt_protect_history"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Refund attempts are history and cannot be deleted';
  END IF;
  IF NEW."refundId" IS DISTINCT FROM OLD."refundId"
     OR NEW."attemptNumber" IS DISTINCT FROM OLD."attemptNumber"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
     OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Refund attempt identity is immutable';
  END IF;
  IF OLD."status" <> 'STARTED' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'A completed refund attempt is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RefundAttempt_protect_history_trigger"
BEFORE UPDATE OR DELETE ON "RefundAttempt"
FOR EACH ROW EXECUTE FUNCTION "RefundAttempt_protect_history"();

-- ---------------------------------------------------------------------------
-- Disputes. Ancestry derives from the payment; terminal outcomes are preserved.
-- ---------------------------------------------------------------------------

CREATE FUNCTION "PaymentDispute_enforce_ancestry"() RETURNS trigger AS $$
DECLARE
  attempt_record RECORD;
  booking_order_id TEXT;
BEGIN
  SELECT "orderId", "provider", "currency", "amountMinor"
    INTO attempt_record
  FROM "PaymentAttempt" WHERE "id" = NEW."paymentAttemptId";

  IF attempt_record."orderId" IS DISTINCT FROM NEW."orderId" THEN
    RAISE EXCEPTION 'Dispute must reference the payment attempt''s own order';
  END IF;
  IF attempt_record."provider" IS DISTINCT FROM NEW."provider" THEN
    RAISE EXCEPTION 'Dispute provider must equal the original payment provider';
  END IF;
  IF attempt_record."currency" IS DISTINCT FROM NEW."currency" THEN
    RAISE EXCEPTION 'Dispute currency must equal the original payment currency';
  END IF;
  IF NEW."disputedAmountMinor" > attempt_record."amountMinor" THEN
    RAISE EXCEPTION 'Dispute cannot exceed the captured payment amount';
  END IF;
  IF NEW."bookingId" IS NOT NULL THEN
    SELECT "orderId" INTO booking_order_id FROM "Booking" WHERE "id" = NEW."bookingId";
    IF booking_order_id IS DISTINCT FROM NEW."orderId" THEN
      RAISE EXCEPTION 'Dispute booking must belong to the same order';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PaymentDispute_enforce_ancestry_trigger"
BEFORE INSERT ON "PaymentDispute"
FOR EACH ROW EXECUTE FUNCTION "PaymentDispute_enforce_ancestry"();

CREATE FUNCTION "PaymentDispute_protect_identity"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Disputes are financial history and cannot be deleted';
  END IF;
  IF NEW."publicReference" IS DISTINCT FROM OLD."publicReference"
     OR NEW."paymentAttemptId" IS DISTINCT FROM OLD."paymentAttemptId"
     OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."providerDisputeId" IS DISTINCT FROM OLD."providerDisputeId"
     OR NEW."disputedAmountMinor" IS DISTINCT FROM OLD."disputedAmountMinor"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."openedAt" IS DISTINCT FROM OLD."openedAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Dispute identity and financial snapshot are immutable';
  END IF;
  IF OLD."closedAt" IS NOT NULL AND NEW."closedAt" IS DISTINCT FROM OLD."closedAt" THEN
    RAISE EXCEPTION 'Dispute closure timestamp is immutable once set';
  END IF;
  IF OLD."outcome" IS NOT NULL AND NEW."outcome" IS DISTINCT FROM OLD."outcome" THEN
    RAISE EXCEPTION 'The first dispute outcome is immutable';
  END IF;
  IF OLD."status" = 'REQUIRES_REVIEW' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'A dispute under review cannot leave review automatically';
  END IF;
  -- A closed dispute may only escalate to REQUIRES_REVIEW, which is how a
  -- contradictory provider terminal event is recorded without losing the first.
  IF OLD."status" IN ('WON', 'LOST', 'CLOSED')
     AND NEW."status" IS DISTINCT FROM OLD."status"
     AND NEW."status" IS DISTINCT FROM 'REQUIRES_REVIEW' THEN
    RAISE EXCEPTION 'A terminal dispute outcome is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PaymentDispute_protect_identity_trigger"
BEFORE UPDATE OR DELETE ON "PaymentDispute"
FOR EACH ROW EXECUTE FUNCTION "PaymentDispute_protect_identity"();

CREATE FUNCTION "PaymentDisputeEvent_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Dispute event history is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PaymentDisputeEvent_append_only_trigger"
BEFORE UPDATE OR DELETE ON "PaymentDisputeEvent"
FOR EACH ROW EXECUTE FUNCTION "PaymentDisputeEvent_append_only"();

-- ---------------------------------------------------------------------------
-- The ledger is append-only, full stop. There is no privileged path that can
-- update or delete a written financial entry.
-- ---------------------------------------------------------------------------

CREATE FUNCTION "FinancialLedgerEntry_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Financial ledger entries are append-only and can never be updated or deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FinancialLedgerEntry_append_only_trigger"
BEFORE UPDATE OR DELETE ON "FinancialLedgerEntry"
FOR EACH ROW EXECUTE FUNCTION "FinancialLedgerEntry_append_only"();

CREATE FUNCTION "FinancialLedgerEntry_enforce_ancestry"() RETURNS trigger AS $$
DECLARE
  attempt_record RECORD;
  refund_record RECORD;
  dispute_record RECORD;
  booking_order_id TEXT;
BEGIN
  SELECT "orderId", "provider", "currency" INTO attempt_record
  FROM "PaymentAttempt" WHERE "id" = NEW."paymentAttemptId";

  IF attempt_record."orderId" IS DISTINCT FROM NEW."orderId" THEN
    RAISE EXCEPTION 'Ledger entry must reference the payment attempt''s own order';
  END IF;
  IF attempt_record."provider" IS DISTINCT FROM NEW."provider" THEN
    RAISE EXCEPTION 'Ledger entry provider must equal the payment provider';
  END IF;
  IF attempt_record."currency" IS DISTINCT FROM NEW."currency" THEN
    RAISE EXCEPTION 'Ledger entry currency must equal the payment currency';
  END IF;

  IF NEW."bookingId" IS NOT NULL THEN
    SELECT "orderId" INTO booking_order_id FROM "Booking" WHERE "id" = NEW."bookingId";
    IF booking_order_id IS DISTINCT FROM NEW."orderId" THEN
      RAISE EXCEPTION 'Ledger entry booking must belong to the same order';
    END IF;
  END IF;

  IF NEW."refundId" IS NOT NULL THEN
    SELECT "paymentAttemptId", "currency" INTO refund_record
    FROM "Refund" WHERE "id" = NEW."refundId";
    IF refund_record."paymentAttemptId" IS DISTINCT FROM NEW."paymentAttemptId"
       OR refund_record."currency" IS DISTINCT FROM NEW."currency" THEN
      RAISE EXCEPTION 'Ledger entry refund ancestry is invalid';
    END IF;
  END IF;

  IF NEW."disputeId" IS NOT NULL THEN
    SELECT "paymentAttemptId", "currency" INTO dispute_record
    FROM "PaymentDispute" WHERE "id" = NEW."disputeId";
    IF dispute_record."paymentAttemptId" IS DISTINCT FROM NEW."paymentAttemptId"
       OR dispute_record."currency" IS DISTINCT FROM NEW."currency" THEN
      RAISE EXCEPTION 'Ledger entry dispute ancestry is invalid';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FinancialLedgerEntry_enforce_ancestry_trigger"
BEFORE INSERT ON "FinancialLedgerEntry"
FOR EACH ROW EXECUTE FUNCTION "FinancialLedgerEntry_enforce_ancestry"();

-- ---------------------------------------------------------------------------
-- Verified webhook envelopes now cover refund and dispute events too. The
-- envelope stays immutable; only the processing outcome and the one-time link
-- to a refund or dispute may still be written.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "PaymentWebhookEvent_protect_envelope"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Verified webhook records cannot be deleted';
  END IF;
  IF NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."providerEventId" IS DISTINCT FROM OLD."providerEventId"
     OR NEW."eventType" IS DISTINCT FROM OLD."eventType"
     OR NEW."eventCategory" IS DISTINCT FROM OLD."eventCategory"
     OR NEW."providerIntentId" IS DISTINCT FROM OLD."providerIntentId"
     OR NEW."paymentAttemptId" IS DISTINCT FROM OLD."paymentAttemptId"
     OR NEW."normalizedStatus" IS DISTINCT FROM OLD."normalizedStatus"
     OR NEW."normalizedRefundStatus" IS DISTINCT FROM OLD."normalizedRefundStatus"
     OR NEW."normalizedDisputeStatus" IS DISTINCT FROM OLD."normalizedDisputeStatus"
     OR NEW."providerRefundId" IS DISTINCT FROM OLD."providerRefundId"
     OR NEW."providerDisputeId" IS DISTINCT FROM OLD."providerDisputeId"
     OR NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."signatureStatus" IS DISTINCT FROM OLD."signatureStatus"
     OR NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt"
     OR NEW."providerOccurredAt" IS DISTINCT FROM OLD."providerOccurredAt"
     OR NEW."payloadHash" IS DISTINCT FROM OLD."payloadHash" THEN
    RAISE EXCEPTION 'Verified webhook envelope is immutable';
  END IF;
  IF OLD."refundId" IS NOT NULL AND NEW."refundId" IS DISTINCT FROM OLD."refundId" THEN
    RAISE EXCEPTION 'Webhook refund linkage is immutable once attached';
  END IF;
  IF OLD."disputeId" IS NOT NULL AND NEW."disputeId" IS DISTINCT FROM OLD."disputeId" THEN
    RAISE EXCEPTION 'Webhook dispute linkage is immutable once attached';
  END IF;
  IF OLD."processingStatus" IN ('PROCESSED', 'REQUIRES_REVIEW')
     AND NEW."processingStatus" IS DISTINCT FROM OLD."processingStatus" THEN
    RAISE EXCEPTION 'Processed webhook outcome is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- A booking may now reach the deliberate terminal REFUNDED state. Everything
-- else about a confirmed booking stays immutable, including totalMinor: the
-- amount the customer originally paid is never rewritten by a refund.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "Booking_protect_snapshot"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Confirmed bookings cannot be deleted';
  END IF;

  IF NEW."publicReference" IS DISTINCT FROM OLD."publicReference"
     OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
     OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."eventId" IS DISTINCT FROM OLD."eventId"
     OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."totalMinor" IS DISTINCT FROM OLD."totalMinor"
     OR NEW."confirmedAt" IS DISTINCT FROM OLD."confirmedAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Confirmed booking identity and financial snapshots are immutable';
  END IF;

  IF OLD."status" = 'REFUNDED' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'A refunded booking is terminal and cannot be revived';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NEW."status" <> 'REFUNDED' THEN
    RAISE EXCEPTION 'A confirmed booking may only move to REFUNDED';
  END IF;
  IF OLD."refundedAt" IS NOT NULL AND NEW."refundedAt" IS DISTINCT FROM OLD."refundedAt" THEN
    RAISE EXCEPTION 'Booking refund timestamp is immutable once set';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A booking may only be marked fully refunded once its refunds actually cover
-- the amount paid. This is the database's own check that a REFUNDED booking is
-- not merely an application-level label.
CREATE FUNCTION "Booking_verify_refund_completion"() RETURNS trigger AS $$
DECLARE
  succeeded_total BIGINT;
BEGIN
  IF NEW."status" <> 'REFUNDED' THEN RETURN NEW; END IF;

  SELECT COALESCE(sum("requestedAmountMinor"), 0) INTO succeeded_total
  FROM "Refund"
  WHERE "bookingId" = NEW."id" AND "succeededAt" IS NOT NULL;

  IF succeeded_total < NEW."totalMinor" THEN
    RAISE EXCEPTION 'A booking cannot be marked refunded before its refunds cover the amount paid';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "Booking_verify_refund_completion_trigger"
AFTER UPDATE OF "status" ON "Booking"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "Booking_verify_refund_completion"();

-- ---------------------------------------------------------------------------
-- The financial outbox is a hand-off boundary, not financial authority. Its
-- payload and identity are immutable; only delivery bookkeeping may change.
-- ---------------------------------------------------------------------------

CREATE FUNCTION "FinancialOutbox_protect_payload"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Financial outbox rows are history and cannot be deleted';
  END IF;
  IF NEW."eventType" IS DISTINCT FROM OLD."eventType"
     OR NEW."payload"::text IS DISTINCT FROM OLD."payload"::text
     OR NEW."deduplicationKey" IS DISTINCT FROM OLD."deduplicationKey"
     OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
     OR NEW."refundId" IS DISTINCT FROM OLD."refundId"
     OR NEW."disputeId" IS DISTINCT FROM OLD."disputeId"
     OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Financial outbox identity and payload are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FinancialOutbox_protect_payload_trigger"
BEFORE UPDATE OR DELETE ON "FinancialOutbox"
FOR EACH ROW EXECUTE FUNCTION "FinancialOutbox_protect_payload"();
