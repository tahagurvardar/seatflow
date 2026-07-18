import type { PrismaClient } from "../../src/generated/prisma/client";
import { toVenueLocalInputValue } from "../../src/features/events/date-time";
import { createEventSession, publishEventSession } from "../../src/server/events/event-session-service";
import { createEvent, publishEvent } from "../../src/server/events/event-service";
import { assignSessionSectionPricing, createSessionPriceTier } from "../../src/server/events/pricing-service";
import { createOrganizerOrganization } from "../../src/server/organizations/create-organizer-organization";
import { createVenueOperatorOrganization } from "../../src/server/organizations/create-venue-operator-organization";
import { bulkGenerateRows, createDraftSeatMap, createSection, publishSeatMap } from "../../src/server/seat-maps/seat-map-service";
import { createSpace } from "../../src/server/venues/space-service";
import { createVenue } from "../../src/server/venues/venue-service";
import { grantVenueAccess } from "../../src/server/venue-access/venue-access-service";

export async function createRedisInventoryFixture(database: PrismaClient, prefix: string) {
  const operatorOwner = await database.user.create({
    data: {
      name: `${prefix} Operator`,
      email: `${prefix.toLowerCase()}-operator-${Math.random().toString(36).slice(2, 8)}@example.com`,
    },
  });
  const operator = await createVenueOperatorOrganization(database, {
    userId: operatorOwner.id,
    name: `${prefix} Venue Group`,
  });
  const venue = await createVenue(
    database,
    { userId: operatorOwner.id, organizationSlug: operator.slug },
    {
      name: `${prefix} Hall`,
      addressLine1: "1 Test Avenue",
      city: "Baku",
      countryCode: "AZ",
      timeZone: "Asia/Baku",
      status: "ACTIVE",
    },
  );
  const space = await createSpace(
    database,
    { userId: operatorOwner.id, organizationSlug: operator.slug, venueSlug: venue.slug },
    { name: "Main", type: "THEATRE", status: "ACTIVE" },
  );
  const mapScope = {
    userId: operatorOwner.id,
    organizationSlug: operator.slug,
    venueSlug: venue.slug,
    spaceSlug: space.slug,
  };
  const seatMap = await createDraftSeatMap(database, mapScope, { name: "Redis layout" });
  const section = await createSection(
    database,
    { ...mapScope, seatMapId: seatMap.id },
    { name: "Main", code: "MAIN" },
  );
  await bulkGenerateRows(
    database,
    { ...mapScope, seatMapId: seatMap.id, sectionId: section.id },
    {
      startRowLabel: "A",
      rowCount: 1,
      seatsPerRow: 4,
      startSeatNumber: 1,
      horizontalSpacing: 40,
      verticalSpacing: 40,
    },
  );
  await publishSeatMap(database, { ...mapScope, seatMapId: seatMap.id });

  const organizerOwner = await database.user.create({
    data: {
      name: `${prefix} Organizer`,
      email: `${prefix.toLowerCase()}-organizer-${Math.random().toString(36).slice(2, 8)}@example.com`,
    },
  });
  const organizer = await createOrganizerOrganization(database, {
    userId: organizerOwner.id,
    name: `${prefix} Organizer`,
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
      title: `${prefix} Event`,
      shortDescription: "A Redis integration event with authoritative PostgreSQL inventory.",
      description: "A complete event used only for real Redis and BullMQ integration verification.",
      category: "CONCERT",
      imagePath: "/events/aurora-room.svg",
    },
  );
  const organizerScope = {
    userId: organizerOwner.id,
    organizationSlug: organizer.slug,
    eventSlug: event.slug,
  };
  const reference = Date.now();
  const day = 24 * 60 * 60 * 1_000;
  const start = new Date(reference + 30 * day);
  const session = await createEventSession(database, organizerScope, {
    venueId: venue.id,
    spaceId: space.id,
    seatMapId: seatMap.id,
    startLocal: toVenueLocalInputValue(start, venue.timeZone),
    endLocal: toVenueLocalInputValue(new Date(start.getTime() + 2 * 60 * 60 * 1_000), venue.timeZone),
    salesStartLocal: toVenueLocalInputValue(new Date(reference - 60 * 60 * 1_000), venue.timeZone),
    salesEndLocal: toVenueLocalInputValue(new Date(reference + 29 * day), venue.timeZone),
  });
  const sessionScope = { ...organizerScope, sessionId: session.id };
  const tier = await createSessionPriceTier(database, sessionScope, {
    name: "Standard",
    code: "STD",
    priceMinor: 2_500,
    currency: "AZN",
  });
  await assignSessionSectionPricing(database, sessionScope, {
    assignments: [{ sectionId: section.id, priceTierId: tier.id }],
  });
  await publishEventSession(database, sessionScope);
  await publishEvent(database, organizerScope);

  const inventory = await database.sessionSeatInventory.findMany({
    where: { sessionId: session.id },
    orderBy: { seatId: "asc" },
    select: { id: true, seatId: true },
  });
  return {
    session,
    inventory,
    seatIds: inventory.map((row) => row.seatId),
    organizerScope,
  };
}

export async function createRedisTestCustomer(database: PrismaClient, prefix: string) {
  return database.user.create({
    data: {
      name: `${prefix} Customer`,
      email: `${prefix.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    },
  });
}
