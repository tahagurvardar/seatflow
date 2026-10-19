import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client";
import { toVenueLocalInputValue } from "../../src/features/events/date-time";
import { createDatabaseClient } from "../../src/lib/database";
import {
  createEventSession,
  publishEventSession,
} from "../../src/server/events/event-session-service";
import { createEvent, publishEvent } from "../../src/server/events/event-service";
import {
  assignSessionSectionPricing,
  createSessionPriceTier,
} from "../../src/server/events/pricing-service";
import { acquireSeatHold } from "../../src/server/holds/hold-service";
import { getSeatSelectionView } from "../../src/server/holds/hold-queries";
import { createOrganizerOrganization } from "../../src/server/organizations/create-organizer-organization";
import { createVenueOperatorOrganization } from "../../src/server/organizations/create-venue-operator-organization";
import {
  bulkGenerateRows,
  createDraftSeatMap,
  createSection,
  publishSeatMap,
} from "../../src/server/seat-maps/seat-map-service";
import { grantVenueAccess } from "../../src/server/venue-access/venue-access-service";
import { createSpace } from "../../src/server/venues/space-service";
import { createVenue } from "../../src/server/venues/venue-service";
import { resetIntegrationDatabase } from "./reset-database";

// Read-only seat-selection view metadata added in M5.3: event image/category,
// session end time, real price tiers and the per-seat tier id. Fixtures are
// built through the real services; only the isolated test database is used.

let database: PrismaClient;

async function createUser(prefix: string) {
  return database.user.create({
    data: {
      name: `${prefix} User`,
      email: `${prefix.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    },
  });
}

function sellableTimes(timeZone: string) {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const start = new Date(now + 30 * day);
  return {
    startLocal: toVenueLocalInputValue(start, timeZone),
    endLocal: toVenueLocalInputValue(new Date(start.getTime() + 2 * 60 * 60 * 1000), timeZone),
    salesStartLocal: toVenueLocalInputValue(new Date(now - 60 * 60 * 1000), timeZone),
    salesEndLocal: toVenueLocalInputValue(new Date(now + 29 * day), timeZone),
  };
}

async function createTwoTierSession() {
  const operatorOwner = await createUser("Operator");
  const operator = await createVenueOperatorOrganization(database, {
    userId: operatorOwner.id,
    name: "M5 Venue Group",
  });
  const venue = await createVenue(
    database,
    { userId: operatorOwner.id, organizationSlug: operator.slug },
    {
      name: "M5 Hall",
      addressLine1: "1 Promenade Avenue",
      city: "Baku",
      countryCode: "AZ",
      timeZone: "Asia/Baku",
      status: "ACTIVE",
    },
  );
  const space = await createSpace(
    database,
    { userId: operatorOwner.id, organizationSlug: operator.slug, venueSlug: venue.slug },
    { name: "Main Auditorium", type: "THEATRE", status: "ACTIVE" },
  );
  const mapScope = {
    userId: operatorOwner.id,
    organizationSlug: operator.slug,
    venueSlug: venue.slug,
    spaceSlug: space.slug,
  };
  const seatMap = await createDraftSeatMap(database, mapScope, { name: "Two sections" });
  const stalls = await createSection(database, { ...mapScope, seatMapId: seatMap.id }, { name: "Stalls", code: "ST" });
  const balcony = await createSection(database, { ...mapScope, seatMapId: seatMap.id }, { name: "Balcony", code: "BA" });
  for (const section of [stalls, balcony]) {
    await bulkGenerateRows(
      database,
      { ...mapScope, seatMapId: seatMap.id, sectionId: section.id },
      { startRowLabel: "A", rowCount: 1, seatsPerRow: 3, startSeatNumber: 1, horizontalSpacing: 40, verticalSpacing: 40 },
    );
  }
  await publishSeatMap(database, { ...mapScope, seatMapId: seatMap.id });

  const organizerOwner = await createUser("Organizer");
  const organizer = await createOrganizerOrganization(database, {
    userId: organizerOwner.id,
    name: "M5 Live",
  });
  await grantVenueAccess(
    database,
    { userId: operatorOwner.id, organizationSlug: operator.slug, venueSlug: venue.slug },
    organizer.slug,
  );
  const event = await createEvent(
    database,
    { userId: organizerOwner.id, organizationSlug: organizer.slug },
    {
      title: "M5 Selection View",
      shortDescription: "An event used to verify read-only seat-selection metadata.",
      description: "A complete event description used only by the M5.3 seat-selection view integration test.",
      category: "THEATRE",
      imagePath: "/events/aurora-room.svg",
    },
  );
  const organizerScope = {
    userId: organizerOwner.id,
    organizationSlug: organizer.slug,
    eventSlug: event.slug,
  };
  const session = await createEventSession(database, organizerScope, {
    venueId: venue.id,
    spaceId: space.id,
    seatMapId: seatMap.id,
    ...sellableTimes(venue.timeZone),
  });
  const scope = { ...organizerScope, sessionId: session.id };
  const front = await createSessionPriceTier(database, scope, {
    name: "Front Stalls",
    code: "FRONT",
    priceMinor: 15_000,
    currency: "AZN",
  });
  const standard = await createSessionPriceTier(database, scope, {
    name: "Balcony Standard",
    code: "STD",
    priceMinor: 9_050,
    currency: "AZN",
  });
  await assignSessionSectionPricing(database, scope, {
    assignments: [
      { sectionId: stalls.id, priceTierId: front.id },
      { sectionId: balcony.id, priceTierId: standard.id },
    ],
  });
  await publishEventSession(database, scope);
  await publishEvent(database, organizerScope);

  const inventory = await database.sessionSeatInventory.findMany({
    where: { sessionId: session.id },
    orderBy: { seatId: "asc" },
    select: { seatId: true, sectionId: true },
  });
  return { event, session, stalls, balcony, front, standard, inventory };
}

beforeEach(async () => {
  database = createDatabaseClient();
  await resetIntegrationDatabase(database);
});

afterEach(async () => {
  await database.$disconnect();
});

describe("M5.3 seat-selection view metadata", () => {
  it("returns real event, session and price-tier metadata", async () => {
    const fixture = await createTwoTierSession();
    const view = await getSeatSelectionView(database, null, {
      publicSlug: fixture.event.publicSlug,
      sessionId: fixture.session.id,
    });

    expect(view).not.toBeNull();
    expect(view!.event).toEqual({
      title: "M5 Selection View",
      publicSlug: fixture.event.publicSlug,
      category: "THEATRE",
      imagePath: "/events/aurora-room.svg",
    });
    const stored = await database.eventSession.findUniqueOrThrow({
      where: { id: fixture.session.id },
      select: { endAt: true },
    });
    expect(view!.session.endAt).toBe(stored.endAt.toISOString());
    expect(view!.priceTiers.map((tier) => [tier.name, tier.code, tier.priceMinor, tier.currency])).toEqual([
      ["Front Stalls", "FRONT", 15_000, "AZN"],
      ["Balcony Standard", "STD", 9_050, "AZN"],
    ]);

    const tierBySection = new Map(
      view!.sections.map((section) => [section.id, new Set(section.rows.flatMap((row) => row.seats.map((seat) => seat.priceTierId)))]),
    );
    expect(tierBySection.get(fixture.stalls.id)).toEqual(new Set([fixture.front.id]));
    expect(tierBySection.get(fixture.balcony.id)).toEqual(new Set([fixture.standard.id]));
  });

  it("hides another customer's tier with the price, but shows the viewer's own", async () => {
    const fixture = await createTwoTierSession();
    const other = await createUser("Other");
    const viewer = await createUser("Viewer");
    const stallsSeats = fixture.inventory.filter((row) => row.sectionId === fixture.stalls.id);
    await acquireSeatHold(database, { userId: other.id }, {
      sessionId: fixture.session.id,
      seatIds: [stallsSeats[0]!.seatId],
      idempotencyKey: "m5-other-hold-0001",
    });
    await acquireSeatHold(database, { userId: viewer.id }, {
      sessionId: fixture.session.id,
      seatIds: [stallsSeats[1]!.seatId],
      idempotencyKey: "m5-viewer-hold-0001",
    });

    const view = await getSeatSelectionView(database, { userId: viewer.id }, {
      publicSlug: fixture.event.publicSlug,
      sessionId: fixture.session.id,
    });
    const seats = new Map(
      view!.sections.flatMap((section) => section.rows.flatMap((row) => row.seats)).map((seat) => [seat.seatId, seat]),
    );
    expect(seats.get(stallsSeats[0]!.seatId)).toMatchObject({
      state: "UNAVAILABLE",
      priceMinor: null,
      currency: null,
      priceTierId: null,
    });
    expect(seats.get(stallsSeats[1]!.seatId)).toMatchObject({
      state: "HELD_BY_YOU",
      priceMinor: 15_000,
      currency: "AZN",
      priceTierId: fixture.front.id,
    });
    // Tier list is session pricing, not availability: both tiers stay listed.
    expect(view!.priceTiers).toHaveLength(2);
  });
});
