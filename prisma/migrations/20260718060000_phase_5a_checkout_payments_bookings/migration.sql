-- =============================================================================
-- Phase 5A: checkout orders, verified payment webhooks, and exact-once booking
-- conversion. PostgreSQL remains authoritative. Redis and browser redirects
-- are not referenced by any financial or allocation invariant.
-- =============================================================================

ALTER TYPE "SeatInventoryState" ADD VALUE 'BOOKED';
ALTER TYPE "SeatHoldStatus" ADD VALUE 'CONVERTED';

ALTER TYPE "InventoryEventType" ADD VALUE 'CHECKOUT_CREATED';
ALTER TYPE "InventoryEventType" ADD VALUE 'PAYMENT_INTENT_CREATED';
ALTER TYPE "InventoryEventType" ADD VALUE 'PAYMENT_SUCCEEDED';
ALTER TYPE "InventoryEventType" ADD VALUE 'PAYMENT_FAILED';
ALTER TYPE "InventoryEventType" ADD VALUE 'INVENTORY_BOOKED';
ALTER TYPE "InventoryEventType" ADD VALUE 'BOOKING_CONFIRMED';
ALTER TYPE "InventoryEventType" ADD VALUE 'PAYMENT_REQUIRES_REVIEW';

CREATE TYPE "CheckoutOrderStatus" AS ENUM (
  'PENDING',
  'PAYMENT_PENDING',
  'PAID',
  'FULFILLED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
  'PAID_UNFULFILLED',
  'REQUIRES_REVIEW'
);

CREATE TYPE "PaymentProviderName" AS ENUM ('LOCAL_SIGNED', 'EXTERNAL');

CREATE TYPE "PaymentAttemptStatus" AS ENUM (
  'CREATED',
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'REQUIRES_REVIEW'
);

CREATE TYPE "PaymentWebhookSignatureStatus" AS ENUM ('VERIFIED', 'INVALID');

CREATE TYPE "PaymentWebhookProcessingStatus" AS ENUM (
  'RECEIVED',
  'PROCESSED',
  'REQUIRES_REVIEW',
  'FAILED'
);

CREATE TYPE "BookingStatus" AS ENUM ('CONFIRMED');

ALTER TABLE "SeatHold" ADD COLUMN "convertedAt" TIMESTAMPTZ(3);

CREATE TABLE "CheckoutOrder" (
  "id" TEXT NOT NULL,
  "publicReference" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "sourceHoldId" TEXT NOT NULL,
  "status" "CheckoutOrderStatus" NOT NULL DEFAULT 'PENDING',
  "currency" "Currency" NOT NULL,
  "subtotalMinor" INTEGER NOT NULL,
  "totalMinor" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "checkoutExpiresAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "paidAt" TIMESTAMPTZ(3),
  "fulfilledAt" TIMESTAMPTZ(3),
  "failedAt" TIMESTAMPTZ(3),
  "cancelledAt" TIMESTAMPTZ(3),
  "expiredAt" TIMESTAMPTZ(3),
  "safeFailureCode" TEXT,
  "version" INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT "CheckoutOrder_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CheckoutOrder_public_reference_check" CHECK (
    char_length("publicReference") BETWEEN 24 AND 191
    AND "publicReference" ~ '^[A-Za-z0-9_-]+$'
  ),
  CONSTRAINT "CheckoutOrder_idempotency_key_check" CHECK (
    char_length("idempotencyKey") BETWEEN 1 AND 191
  ),
  CONSTRAINT "CheckoutOrder_amount_check" CHECK (
    "subtotalMinor" >= 0 AND "totalMinor" >= 0 AND "subtotalMinor" = "totalMinor"
  ),
  CONSTRAINT "CheckoutOrder_version_check" CHECK ("version" >= 0),
  CONSTRAINT "CheckoutOrder_expiration_check" CHECK ("checkoutExpiresAt" > "createdAt"),
  CONSTRAINT "CheckoutOrder_failure_code_check" CHECK (
    "safeFailureCode" IS NULL
    OR (
      char_length("safeFailureCode") BETWEEN 1 AND 80
      AND "safeFailureCode" ~ '^[A-Z0-9_:-]+$'
    )
  ),
  CONSTRAINT "CheckoutOrder_lifecycle_check" CHECK (
    ("status" IN ('PENDING', 'PAYMENT_PENDING')
      AND "paidAt" IS NULL AND "fulfilledAt" IS NULL AND "failedAt" IS NULL
      AND "cancelledAt" IS NULL AND "expiredAt" IS NULL)
    OR ("status" = 'PAID'
      AND "paidAt" IS NOT NULL AND "fulfilledAt" IS NULL AND "failedAt" IS NULL
      AND "cancelledAt" IS NULL AND "expiredAt" IS NULL)
    OR ("status" = 'FULFILLED'
      AND "paidAt" IS NOT NULL AND "fulfilledAt" IS NOT NULL AND "failedAt" IS NULL
      AND "cancelledAt" IS NULL AND "expiredAt" IS NULL AND "safeFailureCode" IS NULL)
    OR ("status" = 'FAILED'
      AND "paidAt" IS NULL AND "fulfilledAt" IS NULL AND "failedAt" IS NOT NULL
      AND "cancelledAt" IS NULL AND "expiredAt" IS NULL)
    OR ("status" = 'CANCELLED'
      AND "paidAt" IS NULL AND "fulfilledAt" IS NULL AND "failedAt" IS NULL
      AND "cancelledAt" IS NOT NULL AND "expiredAt" IS NULL)
    OR ("status" = 'EXPIRED'
      AND "paidAt" IS NULL AND "fulfilledAt" IS NULL AND "failedAt" IS NULL
      AND "cancelledAt" IS NULL AND "expiredAt" IS NOT NULL)
    OR ("status" = 'PAID_UNFULFILLED'
      AND "paidAt" IS NOT NULL AND "fulfilledAt" IS NULL AND "failedAt" IS NULL
      AND "cancelledAt" IS NULL AND "expiredAt" IS NULL AND "safeFailureCode" IS NOT NULL)
    OR ("status" = 'REQUIRES_REVIEW'
      AND "fulfilledAt" IS NULL AND "cancelledAt" IS NULL AND "expiredAt" IS NULL
      AND "safeFailureCode" IS NOT NULL)
  )
);

CREATE TABLE "CheckoutOrderItem" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "inventoryId" TEXT NOT NULL,
  "seatId" TEXT NOT NULL,
  "sectionId" TEXT NOT NULL,
  "priceTierId" TEXT NOT NULL,
  "seatLabel" TEXT NOT NULL,
  "rowLabel" TEXT NOT NULL,
  "sectionName" TEXT NOT NULL,
  "sectionCode" TEXT NOT NULL,
  "tierName" TEXT NOT NULL,
  "tierCode" TEXT NOT NULL,
  "priceMinor" INTEGER NOT NULL,
  "currency" "Currency" NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CheckoutOrderItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CheckoutOrderItem_price_check" CHECK ("priceMinor" >= 0),
  CONSTRAINT "CheckoutOrderItem_snapshot_text_check" CHECK (
    char_length("seatLabel") BETWEEN 1 AND 80
    AND char_length("rowLabel") BETWEEN 1 AND 80
    AND char_length("sectionName") BETWEEN 1 AND 160
    AND char_length("sectionCode") BETWEEN 1 AND 80
    AND char_length("tierName") BETWEEN 1 AND 80
    AND char_length("tierCode") BETWEEN 1 AND 20
  )
);

CREATE TABLE "PaymentAttempt" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "provider" "PaymentProviderName" NOT NULL,
  "providerIntentId" TEXT,
  "providerIdempotencyKey" TEXT NOT NULL,
  "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'CREATED',
  "amountMinor" INTEGER NOT NULL,
  "currency" "Currency" NOT NULL,
  "lastProviderStatus" TEXT,
  "safeFailureCode" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "succeededAt" TIMESTAMPTZ(3),
  "failedAt" TIMESTAMPTZ(3),
  "cancelledAt" TIMESTAMPTZ(3),

  CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentAttempt_amount_check" CHECK ("amountMinor" >= 0),
  CONSTRAINT "PaymentAttempt_idempotency_key_check" CHECK (
    char_length("providerIdempotencyKey") BETWEEN 24 AND 191
    AND "providerIdempotencyKey" ~ '^[A-Za-z0-9_:-]+$'
  ),
  CONSTRAINT "PaymentAttempt_provider_intent_check" CHECK (
    "providerIntentId" IS NULL OR char_length("providerIntentId") BETWEEN 1 AND 191
  ),
  CONSTRAINT "PaymentAttempt_safe_text_check" CHECK (
    ("lastProviderStatus" IS NULL OR char_length("lastProviderStatus") <= 80)
    AND (
      "safeFailureCode" IS NULL
      OR (char_length("safeFailureCode") BETWEEN 1 AND 80 AND "safeFailureCode" ~ '^[A-Z0-9_:-]+$')
    )
  ),
  CONSTRAINT "PaymentAttempt_lifecycle_check" CHECK (
    ("status" IN ('CREATED', 'PENDING')
      AND "succeededAt" IS NULL AND "failedAt" IS NULL AND "cancelledAt" IS NULL)
    OR ("status" = 'SUCCEEDED'
      AND "succeededAt" IS NOT NULL AND "failedAt" IS NULL AND "cancelledAt" IS NULL)
    OR ("status" = 'FAILED'
      AND "succeededAt" IS NULL AND "failedAt" IS NOT NULL AND "cancelledAt" IS NULL)
    OR ("status" = 'CANCELLED'
      AND "succeededAt" IS NULL AND "failedAt" IS NULL AND "cancelledAt" IS NOT NULL)
    OR ("status" = 'REQUIRES_REVIEW'
      AND "safeFailureCode" IS NOT NULL)
  )
);

CREATE TABLE "PaymentWebhookEvent" (
  "id" TEXT NOT NULL,
  "provider" "PaymentProviderName" NOT NULL,
  "providerEventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "providerIntentId" TEXT NOT NULL,
  "paymentAttemptId" TEXT,
  "normalizedStatus" "PaymentAttemptStatus" NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "currency" "Currency" NOT NULL,
  "signatureStatus" "PaymentWebhookSignatureStatus" NOT NULL,
  "processingStatus" "PaymentWebhookProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
  "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMPTZ(3),
  "providerOccurredAt" TIMESTAMPTZ(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "safeProcessingError" TEXT,
  "payloadHash" CHAR(64) NOT NULL,

  CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentWebhookEvent_identity_check" CHECK (
    char_length("providerEventId") BETWEEN 1 AND 191
    AND char_length("providerIntentId") BETWEEN 1 AND 191
    AND char_length("eventType") BETWEEN 1 AND 120
  ),
  CONSTRAINT "PaymentWebhookEvent_attempt_check" CHECK ("attemptCount" >= 0),
  CONSTRAINT "PaymentWebhookEvent_amount_check" CHECK ("amountMinor" >= 0),
  CONSTRAINT "PaymentWebhookEvent_signature_check" CHECK ("signatureStatus" = 'VERIFIED'),
  CONSTRAINT "PaymentWebhookEvent_hash_check" CHECK ("payloadHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "PaymentWebhookEvent_error_check" CHECK (
    "safeProcessingError" IS NULL OR char_length("safeProcessingError") <= 240
  ),
  CONSTRAINT "PaymentWebhookEvent_processing_check" CHECK (
    ("processingStatus" IN ('RECEIVED', 'FAILED') AND "processedAt" IS NULL)
    OR ("processingStatus" IN ('PROCESSED', 'REQUIRES_REVIEW') AND "processedAt" IS NOT NULL)
  )
);

CREATE TABLE "Booking" (
  "id" TEXT NOT NULL,
  "publicReference" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "status" "BookingStatus" NOT NULL DEFAULT 'CONFIRMED',
  "currency" "Currency" NOT NULL,
  "totalMinor" INTEGER NOT NULL,
  "confirmedAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Booking_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Booking_public_reference_check" CHECK (
    char_length("publicReference") BETWEEN 24 AND 191
    AND "publicReference" ~ '^[A-Za-z0-9_-]+$'
  ),
  CONSTRAINT "Booking_amount_check" CHECK ("totalMinor" >= 0),
  CONSTRAINT "Booking_time_check" CHECK ("confirmedAt" >= "createdAt")
);

CREATE TABLE "BookingSeat" (
  "id" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "inventoryId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "seatId" TEXT NOT NULL,
  "sectionId" TEXT NOT NULL,
  "priceTierId" TEXT NOT NULL,
  "seatLabel" TEXT NOT NULL,
  "rowLabel" TEXT NOT NULL,
  "sectionName" TEXT NOT NULL,
  "sectionCode" TEXT NOT NULL,
  "tierName" TEXT NOT NULL,
  "tierCode" TEXT NOT NULL,
  "priceMinor" INTEGER NOT NULL,
  "currency" "Currency" NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BookingSeat_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookingSeat_price_check" CHECK ("priceMinor" >= 0),
  CONSTRAINT "BookingSeat_snapshot_text_check" CHECK (
    char_length("seatLabel") BETWEEN 1 AND 80
    AND char_length("rowLabel") BETWEEN 1 AND 80
    AND char_length("sectionName") BETWEEN 1 AND 160
    AND char_length("sectionCode") BETWEEN 1 AND 80
    AND char_length("tierName") BETWEEN 1 AND 80
    AND char_length("tierCode") BETWEEN 1 AND 20
  )
);

CREATE UNIQUE INDEX "CheckoutOrder_publicReference_key" ON "CheckoutOrder"("publicReference");
CREATE UNIQUE INDEX "CheckoutOrder_sourceHoldId_key" ON "CheckoutOrder"("sourceHoldId");
CREATE UNIQUE INDEX "CheckoutOrder_userId_sourceHoldId_idempotencyKey_key"
  ON "CheckoutOrder"("userId", "sourceHoldId", "idempotencyKey");
CREATE INDEX "CheckoutOrder_userId_createdAt_idx" ON "CheckoutOrder"("userId", "createdAt");
CREATE INDEX "CheckoutOrder_organizationId_status_idx" ON "CheckoutOrder"("organizationId", "status");
CREATE INDEX "CheckoutOrder_eventId_status_idx" ON "CheckoutOrder"("eventId", "status");
CREATE INDEX "CheckoutOrder_sessionId_status_idx" ON "CheckoutOrder"("sessionId", "status");
CREATE INDEX "CheckoutOrder_status_checkoutExpiresAt_idx" ON "CheckoutOrder"("status", "checkoutExpiresAt");

CREATE UNIQUE INDEX "CheckoutOrderItem_orderId_inventoryId_key" ON "CheckoutOrderItem"("orderId", "inventoryId");
CREATE UNIQUE INDEX "CheckoutOrderItem_orderId_seatId_key" ON "CheckoutOrderItem"("orderId", "seatId");
CREATE INDEX "CheckoutOrderItem_inventoryId_idx" ON "CheckoutOrderItem"("inventoryId");
CREATE INDEX "CheckoutOrderItem_seatId_idx" ON "CheckoutOrderItem"("seatId");
CREATE INDEX "CheckoutOrderItem_sectionId_idx" ON "CheckoutOrderItem"("sectionId");
CREATE INDEX "CheckoutOrderItem_priceTierId_idx" ON "CheckoutOrderItem"("priceTierId");

CREATE UNIQUE INDEX "PaymentAttempt_providerIdempotencyKey_key" ON "PaymentAttempt"("providerIdempotencyKey");
CREATE UNIQUE INDEX "PaymentAttempt_orderId_provider_key" ON "PaymentAttempt"("orderId", "provider");
CREATE UNIQUE INDEX "PaymentAttempt_provider_providerIntentId_key" ON "PaymentAttempt"("provider", "providerIntentId");
CREATE INDEX "PaymentAttempt_status_updatedAt_idx" ON "PaymentAttempt"("status", "updatedAt");

CREATE UNIQUE INDEX "PaymentWebhookEvent_provider_providerEventId_key"
  ON "PaymentWebhookEvent"("provider", "providerEventId");
CREATE INDEX "PaymentWebhookEvent_paymentAttemptId_receivedAt_idx"
  ON "PaymentWebhookEvent"("paymentAttemptId", "receivedAt");
CREATE INDEX "PaymentWebhookEvent_processingStatus_receivedAt_idx"
  ON "PaymentWebhookEvent"("processingStatus", "receivedAt");
CREATE INDEX "PaymentWebhookEvent_provider_providerIntentId_idx"
  ON "PaymentWebhookEvent"("provider", "providerIntentId");

CREATE UNIQUE INDEX "Booking_publicReference_key" ON "Booking"("publicReference");
CREATE UNIQUE INDEX "Booking_orderId_key" ON "Booking"("orderId");
CREATE INDEX "Booking_userId_confirmedAt_idx" ON "Booking"("userId", "confirmedAt");
CREATE INDEX "Booking_organizationId_confirmedAt_idx" ON "Booking"("organizationId", "confirmedAt");
CREATE INDEX "Booking_eventId_confirmedAt_idx" ON "Booking"("eventId", "confirmedAt");
CREATE INDEX "Booking_sessionId_confirmedAt_idx" ON "Booking"("sessionId", "confirmedAt");

CREATE UNIQUE INDEX "BookingSeat_inventoryId_key" ON "BookingSeat"("inventoryId");
CREATE UNIQUE INDEX "BookingSeat_bookingId_inventoryId_key" ON "BookingSeat"("bookingId", "inventoryId");
CREATE UNIQUE INDEX "BookingSeat_sessionId_seatId_key" ON "BookingSeat"("sessionId", "seatId");
CREATE INDEX "BookingSeat_bookingId_idx" ON "BookingSeat"("bookingId");
CREATE INDEX "BookingSeat_sessionId_idx" ON "BookingSeat"("sessionId");
CREATE INDEX "BookingSeat_seatId_idx" ON "BookingSeat"("seatId");
CREATE INDEX "BookingSeat_sectionId_idx" ON "BookingSeat"("sectionId");
CREATE INDEX "BookingSeat_priceTierId_idx" ON "BookingSeat"("priceTierId");

ALTER TABLE "CheckoutOrder" ADD CONSTRAINT "CheckoutOrder_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CheckoutOrder" ADD CONSTRAINT "CheckoutOrder_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CheckoutOrder" ADD CONSTRAINT "CheckoutOrder_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CheckoutOrder" ADD CONSTRAINT "CheckoutOrder_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "EventSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CheckoutOrder" ADD CONSTRAINT "CheckoutOrder_sourceHoldId_fkey"
  FOREIGN KEY ("sourceHoldId") REFERENCES "SeatHold"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CheckoutOrderItem" ADD CONSTRAINT "CheckoutOrderItem_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "CheckoutOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CheckoutOrderItem" ADD CONSTRAINT "CheckoutOrderItem_inventoryId_fkey"
  FOREIGN KEY ("inventoryId") REFERENCES "SessionSeatInventory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CheckoutOrderItem" ADD CONSTRAINT "CheckoutOrderItem_seatId_fkey"
  FOREIGN KEY ("seatId") REFERENCES "Seat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CheckoutOrderItem" ADD CONSTRAINT "CheckoutOrderItem_sectionId_fkey"
  FOREIGN KEY ("sectionId") REFERENCES "SeatSection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CheckoutOrderItem" ADD CONSTRAINT "CheckoutOrderItem_priceTierId_fkey"
  FOREIGN KEY ("priceTierId") REFERENCES "SessionPriceTier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "CheckoutOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentWebhookEvent" ADD CONSTRAINT "PaymentWebhookEvent_paymentAttemptId_fkey"
  FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Booking" ADD CONSTRAINT "Booking_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "CheckoutOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "EventSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BookingSeat" ADD CONSTRAINT "BookingSeat_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BookingSeat" ADD CONSTRAINT "BookingSeat_inventoryId_fkey"
  FOREIGN KEY ("inventoryId") REFERENCES "SessionSeatInventory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BookingSeat" ADD CONSTRAINT "BookingSeat_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "EventSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BookingSeat" ADD CONSTRAINT "BookingSeat_seatId_fkey"
  FOREIGN KEY ("seatId") REFERENCES "Seat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BookingSeat" ADD CONSTRAINT "BookingSeat_sectionId_fkey"
  FOREIGN KEY ("sectionId") REFERENCES "SeatSection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BookingSeat" ADD CONSTRAINT "BookingSeat_priceTierId_fkey"
  FOREIGN KEY ("priceTierId") REFERENCES "SessionPriceTier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Extend authoritative inventory and hold lifecycle consistency.
ALTER TABLE "SessionSeatInventory" DROP CONSTRAINT "SessionSeatInventory_state_check";
ALTER TABLE "SessionSeatInventory" ADD CONSTRAINT "SessionSeatInventory_state_check" CHECK (
  ("state" = 'AVAILABLE' AND "currentHoldId" IS NULL AND "holdExpiresAt" IS NULL)
  OR ("state" = 'HELD' AND "currentHoldId" IS NOT NULL AND "holdExpiresAt" IS NOT NULL)
  OR ("state" = 'BOOKED' AND "currentHoldId" IS NULL AND "holdExpiresAt" IS NULL)
);

ALTER TABLE "SeatHold" DROP CONSTRAINT "SeatHold_lifecycle_check";
ALTER TABLE "SeatHold" ADD CONSTRAINT "SeatHold_lifecycle_check" CHECK (
  ("status" = 'ACTIVE' AND "releasedAt" IS NULL AND "expiredAt" IS NULL AND "convertedAt" IS NULL)
  OR ("status" = 'RELEASED' AND "releasedAt" IS NOT NULL AND "expiredAt" IS NULL AND "convertedAt" IS NULL)
  OR ("status" = 'EXPIRED' AND "expiredAt" IS NOT NULL AND "releasedAt" IS NULL AND "convertedAt" IS NULL)
  OR ("status" = 'CONVERTED' AND "convertedAt" IS NOT NULL AND "releasedAt" IS NULL AND "expiredAt" IS NULL)
);

CREATE OR REPLACE FUNCTION "SeatHold_protect_identity"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Holds are historical and cannot be deleted';
  END IF;

  IF NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
     OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."publicToken" IS DISTINCT FROM OLD."publicToken"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Hold identity is immutable';
  END IF;

  IF OLD."status" IN ('RELEASED', 'EXPIRED', 'CONVERTED')
     AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'A terminal hold cannot be revived or changed';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "SessionSeatInventory_protect_snapshot"() RETURNS trigger AS $$
DECLARE
  hold_session_id TEXT;
  booking_seat_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Session seat inventory is permanent and cannot be deleted';
  END IF;

  IF NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
     OR NEW."seatId" IS DISTINCT FROM OLD."seatId"
     OR NEW."sectionId" IS DISTINCT FROM OLD."sectionId"
     OR NEW."priceTierId" IS DISTINCT FROM OLD."priceTierId"
     OR NEW."priceMinor" IS DISTINCT FROM OLD."priceMinor"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Session seat inventory ancestry and price snapshot are immutable';
  END IF;

  IF OLD."state" = 'BOOKED' AND NEW."state" IS DISTINCT FROM 'BOOKED' THEN
    RAISE EXCEPTION 'Booked inventory is permanent and cannot become available or held';
  END IF;

  IF NEW."currentHoldId" IS NOT NULL THEN
    SELECT "sessionId" INTO hold_session_id FROM "SeatHold" WHERE "id" = NEW."currentHoldId";
    IF hold_session_id IS DISTINCT FROM NEW."sessionId" THEN
      RAISE EXCEPTION 'The active hold belongs to a different session';
    END IF;
  END IF;

  IF NEW."state" = 'BOOKED' AND OLD."state" IS DISTINCT FROM 'BOOKED' THEN
    SELECT count(*) INTO booking_seat_count
    FROM "BookingSeat"
    WHERE "inventoryId" = NEW."id"
      AND "sessionId" = NEW."sessionId"
      AND "seatId" = NEW."seatId";
    IF booking_seat_count <> 1 THEN
      RAISE EXCEPTION 'Inventory can only become booked after its unique booking seat exists';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Order identity/ancestry is immutable and derives from the source hold graph.
CREATE FUNCTION "CheckoutOrder_enforce_ancestry"() RETURNS trigger AS $$
DECLARE
  hold_session_id TEXT;
  hold_user_id TEXT;
  hold_expiry TIMESTAMPTZ(3);
  session_event_id TEXT;
  event_organization_id TEXT;
BEGIN
  SELECT "sessionId", "userId", "expiresAt"
    INTO hold_session_id, hold_user_id, hold_expiry
  FROM "SeatHold" WHERE "id" = NEW."sourceHoldId";
  SELECT "eventId" INTO session_event_id FROM "EventSession" WHERE "id" = NEW."sessionId";
  SELECT "organizerOrganizationId" INTO event_organization_id FROM "Event" WHERE "id" = NEW."eventId";

  IF hold_session_id IS DISTINCT FROM NEW."sessionId"
     OR hold_user_id IS DISTINCT FROM NEW."userId" THEN
    RAISE EXCEPTION 'Checkout order must use the source hold customer and session';
  END IF;
  IF session_event_id IS DISTINCT FROM NEW."eventId"
     OR event_organization_id IS DISTINCT FROM NEW."organizationId" THEN
    RAISE EXCEPTION 'Checkout order event ancestry is invalid';
  END IF;
  IF NEW."checkoutExpiresAt" > hold_expiry THEN
    RAISE EXCEPTION 'Checkout cannot outlive its source hold';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CheckoutOrder_enforce_ancestry_trigger"
BEFORE INSERT ON "CheckoutOrder"
FOR EACH ROW EXECUTE FUNCTION "CheckoutOrder_enforce_ancestry"();

CREATE FUNCTION "CheckoutOrder_protect_identity"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Checkout orders are financial history and cannot be deleted';
  END IF;
  IF NEW."publicReference" IS DISTINCT FROM OLD."publicReference"
     OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."eventId" IS DISTINCT FROM OLD."eventId"
     OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
     OR NEW."sourceHoldId" IS DISTINCT FROM OLD."sourceHoldId"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."subtotalMinor" IS DISTINCT FROM OLD."subtotalMinor"
     OR NEW."totalMinor" IS DISTINCT FROM OLD."totalMinor"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
     OR NEW."checkoutExpiresAt" IS DISTINCT FROM OLD."checkoutExpiresAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Checkout order identity and financial snapshot are immutable';
  END IF;
  IF OLD."status" IN ('FULFILLED', 'FAILED', 'CANCELLED', 'EXPIRED', 'PAID_UNFULFILLED', 'REQUIRES_REVIEW')
     AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'Terminal checkout order status is immutable';
  END IF;
  IF OLD."paidAt" IS NOT NULL AND NEW."paidAt" IS DISTINCT FROM OLD."paidAt" THEN
    RAISE EXCEPTION 'Order paid timestamp is immutable once set';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CheckoutOrder_protect_identity_trigger"
BEFORE UPDATE OR DELETE ON "CheckoutOrder"
FOR EACH ROW EXECUTE FUNCTION "CheckoutOrder_protect_identity"();

CREATE FUNCTION "CheckoutOrderItem_enforce_snapshot"() RETURNS trigger AS $$
DECLARE
  order_session_id TEXT;
  order_hold_id TEXT;
  inventory_record RECORD;
  physical_record RECORD;
  tier_record RECORD;
  hold_item_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Checkout order items are immutable financial history';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Checkout order items are immutable';
  END IF;

  SELECT "sessionId", "sourceHoldId" INTO order_session_id, order_hold_id
  FROM "CheckoutOrder" WHERE "id" = NEW."orderId";
  SELECT "sessionId", "seatId", "sectionId", "priceTierId", "priceMinor", "currency"
    INTO inventory_record
  FROM "SessionSeatInventory" WHERE "id" = NEW."inventoryId";
  SELECT seat."label" AS seat_label, seat_row."label" AS row_label,
         section."name" AS section_name, section."code" AS section_code
    INTO physical_record
  FROM "Seat" seat
  JOIN "SeatRow" seat_row ON seat_row."id" = seat."rowId"
  JOIN "SeatSection" section ON section."id" = seat_row."sectionId"
  WHERE seat."id" = NEW."seatId";
  SELECT "name", "code" INTO tier_record
  FROM "SessionPriceTier" WHERE "id" = NEW."priceTierId";
  SELECT count(*) INTO hold_item_count FROM "SeatHoldItem"
  WHERE "holdId" = order_hold_id AND "inventoryId" = NEW."inventoryId";

  IF inventory_record."sessionId" IS DISTINCT FROM order_session_id
     OR inventory_record."seatId" IS DISTINCT FROM NEW."seatId"
     OR inventory_record."sectionId" IS DISTINCT FROM NEW."sectionId"
     OR inventory_record."priceTierId" IS DISTINCT FROM NEW."priceTierId"
     OR inventory_record."priceMinor" IS DISTINCT FROM NEW."priceMinor"
     OR inventory_record."currency" IS DISTINCT FROM NEW."currency"
     OR hold_item_count <> 1 THEN
    RAISE EXCEPTION 'Checkout item does not match source hold inventory';
  END IF;
  IF physical_record.seat_label IS DISTINCT FROM NEW."seatLabel"
     OR physical_record.row_label IS DISTINCT FROM NEW."rowLabel"
     OR physical_record.section_name IS DISTINCT FROM NEW."sectionName"
     OR physical_record.section_code IS DISTINCT FROM NEW."sectionCode"
     OR tier_record.name IS DISTINCT FROM NEW."tierName"
     OR tier_record.code IS DISTINCT FROM NEW."tierCode" THEN
    RAISE EXCEPTION 'Checkout item descriptive snapshots are invalid';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CheckoutOrderItem_enforce_snapshot_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "CheckoutOrderItem"
FOR EACH ROW EXECUTE FUNCTION "CheckoutOrderItem_enforce_snapshot"();

CREATE FUNCTION "CheckoutOrder_verify_totals"() RETURNS trigger AS $$
DECLARE
  target_order_id TEXT;
  item_count INTEGER;
  item_total BIGINT;
  currency_count INTEGER;
  expected_total INTEGER;
  expected_currency "Currency";
BEGIN
  IF TG_TABLE_NAME = 'CheckoutOrder' THEN
    target_order_id := COALESCE(NEW."id", OLD."id");
  ELSE
    target_order_id := COALESCE(NEW."orderId", OLD."orderId");
  END IF;
  SELECT count(*), COALESCE(sum("priceMinor"), 0), count(DISTINCT "currency")
    INTO item_count, item_total, currency_count
  FROM "CheckoutOrderItem" WHERE "orderId" = target_order_id;
  SELECT "totalMinor", "currency" INTO expected_total, expected_currency
  FROM "CheckoutOrder" WHERE "id" = target_order_id;
  IF expected_total IS NOT NULL AND (
    item_count < 1 OR item_total <> expected_total OR currency_count <> 1
    OR EXISTS (
      SELECT 1 FROM "CheckoutOrderItem"
      WHERE "orderId" = target_order_id AND "currency" <> expected_currency
    )
  ) THEN
    RAISE EXCEPTION 'Checkout order items must exactly equal the official total and currency';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "CheckoutOrder_verify_totals_order_trigger"
AFTER INSERT OR UPDATE ON "CheckoutOrder"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "CheckoutOrder_verify_totals"();

CREATE CONSTRAINT TRIGGER "CheckoutOrder_verify_totals_item_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "CheckoutOrderItem"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "CheckoutOrder_verify_totals"();

-- Payment attempt identity, amount, currency, and first terminal result are
-- immutable. A provider intent may only be attached once after the network call.
CREATE FUNCTION "PaymentAttempt_enforce_order"() RETURNS trigger AS $$
DECLARE
  order_total INTEGER;
  order_currency "Currency";
BEGIN
  SELECT "totalMinor", "currency" INTO order_total, order_currency
  FROM "CheckoutOrder" WHERE "id" = NEW."orderId";
  IF NEW."amountMinor" IS DISTINCT FROM order_total
     OR NEW."currency" IS DISTINCT FROM order_currency THEN
    RAISE EXCEPTION 'Payment attempt amount and currency must match its order';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PaymentAttempt_enforce_order_trigger"
BEFORE INSERT ON "PaymentAttempt"
FOR EACH ROW EXECUTE FUNCTION "PaymentAttempt_enforce_order"();

CREATE FUNCTION "PaymentAttempt_protect_identity"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payment attempts are financial history and cannot be deleted';
  END IF;
  IF NEW."orderId" IS DISTINCT FROM OLD."orderId"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."providerIdempotencyKey" IS DISTINCT FROM OLD."providerIdempotencyKey"
     OR NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Payment attempt identity and amount are immutable';
  END IF;
  IF OLD."providerIntentId" IS NOT NULL
     AND NEW."providerIntentId" IS DISTINCT FROM OLD."providerIntentId" THEN
    RAISE EXCEPTION 'Provider intent identity is immutable once attached';
  END IF;
  IF OLD."status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'REQUIRES_REVIEW')
     AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'First terminal payment result is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PaymentAttempt_protect_identity_trigger"
BEFORE UPDATE OR DELETE ON "PaymentAttempt"
FOR EACH ROW EXECUTE FUNCTION "PaymentAttempt_protect_identity"();

CREATE FUNCTION "PaymentWebhookEvent_protect_envelope"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Verified webhook records cannot be deleted';
  END IF;
  IF NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."providerEventId" IS DISTINCT FROM OLD."providerEventId"
     OR NEW."eventType" IS DISTINCT FROM OLD."eventType"
     OR NEW."providerIntentId" IS DISTINCT FROM OLD."providerIntentId"
     OR NEW."paymentAttemptId" IS DISTINCT FROM OLD."paymentAttemptId"
     OR NEW."normalizedStatus" IS DISTINCT FROM OLD."normalizedStatus"
     OR NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."signatureStatus" IS DISTINCT FROM OLD."signatureStatus"
     OR NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt"
     OR NEW."providerOccurredAt" IS DISTINCT FROM OLD."providerOccurredAt"
     OR NEW."payloadHash" IS DISTINCT FROM OLD."payloadHash" THEN
    RAISE EXCEPTION 'Verified webhook envelope is immutable';
  END IF;
  IF OLD."processingStatus" IN ('PROCESSED', 'REQUIRES_REVIEW')
     AND NEW."processingStatus" IS DISTINCT FROM OLD."processingStatus" THEN
    RAISE EXCEPTION 'Processed webhook outcome is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PaymentWebhookEvent_protect_envelope_trigger"
BEFORE UPDATE OR DELETE ON "PaymentWebhookEvent"
FOR EACH ROW EXECUTE FUNCTION "PaymentWebhookEvent_protect_envelope"();

-- Booking and booked-seat snapshots must exactly match the fulfilled order.
CREATE FUNCTION "Booking_enforce_order"() RETURNS trigger AS $$
DECLARE
  order_record RECORD;
BEGIN
  SELECT "userId", "organizationId", "eventId", "sessionId", "currency", "totalMinor"
    INTO order_record FROM "CheckoutOrder" WHERE "id" = NEW."orderId";
  IF NEW."userId" IS DISTINCT FROM order_record."userId"
     OR NEW."organizationId" IS DISTINCT FROM order_record."organizationId"
     OR NEW."eventId" IS DISTINCT FROM order_record."eventId"
     OR NEW."sessionId" IS DISTINCT FROM order_record."sessionId"
     OR NEW."currency" IS DISTINCT FROM order_record."currency"
     OR NEW."totalMinor" IS DISTINCT FROM order_record."totalMinor" THEN
    RAISE EXCEPTION 'Booking ancestry and total must match its checkout order';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Booking_enforce_order_trigger"
BEFORE INSERT ON "Booking"
FOR EACH ROW EXECUTE FUNCTION "Booking_enforce_order"();

CREATE FUNCTION "Booking_protect_snapshot"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Confirmed bookings cannot be deleted';
  END IF;
  RAISE EXCEPTION 'Confirmed booking identity and financial snapshots are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Booking_protect_snapshot_trigger"
BEFORE UPDATE OR DELETE ON "Booking"
FOR EACH ROW EXECUTE FUNCTION "Booking_protect_snapshot"();

CREATE FUNCTION "BookingSeat_enforce_order_item"() RETURNS trigger AS $$
DECLARE
  booking_order_id TEXT;
  booking_session_id TEXT;
  item_record RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Booked seats cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Booked-seat snapshots are immutable';
  END IF;
  SELECT "orderId", "sessionId" INTO booking_order_id, booking_session_id
  FROM "Booking" WHERE "id" = NEW."bookingId";
  SELECT "seatId", "sectionId", "priceTierId", "seatLabel", "rowLabel",
         "sectionName", "sectionCode", "tierName", "tierCode", "priceMinor", "currency"
    INTO item_record
  FROM "CheckoutOrderItem"
  WHERE "orderId" = booking_order_id AND "inventoryId" = NEW."inventoryId";

  IF booking_session_id IS DISTINCT FROM NEW."sessionId"
     OR item_record."seatId" IS DISTINCT FROM NEW."seatId"
     OR item_record."sectionId" IS DISTINCT FROM NEW."sectionId"
     OR item_record."priceTierId" IS DISTINCT FROM NEW."priceTierId"
     OR item_record."seatLabel" IS DISTINCT FROM NEW."seatLabel"
     OR item_record."rowLabel" IS DISTINCT FROM NEW."rowLabel"
     OR item_record."sectionName" IS DISTINCT FROM NEW."sectionName"
     OR item_record."sectionCode" IS DISTINCT FROM NEW."sectionCode"
     OR item_record."tierName" IS DISTINCT FROM NEW."tierName"
     OR item_record."tierCode" IS DISTINCT FROM NEW."tierCode"
     OR item_record."priceMinor" IS DISTINCT FROM NEW."priceMinor"
     OR item_record."currency" IS DISTINCT FROM NEW."currency" THEN
    RAISE EXCEPTION 'Booked-seat snapshot must exactly match its checkout item';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "BookingSeat_enforce_order_item_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "BookingSeat"
FOR EACH ROW EXECUTE FUNCTION "BookingSeat_enforce_order_item"();

CREATE FUNCTION "Booking_verify_fulfillment"() RETURNS trigger AS $$
DECLARE
  target_booking_id TEXT;
  order_record RECORD;
  booking_seat_count INTEGER;
  order_item_count INTEGER;
  booked_inventory_count INTEGER;
  hold_record RECORD;
BEGIN
  IF TG_TABLE_NAME = 'Booking' THEN
    target_booking_id := COALESCE(NEW."id", OLD."id");
  ELSE
    target_booking_id := COALESCE(NEW."bookingId", OLD."bookingId");
  END IF;
  SELECT booking."orderId", booking."sessionId", booking."userId", booking."currency", booking."totalMinor",
         checkout_order."status" AS order_status, checkout_order."sourceHoldId",
         checkout_order."fulfilledAt", checkout_order."paidAt"
    INTO order_record
  FROM "Booking" booking
  JOIN "CheckoutOrder" checkout_order ON checkout_order."id" = booking."orderId"
  WHERE booking."id" = target_booking_id;
  IF order_record."orderId" IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  SELECT count(*) INTO booking_seat_count FROM "BookingSeat" WHERE "bookingId" = target_booking_id;
  SELECT count(*) INTO order_item_count FROM "CheckoutOrderItem" WHERE "orderId" = order_record."orderId";
  SELECT count(*) INTO booked_inventory_count
  FROM "BookingSeat" booking_seat
  JOIN "SessionSeatInventory" inventory ON inventory."id" = booking_seat."inventoryId"
  WHERE booking_seat."bookingId" = target_booking_id
    AND inventory."state" = 'BOOKED'
    AND inventory."currentHoldId" IS NULL
    AND inventory."holdExpiresAt" IS NULL;
  SELECT "status", "userId", "sessionId", "convertedAt"
    INTO hold_record FROM "SeatHold" WHERE "id" = order_record."sourceHoldId";

  IF order_record.order_status IS DISTINCT FROM 'FULFILLED'
     OR order_record."paidAt" IS NULL OR order_record."fulfilledAt" IS NULL
     OR booking_seat_count < 1 OR booking_seat_count <> order_item_count
     OR booked_inventory_count <> booking_seat_count
     OR hold_record.status IS DISTINCT FROM 'CONVERTED'
     OR hold_record."convertedAt" IS NULL
     OR hold_record."userId" IS DISTINCT FROM order_record."userId"
     OR hold_record."sessionId" IS DISTINCT FROM order_record."sessionId" THEN
    RAISE EXCEPTION 'Booking fulfillment must atomically match order, hold, seats, and booked inventory';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "Booking_verify_fulfillment_booking_trigger"
AFTER INSERT ON "Booking"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "Booking_verify_fulfillment"();

CREATE CONSTRAINT TRIGGER "Booking_verify_fulfillment_seat_trigger"
AFTER INSERT ON "BookingSeat"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "Booking_verify_fulfillment"();

-- A converted hold may commit only when its unique order and booking are fully
-- fulfilled and no temporary inventory pointer remains.
CREATE FUNCTION "SeatHold_verify_conversion"() RETURNS trigger AS $$
DECLARE
  fulfilled_count INTEGER;
  lingering_inventory INTEGER;
BEGIN
  IF NEW."status" <> 'CONVERTED' THEN RETURN NEW; END IF;
  SELECT count(*) INTO fulfilled_count
  FROM "CheckoutOrder" checkout_order
  JOIN "Booking" booking ON booking."orderId" = checkout_order."id"
  WHERE checkout_order."sourceHoldId" = NEW."id"
    AND checkout_order."status" = 'FULFILLED'
    AND booking."userId" = NEW."userId"
    AND booking."sessionId" = NEW."sessionId";
  SELECT count(*) INTO lingering_inventory
  FROM "SessionSeatInventory" WHERE "currentHoldId" = NEW."id";
  IF fulfilled_count <> 1 OR lingering_inventory <> 0 THEN
    RAISE EXCEPTION 'Converted hold must have one fulfilled booking and no temporary inventory';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "SeatHold_verify_conversion_trigger"
AFTER UPDATE OF "status" ON "SeatHold"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "SeatHold_verify_conversion"();
