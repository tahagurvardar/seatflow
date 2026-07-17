-- Re-parenting a layout child is both a removal from its old seat map and an
-- insertion into its new seat map. Check both ownership chains on UPDATE so a
-- direct database write cannot move content into or out of an immutable map.
CREATE OR REPLACE FUNCTION "SeatSection_require_draft_map"() RETURNS trigger AS $$
DECLARE
  old_map_status "SeatMapStatus";
  new_map_status "SeatMapStatus";
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT "status" INTO old_map_status
    FROM "SeatMap"
    WHERE "id" = OLD."seatMapId";

    IF old_map_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'Seat-map sections can only be changed on draft maps';
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT "status" INTO new_map_status
    FROM "SeatMap"
    WHERE "id" = NEW."seatMapId";

    IF new_map_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'Seat-map sections can only be changed on draft maps';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "SeatRow_require_draft_map"() RETURNS trigger AS $$
DECLARE
  old_map_status "SeatMapStatus";
  new_map_status "SeatMapStatus";
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT map."status" INTO old_map_status
    FROM "SeatSection" section
    JOIN "SeatMap" map ON map."id" = section."seatMapId"
    WHERE section."id" = OLD."sectionId";

    IF old_map_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'Seat-map rows can only be changed on draft maps';
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT map."status" INTO new_map_status
    FROM "SeatSection" section
    JOIN "SeatMap" map ON map."id" = section."seatMapId"
    WHERE section."id" = NEW."sectionId";

    IF new_map_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'Seat-map rows can only be changed on draft maps';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "Seat_require_draft_map"() RETURNS trigger AS $$
DECLARE
  old_map_status "SeatMapStatus";
  new_map_status "SeatMapStatus";
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT map."status" INTO old_map_status
    FROM "SeatRow" row_record
    JOIN "SeatSection" section ON section."id" = row_record."sectionId"
    JOIN "SeatMap" map ON map."id" = section."seatMapId"
    WHERE row_record."id" = OLD."rowId";

    IF old_map_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'Seats can only be changed on draft maps';
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT map."status" INTO new_map_status
    FROM "SeatRow" row_record
    JOIN "SeatSection" section ON section."id" = row_record."sectionId"
    JOIN "SeatMap" map ON map."id" = section."seatMapId"
    WHERE row_record."id" = NEW."rowId";

    IF new_map_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'Seats can only be changed on draft maps';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
