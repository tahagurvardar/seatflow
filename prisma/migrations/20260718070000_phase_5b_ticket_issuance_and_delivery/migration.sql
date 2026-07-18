-- =============================================================================
-- Phase 5B: secure ticket issuance, hashed QR credentials, authoritative entry
-- validation, expiring downloads, and provider-neutral notification delivery.
-- PostgreSQL remains the sole authority. No plaintext ticket or grant credential
-- is persisted by this migration or by the application models it creates.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE "TicketStatus" AS ENUM ('ACTIVE', 'REVOKED', 'USED');
CREATE TYPE "TicketCredentialStatus" AS ENUM ('ACTIVE', 'REVOKED', 'REPLACED', 'USED');
CREATE TYPE "TicketRedemptionOutcome" AS ENUM (
  'ACCEPTED', 'ALREADY_USED', 'REVOKED', 'INVALID', 'WRONG_SESSION',
  'TOO_EARLY', 'TOO_LATE', 'SESSION_CANCELLED', 'UNAUTHORIZED_SCANNER'
);
CREATE TYPE "TicketDownloadGrantPurpose" AS ENUM ('BOOKING_PDF');
CREATE TYPE "TicketIssuanceRequestStatus" AS ENUM ('PENDING', 'COMPLETED', 'DEAD_LETTER');
CREATE TYPE "TicketAuditAction" AS ENUM ('ISSUED', 'CREDENTIAL_ROTATED', 'REVOKED');
CREATE TYPE "NotificationType" AS ENUM (
  'BOOKING_TICKETS_READY', 'CREDENTIAL_ROTATED', 'TICKET_REVOKED'
);
CREATE TYPE "NotificationOutboxStatus" AS ENUM ('PENDING', 'PROCESSED', 'DEAD_LETTER');
CREATE TYPE "NotificationProviderName" AS ENUM ('LOCAL_FILE', 'EXTERNAL');
CREATE TYPE "NotificationDeliveryStatus" AS ENUM (
  'SUCCEEDED', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE', 'TIMEOUT'
);

CREATE TABLE "Ticket" (
  "id" TEXT NOT NULL,
  "publicReference" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "bookingSeatId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "status" "TicketStatus" NOT NULL DEFAULT 'ACTIVE',
  "issuedAt" TIMESTAMPTZ(3) NOT NULL,
  "revokedAt" TIMESTAMPTZ(3),
  "revocationReason" TEXT,
  "revokedByUserId" TEXT,
  "lastCredentialRotationAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Ticket_public_reference_check" CHECK (
    char_length("publicReference") BETWEEN 24 AND 80
    AND "publicReference" ~ '^[A-Za-z0-9_-]+$'
  ),
  CONSTRAINT "Ticket_revocation_reason_check" CHECK (
    "revocationReason" IS NULL
    OR (char_length("revocationReason") BETWEEN 1 AND 160
      AND "revocationReason" !~ '[\r\n\t]')
  ),
  CONSTRAINT "Ticket_lifecycle_check" CHECK (
    ("status" = 'ACTIVE' AND "revokedAt" IS NULL AND "revocationReason" IS NULL AND "revokedByUserId" IS NULL)
    OR ("status" = 'REVOKED' AND "revokedAt" IS NOT NULL AND "revocationReason" IS NOT NULL)
    OR ("status" = 'USED' AND "revokedAt" IS NULL AND "revocationReason" IS NULL AND "revokedByUserId" IS NULL)
  )
);

CREATE TABLE "TicketCredential" (
  "id" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "credentialHash" CHAR(64) NOT NULL,
  "hashAlgorithm" TEXT NOT NULL DEFAULT 'HMAC-SHA256-V1',
  "status" "TicketCredentialStatus" NOT NULL DEFAULT 'ACTIVE',
  "issuedAt" TIMESTAMPTZ(3) NOT NULL,
  "revokedAt" TIMESTAMPTZ(3),
  "replacedAt" TIMESTAMPTZ(3),
  "usedAt" TIMESTAMPTZ(3),
  "replacementCredentialId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TicketCredential_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TicketCredential_version_check" CHECK ("version" >= 1),
  CONSTRAINT "TicketCredential_hash_check" CHECK ("credentialHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "TicketCredential_algorithm_check" CHECK ("hashAlgorithm" = 'HMAC-SHA256-V1'),
  CONSTRAINT "TicketCredential_lifecycle_check" CHECK (
    ("status" = 'ACTIVE' AND "revokedAt" IS NULL AND "replacedAt" IS NULL AND "usedAt" IS NULL AND "replacementCredentialId" IS NULL)
    OR ("status" = 'REVOKED' AND "revokedAt" IS NOT NULL AND "replacedAt" IS NULL AND "usedAt" IS NULL AND "replacementCredentialId" IS NULL)
    OR ("status" = 'REPLACED' AND "revokedAt" IS NULL AND "replacedAt" IS NOT NULL AND "usedAt" IS NULL)
    OR ("status" = 'USED' AND "revokedAt" IS NULL AND "replacedAt" IS NULL AND "usedAt" IS NOT NULL AND "replacementCredentialId" IS NULL)
  )
);

CREATE TABLE "TicketRedemptionEvent" (
  "id" TEXT NOT NULL,
  "ticketId" TEXT,
  "ticketCredentialId" TEXT,
  "organizationId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "scannerUserId" TEXT NOT NULL,
  "outcome" "TicketRedemptionOutcome" NOT NULL,
  "scannedAt" TIMESTAMPTZ(3) NOT NULL,
  "scannerIdentifier" TEXT,
  "rejectionReason" TEXT,
  "idempotencyKey" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TicketRedemptionEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TicketRedemptionEvent_identity_check" CHECK (
    ("outcome" IN ('INVALID', 'UNAUTHORIZED_SCANNER') AND "ticketId" IS NULL AND "ticketCredentialId" IS NULL)
    OR ("outcome" NOT IN ('INVALID', 'UNAUTHORIZED_SCANNER') AND "ticketId" IS NOT NULL AND "ticketCredentialId" IS NOT NULL)
  ),
  CONSTRAINT "TicketRedemptionEvent_safe_text_check" CHECK (
    ("scannerIdentifier" IS NULL OR (char_length("scannerIdentifier") BETWEEN 1 AND 80 AND "scannerIdentifier" ~ '^[A-Za-z0-9._:-]+$'))
    AND ("rejectionReason" IS NULL OR (char_length("rejectionReason") BETWEEN 1 AND 80 AND "rejectionReason" ~ '^[A-Z0-9_:-]+$'))
    AND ("idempotencyKey" IS NULL OR (char_length("idempotencyKey") BETWEEN 16 AND 191 AND "idempotencyKey" ~ '^[A-Za-z0-9_-]+$'))
  )
);

CREATE TABLE "TicketDownloadGrant" (
  "id" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" CHAR(64) NOT NULL,
  "purpose" "TicketDownloadGrantPurpose" NOT NULL DEFAULT 'BOOKING_PDF',
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "usedAt" TIMESTAMPTZ(3),
  "revokedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TicketDownloadGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TicketDownloadGrant_hash_check" CHECK ("tokenHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "TicketDownloadGrant_expiry_check" CHECK ("expiresAt" > "createdAt"),
  CONSTRAINT "TicketDownloadGrant_lifecycle_check" CHECK (NOT ("usedAt" IS NOT NULL AND "revokedAt" IS NOT NULL))
);

CREATE TABLE "TicketIssuanceRequest" (
  "id" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "status" "TicketIssuanceRequestStatus" NOT NULL DEFAULT 'PENDING',
  "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "processedAt" TIMESTAMPTZ(3),
  "lastError" TEXT,
  "deadLetterAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "TicketIssuanceRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TicketIssuanceRequest_attempt_check" CHECK ("attemptCount" >= 0),
  CONSTRAINT "TicketIssuanceRequest_error_check" CHECK ("lastError" IS NULL OR char_length("lastError") <= 240),
  CONSTRAINT "TicketIssuanceRequest_lifecycle_check" CHECK (
    ("status" = 'PENDING' AND "processedAt" IS NULL AND "deadLetterAt" IS NULL)
    OR ("status" = 'COMPLETED' AND "processedAt" IS NOT NULL AND "deadLetterAt" IS NULL AND "lastError" IS NULL)
    OR ("status" = 'DEAD_LETTER' AND "processedAt" IS NULL AND "deadLetterAt" IS NOT NULL AND "lastError" IS NOT NULL)
  )
);

CREATE TABLE "TicketAuditEvent" (
  "id" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "actorUserId" TEXT,
  "action" "TicketAuditAction" NOT NULL,
  "safeReason" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TicketAuditEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TicketAuditEvent_reason_check" CHECK (
    "safeReason" IS NULL OR (char_length("safeReason") BETWEEN 1 AND 160 AND "safeReason" !~ '[\r\n\t]')
  )
);

CREATE TABLE "NotificationOutbox" (
  "id" TEXT NOT NULL,
  "notificationType" "NotificationType" NOT NULL,
  "recipientUserId" TEXT NOT NULL,
  "bookingId" TEXT,
  "ticketId" TEXT,
  "templateVersion" INTEGER NOT NULL DEFAULT 1,
  "locale" TEXT NOT NULL DEFAULT 'en',
  "payload" JSONB NOT NULL,
  "deduplicationKey" TEXT NOT NULL,
  "status" "NotificationOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "processedAt" TIMESTAMPTZ(3),
  "lastError" TEXT,
  "deadLetterAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "NotificationOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationOutbox_template_check" CHECK ("templateVersion" >= 1),
  CONSTRAINT "NotificationOutbox_locale_check" CHECK ("locale" ~ '^[a-z]{2}(?:-[A-Z]{2})?$'),
  CONSTRAINT "NotificationOutbox_attempt_check" CHECK ("attemptCount" >= 0),
  CONSTRAINT "NotificationOutbox_error_check" CHECK ("lastError" IS NULL OR char_length("lastError") <= 240),
  CONSTRAINT "NotificationOutbox_payload_check" CHECK (
    jsonb_typeof("payload") = 'object' AND octet_length("payload"::text) <= 8192
  ),
  CONSTRAINT "NotificationOutbox_resource_check" CHECK (
    ("notificationType" = 'BOOKING_TICKETS_READY' AND "bookingId" IS NOT NULL AND "ticketId" IS NULL)
    OR ("notificationType" IN ('CREDENTIAL_ROTATED', 'TICKET_REVOKED') AND "ticketId" IS NOT NULL)
  ),
  CONSTRAINT "NotificationOutbox_lifecycle_check" CHECK (
    ("status" = 'PENDING' AND "processedAt" IS NULL AND "deadLetterAt" IS NULL)
    OR ("status" = 'PROCESSED' AND "processedAt" IS NOT NULL AND "deadLetterAt" IS NULL AND "lastError" IS NULL)
    OR ("status" = 'DEAD_LETTER' AND "processedAt" IS NULL AND "deadLetterAt" IS NOT NULL AND "lastError" IS NOT NULL)
  )
);

CREATE TABLE "NotificationDeliveryAttempt" (
  "id" TEXT NOT NULL,
  "notificationOutboxId" TEXT NOT NULL,
  "provider" "NotificationProviderName" NOT NULL,
  "providerMessageId" TEXT,
  "status" "NotificationDeliveryStatus" NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "completedAt" TIMESTAMPTZ(3),
  "safeErrorCode" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationDeliveryAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationDeliveryAttempt_number_check" CHECK ("attemptNumber" >= 1),
  CONSTRAINT "NotificationDeliveryAttempt_time_check" CHECK ("completedAt" IS NOT NULL AND "completedAt" >= "startedAt"),
  CONSTRAINT "NotificationDeliveryAttempt_provider_id_check" CHECK (
    "providerMessageId" IS NULL OR (char_length("providerMessageId") BETWEEN 1 AND 191 AND "providerMessageId" !~ '[\r\n\t]')
  ),
  CONSTRAINT "NotificationDeliveryAttempt_error_check" CHECK (
    "safeErrorCode" IS NULL OR (char_length("safeErrorCode") BETWEEN 1 AND 80 AND "safeErrorCode" ~ '^[A-Z0-9_:-]+$')
  ),
  CONSTRAINT "NotificationDeliveryAttempt_outcome_check" CHECK (
    ("status" = 'SUCCEEDED' AND "providerMessageId" IS NOT NULL AND "safeErrorCode" IS NULL)
    OR ("status" <> 'SUCCEEDED' AND "safeErrorCode" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "Ticket_publicReference_key" ON "Ticket"("publicReference");
CREATE UNIQUE INDEX "Ticket_bookingSeatId_key" ON "Ticket"("bookingSeatId");
CREATE INDEX "Ticket_bookingId_idx" ON "Ticket"("bookingId");
CREATE INDEX "Ticket_userId_issuedAt_idx" ON "Ticket"("userId", "issuedAt");
CREATE INDEX "Ticket_organizationId_status_idx" ON "Ticket"("organizationId", "status");
CREATE INDEX "Ticket_eventId_status_idx" ON "Ticket"("eventId", "status");
CREATE INDEX "Ticket_sessionId_status_idx" ON "Ticket"("sessionId", "status");

CREATE UNIQUE INDEX "TicketCredential_credentialHash_key" ON "TicketCredential"("credentialHash");
CREATE UNIQUE INDEX "TicketCredential_replacementCredentialId_key" ON "TicketCredential"("replacementCredentialId");
CREATE UNIQUE INDEX "TicketCredential_ticketId_version_key" ON "TicketCredential"("ticketId", "version");
CREATE UNIQUE INDEX "TicketCredential_one_active_per_ticket_key" ON "TicketCredential"("ticketId") WHERE "status" = 'ACTIVE';
CREATE INDEX "TicketCredential_ticketId_status_idx" ON "TicketCredential"("ticketId", "status");

CREATE UNIQUE INDEX "TicketRedemptionEvent_scannerUserId_idempotencyKey_key"
  ON "TicketRedemptionEvent"("scannerUserId", "idempotencyKey");
CREATE UNIQUE INDEX "TicketRedemptionEvent_first_success_per_ticket_key"
  ON "TicketRedemptionEvent"("ticketId") WHERE "outcome" = 'ACCEPTED';
CREATE INDEX "TicketRedemptionEvent_ticketId_scannedAt_idx" ON "TicketRedemptionEvent"("ticketId", "scannedAt");
CREATE INDEX "TicketRedemptionEvent_sessionId_scannedAt_idx" ON "TicketRedemptionEvent"("sessionId", "scannedAt");
CREATE INDEX "TicketRedemptionEvent_organizationId_outcome_scannedAt_idx"
  ON "TicketRedemptionEvent"("organizationId", "outcome", "scannedAt");

CREATE UNIQUE INDEX "TicketDownloadGrant_tokenHash_key" ON "TicketDownloadGrant"("tokenHash");
CREATE INDEX "TicketDownloadGrant_userId_expiresAt_idx" ON "TicketDownloadGrant"("userId", "expiresAt");
CREATE INDEX "TicketDownloadGrant_bookingId_createdAt_idx" ON "TicketDownloadGrant"("bookingId", "createdAt");

CREATE UNIQUE INDEX "TicketIssuanceRequest_bookingId_key" ON "TicketIssuanceRequest"("bookingId");
CREATE INDEX "TicketIssuanceRequest_status_availableAt_createdAt_idx"
  ON "TicketIssuanceRequest"("status", "availableAt", "createdAt");

CREATE INDEX "TicketAuditEvent_ticketId_createdAt_idx" ON "TicketAuditEvent"("ticketId", "createdAt");
CREATE INDEX "TicketAuditEvent_actorUserId_createdAt_idx" ON "TicketAuditEvent"("actorUserId", "createdAt");

CREATE UNIQUE INDEX "NotificationOutbox_deduplicationKey_key" ON "NotificationOutbox"("deduplicationKey");
CREATE INDEX "NotificationOutbox_status_availableAt_createdAt_idx" ON "NotificationOutbox"("status", "availableAt", "createdAt");
CREATE INDEX "NotificationOutbox_recipientUserId_createdAt_idx" ON "NotificationOutbox"("recipientUserId", "createdAt");
CREATE INDEX "NotificationOutbox_bookingId_idx" ON "NotificationOutbox"("bookingId");
CREATE INDEX "NotificationOutbox_ticketId_idx" ON "NotificationOutbox"("ticketId");

CREATE UNIQUE INDEX "NotificationDeliveryAttempt_notificationOutboxId_attemptNumber_key"
  ON "NotificationDeliveryAttempt"("notificationOutboxId", "attemptNumber");
CREATE INDEX "NotificationDeliveryAttempt_provider_status_startedAt_idx"
  ON "NotificationDeliveryAttempt"("provider", "status", "startedAt");

ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_bookingSeatId_fkey" FOREIGN KEY ("bookingSeatId") REFERENCES "BookingSeat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "EventSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TicketCredential" ADD CONSTRAINT "TicketCredential_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TicketCredential" ADD CONSTRAINT "TicketCredential_replacementCredentialId_fkey" FOREIGN KEY ("replacementCredentialId") REFERENCES "TicketCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TicketRedemptionEvent" ADD CONSTRAINT "TicketRedemptionEvent_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TicketRedemptionEvent" ADD CONSTRAINT "TicketRedemptionEvent_ticketCredentialId_fkey" FOREIGN KEY ("ticketCredentialId") REFERENCES "TicketCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TicketRedemptionEvent" ADD CONSTRAINT "TicketRedemptionEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TicketRedemptionEvent" ADD CONSTRAINT "TicketRedemptionEvent_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TicketRedemptionEvent" ADD CONSTRAINT "TicketRedemptionEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "EventSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TicketRedemptionEvent" ADD CONSTRAINT "TicketRedemptionEvent_scannerUserId_fkey" FOREIGN KEY ("scannerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TicketDownloadGrant" ADD CONSTRAINT "TicketDownloadGrant_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TicketDownloadGrant" ADD CONSTRAINT "TicketDownloadGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TicketIssuanceRequest" ADD CONSTRAINT "TicketIssuanceRequest_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TicketAuditEvent" ADD CONSTRAINT "TicketAuditEvent_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TicketAuditEvent" ADD CONSTRAINT "TicketAuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "NotificationOutbox_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "NotificationOutbox_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "NotificationOutbox_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NotificationDeliveryAttempt" ADD CONSTRAINT "NotificationDeliveryAttempt_notificationOutboxId_fkey" FOREIGN KEY ("notificationOutboxId") REFERENCES "NotificationOutbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Ticket ancestry and immutable identity are independently enforced at the
-- database boundary. Only confirmed booking seats can produce tickets.
CREATE FUNCTION "Ticket_enforce_ancestry"() RETURNS trigger AS $$
DECLARE
  booking_record RECORD;
  seat_booking_id TEXT;
BEGIN
  SELECT "userId", "organizationId", "eventId", "sessionId", "status"
    INTO booking_record FROM "Booking" WHERE "id" = NEW."bookingId";
  SELECT "bookingId" INTO seat_booking_id FROM "BookingSeat" WHERE "id" = NEW."bookingSeatId";
  IF booking_record.status IS DISTINCT FROM 'CONFIRMED'
     OR seat_booking_id IS DISTINCT FROM NEW."bookingId"
     OR booking_record."userId" IS DISTINCT FROM NEW."userId"
     OR booking_record."organizationId" IS DISTINCT FROM NEW."organizationId"
     OR booking_record."eventId" IS DISTINCT FROM NEW."eventId"
     OR booking_record."sessionId" IS DISTINCT FROM NEW."sessionId" THEN
    RAISE EXCEPTION 'Ticket ancestry must match one confirmed booked seat';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Ticket_enforce_ancestry_trigger"
BEFORE INSERT ON "Ticket" FOR EACH ROW EXECUTE FUNCTION "Ticket_enforce_ancestry"();

CREATE FUNCTION "Ticket_protect_history"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Tickets are historical and cannot be deleted'; END IF;
  IF NEW."publicReference" IS DISTINCT FROM OLD."publicReference"
     OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId"
     OR NEW."bookingSeatId" IS DISTINCT FROM OLD."bookingSeatId"
     OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."eventId" IS DISTINCT FROM OLD."eventId"
     OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
     OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Ticket identity and ancestry are immutable';
  END IF;
  IF OLD."status" IN ('REVOKED', 'USED') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'A terminal ticket cannot be reactivated or changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Ticket_protect_history_trigger"
BEFORE UPDATE OR DELETE ON "Ticket" FOR EACH ROW EXECUTE FUNCTION "Ticket_protect_history"();

CREATE FUNCTION "TicketCredential_protect_history"() RETURNS trigger AS $$
DECLARE replacement_record RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Ticket credentials are historical and cannot be deleted'; END IF;
  IF NEW."ticketId" IS DISTINCT FROM OLD."ticketId"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."credentialHash" IS DISTINCT FROM OLD."credentialHash"
     OR NEW."hashAlgorithm" IS DISTINCT FROM OLD."hashAlgorithm"
     OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Ticket credential identity is immutable';
  END IF;
  IF OLD."status" IN ('REVOKED', 'REPLACED', 'USED') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'A terminal credential cannot be revived or changed';
  END IF;
  IF NEW."replacementCredentialId" IS NOT NULL THEN
    SELECT "ticketId", "version" INTO replacement_record
    FROM "TicketCredential" WHERE "id" = NEW."replacementCredentialId";
    IF replacement_record."ticketId" IS DISTINCT FROM NEW."ticketId"
       OR replacement_record."version" <= NEW."version" THEN
      RAISE EXCEPTION 'Credential replacement must be a newer credential for the same ticket';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TicketCredential_protect_history_trigger"
BEFORE UPDATE OR DELETE ON "TicketCredential" FOR EACH ROW EXECUTE FUNCTION "TicketCredential_protect_history"();

CREATE FUNCTION "TicketCredential_verify_replacement"() RETURNS trigger AS $$
DECLARE current_record RECORD;
BEGIN
  -- Constraint triggers retain the transition's NEW record. Re-read the row so
  -- a multi-statement rotation can create the successor and then connect it
  -- before this deferred invariant is evaluated at commit.
  SELECT "status", "replacementCredentialId" INTO current_record
  FROM "TicketCredential" WHERE "id" = NEW."id";
  IF current_record."status" = 'REPLACED' AND current_record."replacementCredentialId" IS NULL THEN
    RAISE EXCEPTION 'A replaced credential must identify its replacement';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "TicketCredential_verify_replacement_trigger"
AFTER INSERT OR UPDATE ON "TicketCredential" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "TicketCredential_verify_replacement"();

CREATE FUNCTION "TicketRedemptionEvent_protect_history"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Ticket redemption events are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "TicketRedemptionEvent_protect_history_trigger"
BEFORE UPDATE OR DELETE ON "TicketRedemptionEvent" FOR EACH ROW EXECUTE FUNCTION "TicketRedemptionEvent_protect_history"();

CREATE FUNCTION "TicketDownloadGrant_protect_history"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Download grants are historical and cannot be deleted'; END IF;
  IF NEW."bookingId" IS DISTINCT FROM OLD."bookingId"
     OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
     OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Download grant identity is immutable';
  END IF;
  IF (OLD."usedAt" IS NOT NULL OR OLD."revokedAt" IS NOT NULL)
     AND (NEW."usedAt" IS DISTINCT FROM OLD."usedAt" OR NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt") THEN
    RAISE EXCEPTION 'A terminal download grant cannot be replayed or changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "TicketDownloadGrant_protect_history_trigger"
BEFORE UPDATE OR DELETE ON "TicketDownloadGrant" FOR EACH ROW EXECUTE FUNCTION "TicketDownloadGrant_protect_history"();

CREATE FUNCTION "TicketAuditEvent_protect_history"() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Ticket audit events are append-only'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "TicketAuditEvent_protect_history_trigger"
BEFORE UPDATE OR DELETE ON "TicketAuditEvent" FOR EACH ROW EXECUTE FUNCTION "TicketAuditEvent_protect_history"();

CREATE FUNCTION "NotificationOutbox_enforce_ancestry"() RETURNS trigger AS $$
DECLARE resource_user_id TEXT;
BEGIN
  IF NEW."bookingId" IS NOT NULL THEN
    SELECT "userId" INTO resource_user_id FROM "Booking" WHERE "id" = NEW."bookingId";
  ELSE
    SELECT "userId" INTO resource_user_id FROM "Ticket" WHERE "id" = NEW."ticketId";
  END IF;
  IF resource_user_id IS DISTINCT FROM NEW."recipientUserId" THEN
    RAISE EXCEPTION 'Notification recipient must own the referenced resource';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "NotificationOutbox_enforce_ancestry_trigger"
BEFORE INSERT ON "NotificationOutbox" FOR EACH ROW EXECUTE FUNCTION "NotificationOutbox_enforce_ancestry"();

CREATE FUNCTION "NotificationOutbox_protect_identity"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Notification outbox history cannot be deleted'; END IF;
  IF NEW."notificationType" IS DISTINCT FROM OLD."notificationType"
     OR NEW."recipientUserId" IS DISTINCT FROM OLD."recipientUserId"
     OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId"
     OR NEW."ticketId" IS DISTINCT FROM OLD."ticketId"
     OR NEW."templateVersion" IS DISTINCT FROM OLD."templateVersion"
     OR NEW."locale" IS DISTINCT FROM OLD."locale"
     OR NEW."payload" IS DISTINCT FROM OLD."payload"
     OR NEW."deduplicationKey" IS DISTINCT FROM OLD."deduplicationKey"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Notification outbox identity and payload are immutable';
  END IF;
  IF OLD."status" IN ('PROCESSED', 'DEAD_LETTER') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'Terminal notification state is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "NotificationOutbox_protect_identity_trigger"
BEFORE UPDATE OR DELETE ON "NotificationOutbox" FOR EACH ROW EXECUTE FUNCTION "NotificationOutbox_protect_identity"();

CREATE FUNCTION "NotificationDeliveryAttempt_protect_history"() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Notification delivery attempts are append-only'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "NotificationDeliveryAttempt_protect_history_trigger"
BEFORE UPDATE OR DELETE ON "NotificationDeliveryAttempt" FOR EACH ROW EXECUTE FUNCTION "NotificationDeliveryAttempt_protect_history"();

-- Non-destructive, idempotent backfill: existing confirmed booked seats receive
-- a ticket immediately and a pending issuance request. The worker derives and
-- stores only a credential hash after deployment; no secret is needed in SQL.
INSERT INTO "Ticket" (
  "id", "publicReference", "bookingId", "bookingSeatId", "userId",
  "organizationId", "eventId", "sessionId", "status", "issuedAt", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  translate(rtrim(encode(gen_random_bytes(24), 'base64'), '='), '+/', '-_'),
  booking."id", booking_seat."id", booking."userId", booking."organizationId",
  booking."eventId", booking."sessionId", 'ACTIVE', booking."confirmedAt",
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "BookingSeat" booking_seat
JOIN "Booking" booking ON booking."id" = booking_seat."bookingId"
WHERE booking."status" = 'CONFIRMED'
ON CONFLICT ("bookingSeatId") DO NOTHING;

INSERT INTO "TicketIssuanceRequest" (
  "id", "bookingId", "status", "availableAt", "attemptCount", "createdAt", "updatedAt"
)
SELECT gen_random_uuid()::text, booking."id", 'PENDING', CURRENT_TIMESTAMP, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Booking" booking
WHERE booking."status" = 'CONFIRMED'
ON CONFLICT ("bookingId") DO NOTHING;
