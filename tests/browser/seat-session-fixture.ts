import { toVenueLocalInputValue } from "../../src/features/events/date-time";
import { numberToRowLabel } from "../../src/features/seat-maps/row-labels";
import { createEventSession, publishEventSession } from "../../src/server/events/event-session-service";
import { createEvent, publishEvent } from "../../src/server/events/event-service";
import { assignSessionSectionPricing, createSessionPriceTier } from "../../src/server/events/pricing-service";
import { acquireSeatHold, releaseSeatHold } from "../../src/server/holds/hold-service";
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
import { createBrowserTestDatabase } from "./seed";

/**
 * Published, sellable seat-selection sessions for the M5 browser checks,
 * built only through the real services. `createBrowserTestDatabase` refuses
 * anything but the isolated test database, so the development database is
 * unreachable from here. Each call uses a unique prefix; nothing is deleted.
 */

export interface SectionSpec {
  name: string;
  code: string;
  rows: number;
  seatsPerRow: number;
  tier: { name: string; code: string; priceMinor: number };
}

export interface SeatSessionFixture {
  publicSlug: string;
  sessionId: string;
  title: string;
  seatCount: number;
  /** A fixture-only customer, for contention checks. */
  competitorUserId: string;
}

const MAX_BULK_ROWS = 30;

export async function createSeatSession(label: string, sections: SectionSpec[]): Promise<SeatSessionFixture> {
  const database = createBrowserTestDatabase();
  try {
    const prefix = `${label}${Date.now().toString(36)}`;
    const user = (role: string) =>
      database.user.create({
        data: { name: `${prefix} ${role}`, email: `${prefix.toLowerCase()}-${role.toLowerCase()}@seatflow.invalid` },
      });
    const operatorOwner = await user("Operator");
    const operator = await createVenueOperatorOrganization(database, { userId: operatorOwner.id, name: `${prefix} Venues` });
    const venue = await createVenue(
      database,
      { userId: operatorOwner.id, organizationSlug: operator.slug },
      { name: `${prefix} Hall`, addressLine1: "1 Promenade Avenue", city: "Baku", countryCode: "AZ", timeZone: "Asia/Baku", status: "ACTIVE" },
    );
    const space = await createSpace(
      database,
      { userId: operatorOwner.id, organizationSlug: operator.slug, venueSlug: venue.slug },
      { name: "Main Auditorium", type: "THEATRE", status: "ACTIVE" },
    );
    const mapScope = { userId: operatorOwner.id, organizationSlug: operator.slug, venueSlug: venue.slug, spaceSlug: space.slug };
    const seatMap = await createDraftSeatMap(database, mapScope, { name: `${label} layout` });
    const created: Array<{ id: string; spec: SectionSpec }> = [];
    for (const spec of sections) {
      const section = await createSection(database, { ...mapScope, seatMapId: seatMap.id }, { name: spec.name, code: spec.code });
      for (let first = 0; first < spec.rows; first += MAX_BULK_ROWS) {
        await bulkGenerateRows(
          database,
          { ...mapScope, seatMapId: seatMap.id, sectionId: section.id },
          {
            startRowLabel: numberToRowLabel(first + 1),
            rowCount: Math.min(MAX_BULK_ROWS, spec.rows - first),
            seatsPerRow: spec.seatsPerRow,
            startSeatNumber: 1,
            horizontalSpacing: 40,
            verticalSpacing: 40,
          },
        );
      }
      created.push({ id: section.id, spec });
    }
    await publishSeatMap(database, { ...mapScope, seatMapId: seatMap.id });

    const organizerOwner = await user("Organizer");
    const organizer = await createOrganizerOrganization(database, { userId: organizerOwner.id, name: `${prefix} Live` });
    await grantVenueAccess(
      database,
      { userId: operatorOwner.id, organizationSlug: operator.slug, venueSlug: venue.slug },
      organizer.slug,
    );
    const title = `${prefix} Seat Selection`;
    const event = await createEvent(
      database,
      { userId: organizerOwner.id, organizationSlug: organizer.slug },
      {
        title,
        shortDescription: "A browser fixture for the seat-selection page composition.",
        description: "A complete event description used only by the M5 seat-selection browser verification.",
        category: "CONCERT",
        imagePath: "/events/aurora-room.svg",
      },
    );
    const organizerScope = { userId: organizerOwner.id, organizationSlug: organizer.slug, eventSlug: event.slug };
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const start = new Date(now + 30 * day);
    const session = await createEventSession(database, organizerScope, {
      venueId: venue.id,
      spaceId: space.id,
      seatMapId: seatMap.id,
      startLocal: toVenueLocalInputValue(start, venue.timeZone),
      endLocal: toVenueLocalInputValue(new Date(start.getTime() + 3 * 60 * 60 * 1000), venue.timeZone),
      salesStartLocal: toVenueLocalInputValue(new Date(now - 60 * 60 * 1000), venue.timeZone),
      salesEndLocal: toVenueLocalInputValue(new Date(now + 29 * day), venue.timeZone),
    });
    const scope = { ...organizerScope, sessionId: session.id };
    const assignments = [];
    for (const { id, spec } of created) {
      const tier = await createSessionPriceTier(database, scope, { ...spec.tier, currency: "AZN" });
      assignments.push({ sectionId: id, priceTierId: tier.id });
    }
    await assignSessionSectionPricing(database, scope, { assignments });
    await publishEventSession(database, scope);
    await publishEvent(database, organizerScope);
    const competitor = await user("Competitor");
    return {
      publicSlug: event.publicSlug,
      sessionId: session.id,
      title,
      seatCount: sections.reduce((total, spec) => total + spec.rows * spec.seatsPerRow, 0),
      competitorUserId: competitor.id,
    };
  } finally {
    await database.$disconnect();
  }
}

export function seatsPath(fixture: SeatSessionFixture) {
  return `/events/${fixture.publicSlug}/sessions/${fixture.sessionId}/seats`;
}

/** Hold one seat as the fixture competitor, through the real hold service. */
export async function holdAsCompetitor(fixture: SeatSessionFixture, seatId: string) {
  const database = createBrowserTestDatabase();
  try {
    const { hold } = await acquireSeatHold(database, { userId: fixture.competitorUserId }, {
      sessionId: fixture.sessionId,
      seatIds: [seatId],
      idempotencyKey: `m5-competitor-${seatId}-${Date.now()}`,
    });
    return hold.publicToken;
  } finally {
    await database.$disconnect();
  }
}

/** Release every active hold a user has on a session, through the real service. */
export async function releaseActiveHolds(sessionId: string, user: { userId?: string; email?: string }) {
  const database = createBrowserTestDatabase();
  try {
    const userId =
      user.userId ??
      (await database.user.findUniqueOrThrow({ where: { email: user.email! }, select: { id: true } })).id;
    const holds = await database.seatHold.findMany({
      where: { userId, sessionId, status: "ACTIVE" },
      select: { publicToken: true },
    });
    for (const hold of holds) {
      await releaseSeatHold(database, { userId }, { publicToken: hold.publicToken });
    }
    return holds.length;
  } finally {
    await database.$disconnect();
  }
}

/** Holds a user created on a session, by status (for duplicate-hold checks). */
export async function countHolds(sessionId: string, email: string) {
  const database = createBrowserTestDatabase();
  try {
    const { id } = await database.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
    return await database.seatHold.count({ where: { userId: id, sessionId } });
  } finally {
    await database.$disconnect();
  }
}
