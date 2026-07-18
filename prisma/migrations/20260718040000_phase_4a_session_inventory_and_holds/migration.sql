-- CreateEnum
CREATE TYPE "SeatInventoryState" AS ENUM ('AVAILABLE', 'HELD');

-- CreateEnum
CREATE TYPE "SeatHoldStatus" AS ENUM ('ACTIVE', 'RELEASED', 'EXPIRED');

-- CreateTable
CREATE TABLE "SessionSeatInventory" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "seatId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "priceTierId" TEXT NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "currency" "Currency" NOT NULL,
    "state" "SeatInventoryState" NOT NULL DEFAULT 'AVAILABLE',
    "currentHoldId" TEXT,
    "holdExpiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SessionSeatInventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeatHold" (
    "id" TEXT NOT NULL,
    "publicToken" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "SeatHoldStatus" NOT NULL DEFAULT 'ACTIVE',
    "idempotencyKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "releasedAt" TIMESTAMPTZ(3),
    "expiredAt" TIMESTAMPTZ(3),

    CONSTRAINT "SeatHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeatHoldItem" (
    "id" TEXT NOT NULL,
    "holdId" TEXT NOT NULL,
    "inventoryId" TEXT NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "currency" "Currency" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeatHoldItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SessionSeatInventory_sessionId_state_idx" ON "SessionSeatInventory"("sessionId", "state");

-- CreateIndex
CREATE INDEX "SessionSeatInventory_currentHoldId_idx" ON "SessionSeatInventory"("currentHoldId");

-- CreateIndex
CREATE INDEX "SessionSeatInventory_holdExpiresAt_idx" ON "SessionSeatInventory"("holdExpiresAt");

-- CreateIndex
CREATE INDEX "SessionSeatInventory_seatId_idx" ON "SessionSeatInventory"("seatId");

-- CreateIndex
CREATE INDEX "SessionSeatInventory_priceTierId_idx" ON "SessionSeatInventory"("priceTierId");

-- CreateIndex
CREATE INDEX "SessionSeatInventory_sectionId_idx" ON "SessionSeatInventory"("sectionId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionSeatInventory_sessionId_seatId_key" ON "SessionSeatInventory"("sessionId", "seatId");

-- CreateIndex
CREATE UNIQUE INDEX "SeatHold_publicToken_key" ON "SeatHold"("publicToken");

-- CreateIndex
CREATE INDEX "SeatHold_status_expiresAt_idx" ON "SeatHold"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "SeatHold_userId_status_idx" ON "SeatHold"("userId", "status");

-- CreateIndex
CREATE INDEX "SeatHold_sessionId_status_idx" ON "SeatHold"("sessionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SeatHold_sessionId_userId_idempotencyKey_key" ON "SeatHold"("sessionId", "userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "SeatHoldItem_inventoryId_idx" ON "SeatHoldItem"("inventoryId");

-- CreateIndex
CREATE UNIQUE INDEX "SeatHoldItem_holdId_inventoryId_key" ON "SeatHoldItem"("holdId", "inventoryId");

-- AddForeignKey
ALTER TABLE "SessionSeatInventory" ADD CONSTRAINT "SessionSeatInventory_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "EventSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionSeatInventory" ADD CONSTRAINT "SessionSeatInventory_seatId_fkey" FOREIGN KEY ("seatId") REFERENCES "Seat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionSeatInventory" ADD CONSTRAINT "SessionSeatInventory_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "SeatSection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionSeatInventory" ADD CONSTRAINT "SessionSeatInventory_priceTierId_fkey" FOREIGN KEY ("priceTierId") REFERENCES "SessionPriceTier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionSeatInventory" ADD CONSTRAINT "SessionSeatInventory_currentHoldId_fkey" FOREIGN KEY ("currentHoldId") REFERENCES "SeatHold"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatHold" ADD CONSTRAINT "SeatHold_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "EventSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatHold" ADD CONSTRAINT "SeatHold_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatHoldItem" ADD CONSTRAINT "SeatHoldItem_holdId_fkey" FOREIGN KEY ("holdId") REFERENCES "SeatHold"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatHoldItem" ADD CONSTRAINT "SeatHoldItem_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES "SessionSeatInventory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- Phase 4A hardening: authoritative inventory and atomic holds.
-- Application services own materialization and hold acquisition, but the
-- invariants below are enforced in PostgreSQL as the source of truth so that no
-- direct write, concurrency race, or future accelerator can double-allocate a
-- seat, forge a price, or rewrite an immutable snapshot. These are a second line
-- of defense behind friendly application validation.
-- =============================================================================

-- Inventory state must be internally consistent, and the snapshot price cannot
-- be negative. AVAILABLE seats carry no hold; HELD seats carry a hold and expiry.
ALTER TABLE "SessionSeatInventory"
  ADD CONSTRAINT "SessionSeatInventory_priceMinor_check" CHECK ("priceMinor" >= 0),
  ADD CONSTRAINT "SessionSeatInventory_state_check" CHECK (
    ("state" = 'AVAILABLE' AND "currentHoldId" IS NULL AND "holdExpiresAt" IS NULL)
    OR ("state" = 'HELD' AND "currentHoldId" IS NOT NULL AND "holdExpiresAt" IS NOT NULL)
  );

-- Hold lifecycle timestamps must match status, the token must be unguessably
-- long, and expiry must be after creation (a hold is never born expired).
ALTER TABLE "SeatHold"
  ADD CONSTRAINT "SeatHold_publicToken_check" CHECK (char_length("publicToken") >= 20),
  ADD CONSTRAINT "SeatHold_idempotencyKey_check" CHECK (char_length("idempotencyKey") BETWEEN 1 AND 191),
  ADD CONSTRAINT "SeatHold_expiry_after_creation_check" CHECK ("expiresAt" > "createdAt"),
  ADD CONSTRAINT "SeatHold_lifecycle_check" CHECK (
    ("status" = 'ACTIVE' AND "releasedAt" IS NULL AND "expiredAt" IS NULL)
    OR ("status" = 'RELEASED' AND "releasedAt" IS NOT NULL AND "expiredAt" IS NULL)
    OR ("status" = 'EXPIRED' AND "expiredAt" IS NOT NULL AND "releasedAt" IS NULL)
  );

ALTER TABLE "SeatHoldItem"
  ADD CONSTRAINT "SeatHoldItem_priceMinor_check" CHECK ("priceMinor" >= 0);

-- At most one ACTIVE hold per customer per session. Released and expired holds
-- remain as history, so this partial index constrains only live contention.
CREATE UNIQUE INDEX "SeatHold_one_active_per_user_session_key"
ON "SeatHold"("userId", "sessionId")
WHERE "status" = 'ACTIVE';

-- Inventory ancestry: a row must describe an ACTIVE physical seat, in its own
-- section, in the session's exact seat map, priced by a tier that belongs to the
-- session and is the tier assigned to that section. Price and currency are
-- faithful snapshots of that tier. Any active hold must be for the same session.
CREATE FUNCTION "SessionSeatInventory_enforce_ancestry"() RETURNS trigger AS $$
DECLARE
  seat_state "SeatState";
  seat_section_id TEXT;
  section_map_id TEXT;
  session_map_id TEXT;
  tier_session_id TEXT;
  tier_currency "Currency";
  tier_price INTEGER;
  assigned_tier_id TEXT;
  hold_session_id TEXT;
BEGIN
  SELECT seat."state", section."id", section."seatMapId"
    INTO seat_state, seat_section_id, section_map_id
  FROM "Seat" seat
  JOIN "SeatRow" seat_row ON seat_row."id" = seat."rowId"
  JOIN "SeatSection" section ON section."id" = seat_row."sectionId"
  WHERE seat."id" = NEW."seatId";

  IF seat_section_id IS NULL THEN
    RAISE EXCEPTION 'Inventory references a seat that does not exist';
  END IF;
  IF seat_section_id IS DISTINCT FROM NEW."sectionId" THEN
    RAISE EXCEPTION 'Inventory seat does not belong to its recorded section';
  END IF;
  IF seat_state IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'Inventory can only reference active sellable seats';
  END IF;

  SELECT "seatMapId" INTO session_map_id
  FROM "EventSession" WHERE "id" = NEW."sessionId";

  IF section_map_id IS DISTINCT FROM session_map_id THEN
    RAISE EXCEPTION 'Inventory section belongs to a different seat map than the session';
  END IF;

  SELECT "sessionId", "currency", "priceMinor"
    INTO tier_session_id, tier_currency, tier_price
  FROM "SessionPriceTier" WHERE "id" = NEW."priceTierId";

  IF tier_session_id IS DISTINCT FROM NEW."sessionId" THEN
    RAISE EXCEPTION 'Inventory price tier belongs to another session';
  END IF;
  IF tier_currency IS DISTINCT FROM NEW."currency" THEN
    RAISE EXCEPTION 'Inventory currency must match its price tier';
  END IF;
  IF tier_price IS DISTINCT FROM NEW."priceMinor" THEN
    RAISE EXCEPTION 'Inventory price snapshot must match its price tier';
  END IF;

  SELECT "priceTierId" INTO assigned_tier_id
  FROM "SessionSectionPricing"
  WHERE "sessionId" = NEW."sessionId" AND "sectionId" = NEW."sectionId";

  IF assigned_tier_id IS DISTINCT FROM NEW."priceTierId" THEN
    RAISE EXCEPTION 'Inventory price tier does not match the section pricing assignment';
  END IF;

  IF NEW."currentHoldId" IS NOT NULL THEN
    SELECT "sessionId" INTO hold_session_id
    FROM "SeatHold" WHERE "id" = NEW."currentHoldId";
    IF hold_session_id IS DISTINCT FROM NEW."sessionId" THEN
      RAISE EXCEPTION 'The active hold belongs to a different session';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SessionSeatInventory_enforce_ancestry_trigger"
BEFORE INSERT ON "SessionSeatInventory"
FOR EACH ROW EXECUTE FUNCTION "SessionSeatInventory_enforce_ancestry"();

-- After creation, inventory ancestry and its price snapshot are immutable, a
-- row can never move to another session, and inventory is never deleted (holds
-- preserve history). Only availability state and hold linkage may change, and
-- any active hold must stay within the same session.
CREATE FUNCTION "SessionSeatInventory_protect_snapshot"() RETURNS trigger AS $$
DECLARE
  hold_session_id TEXT;
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

  IF NEW."currentHoldId" IS NOT NULL THEN
    SELECT "sessionId" INTO hold_session_id
    FROM "SeatHold" WHERE "id" = NEW."currentHoldId";
    IF hold_session_id IS DISTINCT FROM NEW."sessionId" THEN
      RAISE EXCEPTION 'The active hold belongs to a different session';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SessionSeatInventory_protect_snapshot_trigger"
BEFORE UPDATE OR DELETE ON "SessionSeatInventory"
FOR EACH ROW EXECUTE FUNCTION "SessionSeatInventory_protect_snapshot"();

-- A hold belongs to exactly one session and customer for its whole life; its
-- token, idempotency key, and creation time never change; a terminal (released
-- or expired) hold can never be revived; and holds are never deleted.
CREATE FUNCTION "SeatHold_protect_identity"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Holds are historical and cannot be deleted';
  END IF;

  IF NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
     OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."publicToken" IS DISTINCT FROM OLD."publicToken"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Hold identity is immutable';
  END IF;

  IF OLD."status" IN ('RELEASED', 'EXPIRED') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'A released or expired hold is terminal and cannot be revived';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SeatHold_protect_identity_trigger"
BEFORE UPDATE OR DELETE ON "SeatHold"
FOR EACH ROW EXECUTE FUNCTION "SeatHold_protect_identity"();

-- Hold items are immutable historical records. Each must reference inventory
-- from the hold's own session and carry that inventory's exact price snapshot,
-- never a client-supplied value.
CREATE FUNCTION "SeatHoldItem_enforce_ancestry"() RETURNS trigger AS $$
DECLARE
  hold_session_id TEXT;
  inventory_session_id TEXT;
  inventory_price INTEGER;
  inventory_currency "Currency";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Hold items are historical and cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Hold items are immutable';
  END IF;

  SELECT "sessionId" INTO hold_session_id
  FROM "SeatHold" WHERE "id" = NEW."holdId";

  SELECT "sessionId", "priceMinor", "currency"
    INTO inventory_session_id, inventory_price, inventory_currency
  FROM "SessionSeatInventory" WHERE "id" = NEW."inventoryId";

  IF inventory_session_id IS DISTINCT FROM hold_session_id THEN
    RAISE EXCEPTION 'A hold item must reference inventory from the hold session';
  END IF;
  IF NEW."priceMinor" IS DISTINCT FROM inventory_price
     OR NEW."currency" IS DISTINCT FROM inventory_currency THEN
    RAISE EXCEPTION 'Hold item price must be the inventory snapshot';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SeatHoldItem_enforce_ancestry_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "SeatHoldItem"
FOR EACH ROW EXECUTE FUNCTION "SeatHoldItem_enforce_ancestry"();
