-- CreateEnum
CREATE TYPE "VenueStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SpaceType" AS ENUM ('CINEMA', 'THEATRE', 'CONCERT_HALL', 'STADIUM', 'ARENA', 'GENERAL');

-- CreateEnum
CREATE TYPE "SpaceStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SeatMapStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SeatType" AS ENUM ('STANDARD', 'ACCESSIBLE', 'COMPANION', 'PREMIUM');

-- CreateEnum
CREATE TYPE "SeatState" AS ENUM ('ACTIVE', 'BLOCKED');

-- CreateTable
CREATE TABLE "Venue" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "addressLine1" TEXT NOT NULL,
    "addressLine2" TEXT,
    "city" TEXT NOT NULL,
    "countryCode" CHAR(2) NOT NULL,
    "postalCode" TEXT,
    "timeZone" TEXT NOT NULL,
    "status" "VenueStatus" NOT NULL DEFAULT 'DRAFT',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Venue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Space" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "type" "SpaceType" NOT NULL DEFAULT 'GENERAL',
    "status" "SpaceStatus" NOT NULL DEFAULT 'DRAFT',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Space_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeatMap" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "sourceSeatMapId" TEXT,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "SeatMapStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeatMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeatSection" (
    "id" TEXT NOT NULL,
    "seatMapId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeatSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeatRow" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeatRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Seat" (
    "id" TEXT NOT NULL,
    "rowId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL,
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "type" "SeatType" NOT NULL DEFAULT 'STANDARD',
    "state" "SeatState" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Seat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Venue_organizationId_status_idx" ON "Venue"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Venue_organizationId_name_idx" ON "Venue"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Venue_organizationId_slug_key" ON "Venue"("organizationId", "slug");

-- CreateIndex
CREATE INDEX "Space_venueId_status_idx" ON "Space"("venueId", "status");

-- CreateIndex
CREATE INDEX "Space_venueId_name_idx" ON "Space"("venueId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Space_venueId_slug_key" ON "Space"("venueId", "slug");

-- CreateIndex
CREATE INDEX "SeatMap_spaceId_status_idx" ON "SeatMap"("spaceId", "status");

-- CreateIndex
CREATE INDEX "SeatMap_sourceSeatMapId_idx" ON "SeatMap"("sourceSeatMapId");

-- CreateIndex
CREATE UNIQUE INDEX "SeatMap_spaceId_version_key" ON "SeatMap"("spaceId", "version");

-- Only one seat-map version can be the currently published layout for a space.
-- Archived historical versions are deliberately excluded from this constraint.
CREATE UNIQUE INDEX "SeatMap_one_published_per_space_key"
ON "SeatMap"("spaceId")
WHERE "status" = 'PUBLISHED';

-- CreateIndex
CREATE INDEX "SeatSection_seatMapId_displayOrder_idx" ON "SeatSection"("seatMapId", "displayOrder");

-- CreateIndex
CREATE UNIQUE INDEX "SeatSection_seatMapId_code_key" ON "SeatSection"("seatMapId", "code");

-- CreateIndex
CREATE INDEX "SeatRow_sectionId_displayOrder_idx" ON "SeatRow"("sectionId", "displayOrder");

-- CreateIndex
CREATE UNIQUE INDEX "SeatRow_sectionId_label_key" ON "SeatRow"("sectionId", "label");

-- CreateIndex
CREATE INDEX "Seat_rowId_displayOrder_idx" ON "Seat"("rowId", "displayOrder");

-- CreateIndex
CREATE INDEX "Seat_type_state_idx" ON "Seat"("type", "state");

-- CreateIndex
CREATE UNIQUE INDEX "Seat_rowId_label_key" ON "Seat"("rowId", "label");

-- AddForeignKey
ALTER TABLE "Venue" ADD CONSTRAINT "Venue_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Space" ADD CONSTRAINT "Space_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatMap" ADD CONSTRAINT "SeatMap_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatMap" ADD CONSTRAINT "SeatMap_sourceSeatMapId_fkey" FOREIGN KEY ("sourceSeatMapId") REFERENCES "SeatMap"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatSection" ADD CONSTRAINT "SeatSection_seatMapId_fkey" FOREIGN KEY ("seatMapId") REFERENCES "SeatMap"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatRow" ADD CONSTRAINT "SeatRow_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "SeatSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_rowId_fkey" FOREIGN KEY ("rowId") REFERENCES "SeatRow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A venue can only be attached to a venue-operator tenant, including when a
-- privileged database client writes outside the application service layer.
CREATE FUNCTION "Venue_require_operator_organization"() RETURNS trigger AS $$
DECLARE organization_kind "OrganizationKind";
BEGIN
  SELECT "kind" INTO organization_kind
  FROM "Organization"
  WHERE "id" = NEW."organizationId";

  IF organization_kind IS DISTINCT FROM 'VENUE_OPERATOR' THEN
    RAISE EXCEPTION 'Venues must belong to a venue-operator organization';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Venue_require_operator_organization_trigger"
BEFORE INSERT OR UPDATE OF "organizationId" ON "Venue"
FOR EACH ROW EXECUTE FUNCTION "Venue_require_operator_organization"();

-- Clone provenance is meaningful only inside one space's version history.
CREATE FUNCTION "SeatMap_require_same_space_source"() RETURNS trigger AS $$
DECLARE source_space_id TEXT;
BEGIN
  IF NEW."sourceSeatMapId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "spaceId" INTO source_space_id
  FROM "SeatMap"
  WHERE "id" = NEW."sourceSeatMapId";

  IF source_space_id IS DISTINCT FROM NEW."spaceId" THEN
    RAISE EXCEPTION 'A cloned seat map must use a source from the same space';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SeatMap_require_same_space_source_trigger"
BEFORE INSERT OR UPDATE OF "spaceId", "sourceSeatMapId" ON "SeatMap"
FOR EACH ROW EXECUTE FUNCTION "SeatMap_require_same_space_source"();

-- Domain checks keep invalid lifecycle values and editor geometry out of the
-- database even when data is written outside the application service layer.
ALTER TABLE "Venue"
  ADD CONSTRAINT "Venue_countryCode_check" CHECK ("countryCode" ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT "Venue_archive_state_check" CHECK (("status" = 'ARCHIVED') = ("archivedAt" IS NOT NULL));

ALTER TABLE "Space"
  ADD CONSTRAINT "Space_archive_state_check" CHECK (("status" = 'ARCHIVED') = ("archivedAt" IS NOT NULL));

ALTER TABLE "SeatMap"
  ADD CONSTRAINT "SeatMap_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "SeatMap_publish_state_check" CHECK (
    ("status" = 'DRAFT' AND "publishedAt" IS NULL)
    OR ("status" IN ('PUBLISHED', 'ARCHIVED') AND "publishedAt" IS NOT NULL)
  );

ALTER TABLE "SeatSection"
  ADD CONSTRAINT "SeatSection_displayOrder_check" CHECK ("displayOrder" >= 0);

ALTER TABLE "SeatRow"
  ADD CONSTRAINT "SeatRow_displayOrder_check" CHECK ("displayOrder" >= 0);

ALTER TABLE "Seat"
  ADD CONSTRAINT "Seat_displayOrder_check" CHECK ("displayOrder" >= 0),
  ADD CONSTRAINT "Seat_x_check" CHECK ("x" BETWEEN 0 AND 10000),
  ADD CONSTRAINT "Seat_y_check" CHECK ("y" BETWEEN 0 AND 10000);

-- Published and archived layouts are immutable at the database boundary. The
-- application may only transition a published map to ARCHIVED when a new map
-- is published; all layout editing is restricted to DRAFT maps.
CREATE FUNCTION "SeatMap_enforce_immutable_version"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'Published and archived seat maps cannot be deleted';
    END IF;

    RETURN OLD;
  END IF;

  IF OLD."status" = 'ARCHIVED' THEN
    RAISE EXCEPTION 'Archived seat maps are immutable';
  END IF;

  IF OLD."status" = 'PUBLISHED' THEN
    IF NEW."status" NOT IN ('PUBLISHED', 'ARCHIVED')
      OR NEW."spaceId" IS DISTINCT FROM OLD."spaceId"
      OR NEW."sourceSeatMapId" IS DISTINCT FROM OLD."sourceSeatMapId"
      OR NEW."name" IS DISTINCT FROM OLD."name"
      OR NEW."version" IS DISTINCT FROM OLD."version"
      OR NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt" THEN
      RAISE EXCEPTION 'Published seat maps are immutable';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SeatMap_immutable_version_trigger"
BEFORE UPDATE OR DELETE ON "SeatMap"
FOR EACH ROW EXECUTE FUNCTION "SeatMap_enforce_immutable_version"();

CREATE FUNCTION "SeatSection_require_draft_map"() RETURNS trigger AS $$
DECLARE map_status "SeatMapStatus";
BEGIN
  SELECT "status" INTO map_status
  FROM "SeatMap"
  WHERE "id" = COALESCE(NEW."seatMapId", OLD."seatMapId");

  IF map_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Seat-map sections can only be changed on draft maps';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SeatSection_require_draft_map_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "SeatSection"
FOR EACH ROW EXECUTE FUNCTION "SeatSection_require_draft_map"();

CREATE FUNCTION "SeatRow_require_draft_map"() RETURNS trigger AS $$
DECLARE map_status "SeatMapStatus";
BEGIN
  SELECT map."status" INTO map_status
  FROM "SeatSection" section
  JOIN "SeatMap" map ON map."id" = section."seatMapId"
  WHERE section."id" = COALESCE(NEW."sectionId", OLD."sectionId");

  IF map_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Seat-map rows can only be changed on draft maps';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SeatRow_require_draft_map_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "SeatRow"
FOR EACH ROW EXECUTE FUNCTION "SeatRow_require_draft_map"();

CREATE FUNCTION "Seat_require_draft_map"() RETURNS trigger AS $$
DECLARE map_status "SeatMapStatus";
BEGIN
  SELECT map."status" INTO map_status
  FROM "SeatRow" row_record
  JOIN "SeatSection" section ON section."id" = row_record."sectionId"
  JOIN "SeatMap" map ON map."id" = section."seatMapId"
  WHERE row_record."id" = COALESCE(NEW."rowId", OLD."rowId");

  IF map_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Seats can only be changed on draft maps';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Seat_require_draft_map_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "Seat"
FOR EACH ROW EXECUTE FUNCTION "Seat_require_draft_map"();
