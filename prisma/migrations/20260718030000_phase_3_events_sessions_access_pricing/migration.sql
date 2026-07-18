-- CreateEnum
CREATE TYPE "VenueAccessGrantStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CANCELLED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "EventCategory" AS ENUM ('CONCERT', 'CINEMA', 'THEATRE', 'SPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "EventSessionStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'ON_SALE', 'SALES_PAUSED', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('AZN', 'EUR', 'GBP', 'USD');

-- CreateTable
CREATE TABLE "VenueAccessGrant" (
    "id" TEXT NOT NULL,
    "organizerOrganizationId" TEXT NOT NULL,
    "operatorOrganizationId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "status" "VenueAccessGrantStatus" NOT NULL DEFAULT 'ACTIVE',
    "grantedByUserId" TEXT,
    "revokedByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "VenueAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "organizerOrganizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "publicSlug" TEXT NOT NULL,
    "shortDescription" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "EventCategory" NOT NULL,
    "imagePath" TEXT,
    "status" "EventStatus" NOT NULL DEFAULT 'DRAFT',
    "preArchiveStatus" "EventStatus",
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "publishedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventSession" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "seatMapId" TEXT NOT NULL,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "endAt" TIMESTAMPTZ(3) NOT NULL,
    "salesStartAt" TIMESTAMPTZ(3) NOT NULL,
    "salesEndAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "EventSessionStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "publishedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),

    CONSTRAINT "EventSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionPriceTier" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "currency" "Currency" NOT NULL,
    "displayOrder" INTEGER NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SessionPriceTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionSectionPricing" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "priceTierId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionSectionPricing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VenueAccessGrant_organizerOrganizationId_status_idx" ON "VenueAccessGrant"("organizerOrganizationId", "status");

-- CreateIndex
CREATE INDEX "VenueAccessGrant_operatorOrganizationId_status_idx" ON "VenueAccessGrant"("operatorOrganizationId", "status");

-- CreateIndex
CREATE INDEX "VenueAccessGrant_venueId_status_idx" ON "VenueAccessGrant"("venueId", "status");

-- CreateIndex
CREATE INDEX "VenueAccessGrant_grantedByUserId_idx" ON "VenueAccessGrant"("grantedByUserId");

-- CreateIndex
CREATE INDEX "VenueAccessGrant_revokedByUserId_idx" ON "VenueAccessGrant"("revokedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Event_publicSlug_key" ON "Event"("publicSlug");

-- CreateIndex
CREATE INDEX "Event_organizerOrganizationId_status_idx" ON "Event"("organizerOrganizationId", "status");

-- CreateIndex
CREATE INDEX "Event_organizerOrganizationId_createdAt_idx" ON "Event"("organizerOrganizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Event_status_publishedAt_idx" ON "Event"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "Event_category_status_idx" ON "Event"("category", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Event_organizerOrganizationId_slug_key" ON "Event"("organizerOrganizationId", "slug");

-- CreateIndex
CREATE INDEX "EventSession_eventId_status_idx" ON "EventSession"("eventId", "status");

-- CreateIndex
CREATE INDEX "EventSession_eventId_startAt_idx" ON "EventSession"("eventId", "startAt");

-- CreateIndex
CREATE INDEX "EventSession_venueId_startAt_idx" ON "EventSession"("venueId", "startAt");

-- CreateIndex
CREATE INDEX "EventSession_spaceId_startAt_endAt_idx" ON "EventSession"("spaceId", "startAt", "endAt");

-- CreateIndex
CREATE INDEX "EventSession_seatMapId_idx" ON "EventSession"("seatMapId");

-- CreateIndex
CREATE INDEX "EventSession_status_startAt_idx" ON "EventSession"("status", "startAt");

-- CreateIndex
CREATE INDEX "SessionPriceTier_sessionId_displayOrder_idx" ON "SessionPriceTier"("sessionId", "displayOrder");

-- CreateIndex
CREATE INDEX "SessionPriceTier_sessionId_currency_idx" ON "SessionPriceTier"("sessionId", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "SessionPriceTier_sessionId_code_key" ON "SessionPriceTier"("sessionId", "code");

-- CreateIndex
CREATE INDEX "SessionSectionPricing_sessionId_idx" ON "SessionSectionPricing"("sessionId");

-- CreateIndex
CREATE INDEX "SessionSectionPricing_sectionId_idx" ON "SessionSectionPricing"("sectionId");

-- CreateIndex
CREATE INDEX "SessionSectionPricing_priceTierId_idx" ON "SessionSectionPricing"("priceTierId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionSectionPricing_sessionId_sectionId_key" ON "SessionSectionPricing"("sessionId", "sectionId");

-- AddForeignKey
ALTER TABLE "VenueAccessGrant" ADD CONSTRAINT "VenueAccessGrant_organizerOrganizationId_fkey" FOREIGN KEY ("organizerOrganizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueAccessGrant" ADD CONSTRAINT "VenueAccessGrant_operatorOrganizationId_fkey" FOREIGN KEY ("operatorOrganizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueAccessGrant" ADD CONSTRAINT "VenueAccessGrant_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueAccessGrant" ADD CONSTRAINT "VenueAccessGrant_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueAccessGrant" ADD CONSTRAINT "VenueAccessGrant_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_organizerOrganizationId_fkey" FOREIGN KEY ("organizerOrganizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSession" ADD CONSTRAINT "EventSession_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSession" ADD CONSTRAINT "EventSession_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSession" ADD CONSTRAINT "EventSession_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSession" ADD CONSTRAINT "EventSession_seatMapId_fkey" FOREIGN KEY ("seatMapId") REFERENCES "SeatMap"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionPriceTier" ADD CONSTRAINT "SessionPriceTier_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "EventSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionSectionPricing" ADD CONSTRAINT "SessionSectionPricing_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "EventSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionSectionPricing" ADD CONSTRAINT "SessionSectionPricing_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "SeatSection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionSectionPricing" ADD CONSTRAINT "SessionSectionPricing_priceTierId_fkey" FOREIGN KEY ("priceTierId") REFERENCES "SessionPriceTier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Active access is unique while revoked grants remain as an append-only audit trail.
CREATE UNIQUE INDEX "VenueAccessGrant_one_active_per_organizer_venue_key"
ON "VenueAccessGrant"("organizerOrganizationId", "venueId")
WHERE "status" = 'ACTIVE';

-- Application validation produces friendly messages; checks keep invalid direct
-- writes out of PostgreSQL as a second line of defense.
ALTER TABLE "VenueAccessGrant"
  ADD CONSTRAINT "VenueAccessGrant_state_check" CHECK (
    ("status" = 'ACTIVE' AND "revokedAt" IS NULL AND "revokedByUserId" IS NULL)
    OR ("status" = 'REVOKED' AND "revokedAt" IS NOT NULL)
  );

ALTER TABLE "Event"
  ADD CONSTRAINT "Event_title_check" CHECK (char_length("title") BETWEEN 3 AND 160),
  ADD CONSTRAINT "Event_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  ADD CONSTRAINT "Event_publicSlug_check" CHECK ("publicSlug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)$'),
  ADD CONSTRAINT "Event_shortDescription_check" CHECK (char_length("shortDescription") BETWEEN 10 AND 280),
  ADD CONSTRAINT "Event_description_check" CHECK (char_length("description") BETWEEN 30 AND 10000),
  ADD CONSTRAINT "Event_imagePath_check" CHECK (
    "imagePath" IS NULL
    OR "imagePath" ~ '^/events/[A-Za-z0-9][A-Za-z0-9_-]*\.(svg|png|webp|jpg|jpeg)$'
  ),
  ADD CONSTRAINT "Event_lifecycle_check" CHECK (
    ("status" = 'DRAFT' AND "publishedAt" IS NULL AND "cancelledAt" IS NULL AND "archivedAt" IS NULL AND "preArchiveStatus" IS NULL)
    OR ("status" = 'PUBLISHED' AND "publishedAt" IS NOT NULL AND "cancelledAt" IS NULL AND "archivedAt" IS NULL AND "preArchiveStatus" IS NULL)
    OR ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "archivedAt" IS NULL AND "preArchiveStatus" IS NULL)
    OR (
      "status" = 'ARCHIVED'
      AND "archivedAt" IS NOT NULL
      AND (
        ("preArchiveStatus" = 'DRAFT' AND "publishedAt" IS NULL AND "cancelledAt" IS NULL)
        OR ("preArchiveStatus" = 'PUBLISHED' AND "publishedAt" IS NOT NULL AND "cancelledAt" IS NULL)
        OR ("preArchiveStatus" = 'CANCELLED' AND "cancelledAt" IS NOT NULL)
      )
    )
  );

ALTER TABLE "EventSession"
  ADD CONSTRAINT "EventSession_time_range_check" CHECK ("endAt" > "startAt"),
  ADD CONSTRAINT "EventSession_sales_range_check" CHECK (
    "salesStartAt" < "salesEndAt" AND "salesEndAt" <= "startAt"
  ),
  ADD CONSTRAINT "EventSession_lifecycle_check" CHECK (
    ("status" = 'DRAFT' AND "publishedAt" IS NULL AND "cancelledAt" IS NULL)
    OR ("status" IN ('SCHEDULED', 'ON_SALE', 'SALES_PAUSED', 'COMPLETED') AND "publishedAt" IS NOT NULL AND "cancelledAt" IS NULL)
    OR ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL)
  );

ALTER TABLE "SessionPriceTier"
  ADD CONSTRAINT "SessionPriceTier_name_check" CHECK (char_length("name") BETWEEN 1 AND 80),
  ADD CONSTRAINT "SessionPriceTier_code_check" CHECK (
    char_length("code") BETWEEN 1 AND 20
    AND "code" ~ '^[A-Z0-9]+(?:[-_][A-Z0-9]+)*$'
  ),
  ADD CONSTRAINT "SessionPriceTier_priceMinor_check" CHECK ("priceMinor" >= 0),
  ADD CONSTRAINT "SessionPriceTier_displayOrder_check" CHECK ("displayOrder" >= 0),
  ADD CONSTRAINT "SessionPriceTier_description_check" CHECK (
    "description" IS NULL OR char_length("description") <= 500
  );

-- Event ownership and the stable public route identity are server-derived and
-- independently verified at the database boundary.
CREATE FUNCTION "Event_require_organizer_organization"() RETURNS trigger AS $$
DECLARE
  organization_kind "OrganizationKind";
  organization_slug TEXT;
BEGIN
  SELECT "kind", "slug" INTO organization_kind, organization_slug
  FROM "Organization"
  WHERE "id" = NEW."organizerOrganizationId";

  IF organization_kind IS DISTINCT FROM 'ORGANIZER' THEN
    RAISE EXCEPTION 'Events must belong to an organizer organization';
  END IF;

  IF NEW."publicSlug" IS DISTINCT FROM organization_slug || '--' || NEW."slug" THEN
    RAISE EXCEPTION 'Event public slugs must be derived from organizer and event slugs';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."organizerOrganizationId" IS DISTINCT FROM OLD."organizerOrganizationId" THEN
    RAISE EXCEPTION 'Events cannot be moved between organizer organizations';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Event_require_organizer_organization_trigger"
BEFORE INSERT OR UPDATE OF "organizerOrganizationId", "slug", "publicSlug" ON "Event"
FOR EACH ROW EXECUTE FUNCTION "Event_require_organizer_organization"();

CREATE FUNCTION "Event_protect_history"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'Only an empty draft event can be deleted';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Event_protect_history_trigger"
BEFORE DELETE ON "Event"
FOR EACH ROW EXECUTE FUNCTION "Event_protect_history"();

-- Access grants deliberately bridge organizer and venue-operator tenants.
-- The trigger verifies kinds, venue ownership, actor role, and append-only
-- revocation semantics even for writes outside the application service layer.
CREATE FUNCTION "VenueAccessGrant_enforce_boundary"() RETURNS trigger AS $$
DECLARE
  organizer_kind "OrganizationKind";
  operator_kind "OrganizationKind";
  venue_owner_id TEXT;
  actor_role "MembershipRole";
BEGIN
  SELECT "kind" INTO organizer_kind
  FROM "Organization"
  WHERE "id" = NEW."organizerOrganizationId";

  SELECT "kind" INTO operator_kind
  FROM "Organization"
  WHERE "id" = NEW."operatorOrganizationId";

  SELECT "organizationId" INTO venue_owner_id
  FROM "Venue"
  WHERE "id" = NEW."venueId";

  IF organizer_kind IS DISTINCT FROM 'ORGANIZER' THEN
    RAISE EXCEPTION 'Venue access can only be granted to an organizer organization';
  END IF;

  IF operator_kind IS DISTINCT FROM 'VENUE_OPERATOR'
     OR venue_owner_id IS DISTINCT FROM NEW."operatorOrganizationId" THEN
    RAISE EXCEPTION 'Venue access must be granted by the venue owning operator organization';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."grantedByUserId" IS NULL THEN
      RAISE EXCEPTION 'Venue access grants require an authorized granting user';
    END IF;

    SELECT "role" INTO actor_role
    FROM "Membership"
    WHERE "userId" = NEW."grantedByUserId"
      AND "organizationId" = NEW."operatorOrganizationId";

    IF actor_role IS NULL OR actor_role = 'MEMBER' THEN
      RAISE EXCEPTION 'Only venue-operator owners or administrators can grant access';
    END IF;
  ELSE
    IF NEW."organizerOrganizationId" IS DISTINCT FROM OLD."organizerOrganizationId"
       OR NEW."operatorOrganizationId" IS DISTINCT FROM OLD."operatorOrganizationId"
       OR NEW."venueId" IS DISTINCT FROM OLD."venueId"
       OR (
         NEW."grantedByUserId" IS DISTINCT FROM OLD."grantedByUserId"
         AND NEW."grantedByUserId" IS NOT NULL
       )
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
      RAISE EXCEPTION 'Venue access grant identity is immutable';
    END IF;

    IF OLD."status" = 'REVOKED' THEN
      IF NEW."status" IS DISTINCT FROM OLD."status"
         OR NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt"
         OR (
           NEW."revokedByUserId" IS DISTINCT FROM OLD."revokedByUserId"
           AND NEW."revokedByUserId" IS NOT NULL
         ) THEN
        RAISE EXCEPTION 'Revoked venue access grants are immutable';
      END IF;

      RETURN NEW;
    END IF;

    IF NEW."status" = 'REVOKED' THEN
      IF NEW."revokedByUserId" IS NULL OR NEW."revokedAt" IS NULL THEN
        RAISE EXCEPTION 'Venue access revocation requires an authorized user and timestamp';
      END IF;

      SELECT "role" INTO actor_role
      FROM "Membership"
      WHERE "userId" = NEW."revokedByUserId"
        AND "organizationId" = NEW."operatorOrganizationId";

      IF actor_role IS NULL OR actor_role = 'MEMBER' THEN
        RAISE EXCEPTION 'Only venue-operator owners or administrators can revoke access';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "VenueAccessGrant_enforce_boundary_trigger"
BEFORE INSERT OR UPDATE ON "VenueAccessGrant"
FOR EACH ROW EXECUTE FUNCTION "VenueAccessGrant_enforce_boundary"();

-- Validate the complete session ancestry. An archived seat-map version remains
-- a valid historical reference after publication, so current map/access status
-- is rechecked only for creation, reference changes, and first publication.
CREATE FUNCTION "EventSession_enforce_ancestry"() RETURNS trigger AS $$
DECLARE
  organizer_id TEXT;
  space_venue_id TEXT;
  space_status "SpaceStatus";
  venue_status "VenueStatus";
  map_space_id TEXT;
  map_status "SeatMapStatus";
  active_grants INTEGER;
  requires_current_access BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."eventId" IS DISTINCT FROM OLD."eventId" THEN
    RAISE EXCEPTION 'Sessions cannot be moved between events';
  END IF;

  SELECT "organizerOrganizationId" INTO organizer_id
  FROM "Event"
  WHERE "id" = NEW."eventId";

  SELECT "venueId", "status" INTO space_venue_id, space_status
  FROM "Space"
  WHERE "id" = NEW."spaceId";

  SELECT "status" INTO venue_status
  FROM "Venue"
  WHERE "id" = NEW."venueId";

  SELECT "spaceId", "status" INTO map_space_id, map_status
  FROM "SeatMap"
  WHERE "id" = NEW."seatMapId";

  IF space_venue_id IS DISTINCT FROM NEW."venueId" THEN
    RAISE EXCEPTION 'The selected space does not belong to the selected venue';
  END IF;

  IF map_space_id IS DISTINCT FROM NEW."spaceId" THEN
    RAISE EXCEPTION 'The selected seat map does not belong to the selected space';
  END IF;

  requires_current_access := TG_OP = 'INSERT'
    OR NEW."eventId" IS DISTINCT FROM OLD."eventId"
    OR NEW."venueId" IS DISTINCT FROM OLD."venueId"
    OR NEW."spaceId" IS DISTINCT FROM OLD."spaceId"
    OR NEW."seatMapId" IS DISTINCT FROM OLD."seatMapId"
    OR (OLD."publishedAt" IS NULL AND NEW."publishedAt" IS NOT NULL);

  IF requires_current_access THEN
    IF venue_status IS DISTINCT FROM 'ACTIVE' OR space_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'Sessions require an active venue and space';
    END IF;

    IF map_status IS DISTINCT FROM 'PUBLISHED' THEN
      RAISE EXCEPTION 'Sessions require an exact published seat-map version';
    END IF;

    SELECT count(*) INTO active_grants
    FROM "VenueAccessGrant"
    WHERE "organizerOrganizationId" = organizer_id
      AND "venueId" = NEW."venueId"
      AND "status" = 'ACTIVE';

    IF active_grants <> 1 THEN
      RAISE EXCEPTION 'The organizer does not have active access to this venue';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EventSession_enforce_ancestry_trigger"
BEFORE INSERT OR UPDATE OF "eventId", "venueId", "spaceId", "seatMapId", "publishedAt" ON "EventSession"
FOR EACH ROW EXECUTE FUNCTION "EventSession_enforce_ancestry"();

CREATE FUNCTION "EventSession_protect_published_snapshot"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' OR OLD."publishedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Published or historical sessions cannot be deleted';
    END IF;

    RETURN OLD;
  END IF;

  IF OLD."publishedAt" IS NOT NULL AND (
    NEW."eventId" IS DISTINCT FROM OLD."eventId"
    OR NEW."venueId" IS DISTINCT FROM OLD."venueId"
    OR NEW."spaceId" IS DISTINCT FROM OLD."spaceId"
    OR NEW."seatMapId" IS DISTINCT FROM OLD."seatMapId"
    OR NEW."startAt" IS DISTINCT FROM OLD."startAt"
    OR NEW."endAt" IS DISTINCT FROM OLD."endAt"
    OR NEW."salesStartAt" IS DISTINCT FROM OLD."salesStartAt"
    OR NEW."salesEndAt" IS DISTINCT FROM OLD."salesEndAt"
    OR NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt"
  ) THEN
    RAISE EXCEPTION 'Published session configuration is immutable';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EventSession_protect_published_snapshot_trigger"
BEFORE UPDATE OR DELETE ON "EventSession"
FOR EACH ROW EXECUTE FUNCTION "EventSession_protect_published_snapshot"();

-- PostgreSQL protects overlap races that application preflight checks cannot
-- eliminate. Half-open [start, end) ranges allow back-to-back sessions.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "EventSession"
  ADD CONSTRAINT "EventSession_no_overlapping_space_time"
  EXCLUDE USING gist (
    "spaceId" WITH =,
    tstzrange("startAt", "endAt", '[)') WITH &&
  )
  WHERE ("status" <> 'CANCELLED')
  DEFERRABLE INITIALLY IMMEDIATE;

CREATE FUNCTION "SessionPriceTier_enforce_draft_and_currency"() RETURNS trigger AS $$
DECLARE
  session_status "EventSessionStatus";
  conflicting_currency_count INTEGER;
  target_session_id TEXT;
BEGIN
  target_session_id := COALESCE(NEW."sessionId", OLD."sessionId");

  IF TG_OP = 'UPDATE' AND NEW."sessionId" IS DISTINCT FROM OLD."sessionId" THEN
    RAISE EXCEPTION 'Price tiers cannot be moved between sessions';
  END IF;

  SELECT "status" INTO session_status
  FROM "EventSession"
  WHERE "id" = target_session_id;

  IF session_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Price tiers can only be changed on draft sessions';
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT count(*) INTO conflicting_currency_count
    FROM "SessionPriceTier"
    WHERE "sessionId" = NEW."sessionId"
      AND "id" <> NEW."id"
      AND "currency" <> NEW."currency";

    IF conflicting_currency_count > 0 THEN
      RAISE EXCEPTION 'All price tiers in a session must use one currency';
    END IF;

    RETURN NEW;
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SessionPriceTier_enforce_draft_and_currency_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "SessionPriceTier"
FOR EACH ROW EXECUTE FUNCTION "SessionPriceTier_enforce_draft_and_currency"();

CREATE FUNCTION "SessionSectionPricing_enforce_ancestry"() RETURNS trigger AS $$
DECLARE
  target_session_id TEXT;
  session_map_id TEXT;
  session_status "EventSessionStatus";
  tier_session_id TEXT;
  section_map_id TEXT;
BEGIN
  target_session_id := COALESCE(NEW."sessionId", OLD."sessionId");

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Section pricing assignments must be replaced, not re-parented';
  END IF;

  SELECT "seatMapId", "status" INTO session_map_id, session_status
  FROM "EventSession"
  WHERE "id" = target_session_id;

  IF session_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Section pricing can only be changed on draft sessions';
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT "sessionId" INTO tier_session_id
    FROM "SessionPriceTier"
    WHERE "id" = NEW."priceTierId";

    SELECT "seatMapId" INTO section_map_id
    FROM "SeatSection"
    WHERE "id" = NEW."sectionId";

    IF tier_session_id IS DISTINCT FROM NEW."sessionId" THEN
      RAISE EXCEPTION 'The price tier belongs to another session';
    END IF;

    IF section_map_id IS DISTINCT FROM session_map_id THEN
      RAISE EXCEPTION 'The seat section belongs to another seat map';
    END IF;

    RETURN NEW;
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SessionSectionPricing_enforce_ancestry_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "SessionSectionPricing"
FOR EACH ROW EXECUTE FUNCTION "SessionSectionPricing_enforce_ancestry"();
