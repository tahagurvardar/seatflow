import type { PrismaClient } from "../../src/generated/prisma/client";
import { toVenueLocalInputValue } from "../../src/features/events/date-time";
import {
  createEventSession,
  publishEventSession,
} from "../../src/server/events/event-session-service";
import { createEvent, publishEvent } from "../../src/server/events/event-service";
import {
  assignSessionSectionPricing,
  createSessionPriceTier,
} from "../../src/server/events/pricing-service";
import { createOrganizerOrganization } from "../../src/server/organizations/create-organizer-organization";
import { createVenueOperatorOrganization } from "../../src/server/organizations/create-venue-operator-organization";
import {
  bulkGenerateRows,
  createDraftSeatMap,
  createSection,
  publishSeatMap,
} from "../../src/server/seat-maps/seat-map-service";
import { createSpace } from "../../src/server/venues/space-service";
import { createVenue } from "../../src/server/venues/venue-service";
import { grantVenueAccess } from "../../src/server/venue-access/venue-access-service";

/**
 * Fixture builder for the load harness.
 *
 * Mirrors the integration fixture but takes a configurable seat count so a run
 * can generate real contention. It uses only synthetic `@example.com`
 * identities and fixed prices — never real customer data.
 *
 * It builds state through the same authoritative services the application uses,
 * so the inventory it produces is subject to every database trigger and
 * constraint a production session would be.
 */

function suffix() {
  return Math.random().toString(36).slice(2, 8);
}

export interface LoadFixtureOptions {
  prefix: string;
  rowCount?: number;
  seatsPerRow?: number;
  /**
   * Minutes from now until the session starts. The default places the session
   * inside a plausible entry window so ticket-validation scenarios exercise a
   * real acceptance rather than always returning TOO_EARLY, while keeping the
   * sales window open so hold and checkout scenarios still work.
   */
  startOffsetMinutes?: number;
}

export async function createLoadTestFixture(
  database: PrismaClient,
  options: LoadFixtureOptions,
) {
  const prefix = options.prefix;
  const rowCount = Math.min(Math.max(options.rowCount ?? 4, 1), 40);
  const seatsPerRow = Math.min(Math.max(options.seatsPerRow ?? 20, 1), 60);

  const operatorOwner = await database.user.create({
    data: {
      name: `${prefix} Operator`,
      email: `${prefix.toLowerCase()}-operator-${suffix()}@example.com`,
    },
  });
  const operator = await createVenueOperatorOrganization(database, {
    userId: operatorOwner.id,
    name: `${prefix} Venue Group ${suffix()}`,
  });
  const venue = await createVenue(
    database,
    { userId: operatorOwner.id, organizationSlug: operator.slug },
    {
      name: `${prefix} Hall`,
      addressLine1: "1 Load Avenue",
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
  const seatMap = await createDraftSeatMap(database, mapScope, { name: "Load layout" });
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
      rowCount,
      seatsPerRow,
      startSeatNumber: 1,
      horizontalSpacing: 40,
      verticalSpacing: 40,
    },
  );
  await publishSeatMap(database, { ...mapScope, seatMapId: seatMap.id });

  const organizerOwner = await database.user.create({
    data: {
      name: `${prefix} Organizer`,
      email: `${prefix.toLowerCase()}-organizer-${suffix()}@example.com`,
    },
  });
  const organizer = await createOrganizerOrganization(database, {
    userId: organizerOwner.id,
    name: `${prefix} Organizer ${suffix()}`,
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
      title: `${prefix} Load Event`,
      shortDescription: "Synthetic event used only by the local load harness.",
      description: "A complete synthetic event used only for local load and concurrency testing.",
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
  const minute = 60 * 1_000;
  const startOffsetMinutes = Math.min(Math.max(options.startOffsetMinutes ?? 60, 5), 60 * 24);
  const start = new Date(reference + startOffsetMinutes * minute);
  const session = await createEventSession(database, organizerScope, {
    venueId: venue.id,
    spaceId: space.id,
    seatMapId: seatMap.id,
    startLocal: toVenueLocalInputValue(start, venue.timeZone),
    endLocal: toVenueLocalInputValue(new Date(start.getTime() + 2 * 60 * minute), venue.timeZone),
    salesStartLocal: toVenueLocalInputValue(new Date(reference - 60 * minute), venue.timeZone),
    // Sales close just before the session starts so holds and checkout remain
    // available for the whole run.
    salesEndLocal: toVenueLocalInputValue(new Date(start.getTime() - minute), venue.timeZone),
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
    event,
    venue,
    organizerScope,
    publicSlug: event.publicSlug,
    inventory,
    seatIds: inventory.map((row) => row.seatId),
  };
}

export async function createLoadTestCustomers(
  database: PrismaClient,
  prefix: string,
  count: number,
) {
  const customers = [];
  for (let index = 0; index < count; index += 1) {
    customers.push(
      await database.user.create({
        data: {
          name: `${prefix} Customer ${index}`,
          email: `${prefix.toLowerCase()}-c${index}-${suffix()}@example.com`,
        },
      }),
    );
  }
  return customers;
}
