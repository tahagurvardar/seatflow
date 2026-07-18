import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client";
import { createDatabaseClient } from "../../src/lib/database";
import { findAuthorizedEvent } from "../../src/server/authorization/event-resources";
import {
  archiveEvent,
  cancelEvent,
  createEvent,
  publishEvent,
  restoreEvent,
  updateEvent,
} from "../../src/server/events/event-service";
import {
  cancelEventSession,
  createEventSession,
  publishEventSession,
  updateDraftEventSession,
} from "../../src/server/events/event-session-service";
import {
  EventAuthorizationError,
  EventConflictError,
  EventLifecycleError,
  EventValidationError,
} from "../../src/server/events/errors";
import {
  assignSessionSectionPricing,
  createSessionPriceTier,
  deleteUnusedSessionPriceTier,
  moveSessionPriceTier,
  updateSessionPriceTier,
} from "../../src/server/events/pricing-service";
import {
  getPublicEventBySlug,
  getPublicEvents,
} from "../../src/server/events/public-event-service";
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
import {
  grantVenueAccess,
  revokeVenueAccess,
} from "../../src/server/venue-access/venue-access-service";
import { resetIntegrationDatabase } from "./reset-database";

let database: PrismaClient;

async function createUser(prefix: string) {
  return database.user.create({
    data: {
      name: `${prefix} User`,
      email: `${prefix.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@example.com`,
    },
  });
}

async function createPhase3Fixture(prefix = "Phase Three") {
  const operatorOwner = await createUser(`${prefix} Operator Owner`);
  const operator = await createVenueOperatorOrganization(database, {
    userId: operatorOwner.id,
    name: `${prefix} Venue Group`,
  });
  const venue = await createVenue(
    database,
    { userId: operatorOwner.id, organizationSlug: operator.slug },
    {
      name: `${prefix} Hall`,
      addressLine1: "1 Promenade Avenue",
      city: "Baku",
      countryCode: "AZ",
      timeZone: "Asia/Baku",
      status: "ACTIVE",
    },
  );
  const space = await createSpace(
    database,
    {
      userId: operatorOwner.id,
      organizationSlug: operator.slug,
      venueSlug: venue.slug,
    },
    { name: "Main Auditorium", type: "THEATRE", status: "ACTIVE" },
  );
  const mapScope = {
    userId: operatorOwner.id,
    organizationSlug: operator.slug,
    venueSlug: venue.slug,
    spaceSlug: space.slug,
  };
  const seatMap = await createDraftSeatMap(database, mapScope, {
    name: "Session layout",
  });
  const section = await createSection(
    database,
    { ...mapScope, seatMapId: seatMap.id },
    { name: "Orchestra", code: "ORCH" },
  );
  await bulkGenerateRows(
    database,
    { ...mapScope, seatMapId: seatMap.id, sectionId: section.id },
    {
      startRowLabel: "A",
      rowCount: 2,
      seatsPerRow: 3,
      startSeatNumber: 1,
      horizontalSpacing: 40,
      verticalSpacing: 40,
    },
  );
  await publishSeatMap(database, { ...mapScope, seatMapId: seatMap.id });

  const organizerOwner = await createUser(`${prefix} Organizer Owner`);
  const organizer = await createOrganizerOrganization(database, {
    userId: organizerOwner.id,
    name: `${prefix} Live`,
  });
  const grant = await grantVenueAccess(
    database,
    {
      userId: operatorOwner.id,
      organizationSlug: operator.slug,
      venueSlug: venue.slug,
    },
    organizer.slug,
  );
  const event = await createEvent(
    database,
    { userId: organizerOwner.id, organizationSlug: organizer.slug },
    {
      title: `${prefix} Event`,
      shortDescription: "A persistent event configured for integration testing.",
      description:
        "A complete persistent event description used to verify authorization, sessions, pricing, and public visibility.",
      category: "CONCERT",
      imagePath: "/events/aurora-room.svg",
    },
  );

  return {
    operatorOwner,
    operator,
    venue,
    space,
    seatMap,
    section,
    organizerOwner,
    organizer,
    grant,
    event,
  };
}

function sessionInput(
  fixture: Awaited<ReturnType<typeof createPhase3Fixture>>,
  values: { day?: number; start?: string; end?: string } = {},
) {
  const day = String(values.day ?? 10).padStart(2, "0");
  return {
    venueId: fixture.venue.id,
    spaceId: fixture.space.id,
    seatMapId: fixture.seatMap.id,
    startLocal: `2035-05-${day}T${values.start ?? "20:00"}`,
    endLocal: `2035-05-${day}T${values.end ?? "22:00"}`,
    salesStartLocal: "2035-04-01T10:00",
    salesEndLocal: `2035-05-${day}T${values.start ?? "20:00"}`,
  };
}

function eventScope(fixture: Awaited<ReturnType<typeof createPhase3Fixture>>) {
  return {
    userId: fixture.organizerOwner.id,
    organizationSlug: fixture.organizer.slug,
    eventSlug: fixture.event.slug,
  };
}

async function createSession(
  fixture: Awaited<ReturnType<typeof createPhase3Fixture>>,
  values: { day?: number; start?: string; end?: string } = {},
) {
  return createEventSession(database, eventScope(fixture), sessionInput(fixture, values));
}

async function priceAndPublishSession(
  fixture: Awaited<ReturnType<typeof createPhase3Fixture>>,
  sessionId: string,
) {
  const scope = { ...eventScope(fixture), sessionId };
  const tier = await createSessionPriceTier(database, scope, {
    name: "Standard",
    code: "STD",
    priceMinor: 2_500,
    currency: "AZN",
    description: "Standard section price",
  });
  await assignSessionSectionPricing(database, scope, {
    assignments: [{ sectionId: fixture.section.id, priceTierId: tier.id }],
  });
  const published = await publishEventSession(database, scope);
  return { tier, published };
}

beforeEach(async () => {
  database = createDatabaseClient();
  await resetIntegrationDatabase(database);
});

afterEach(async () => {
  await database.$disconnect();
});

describe("Phase 3 event ownership and lifecycle", () => {
  it("creates tenant-owned events with scoped slug uniqueness and cross-tenant denial", async () => {
    const first = await createPhase3Fixture("Ownership A");
    const second = await createPhase3Fixture("Ownership B");

    await expect(
      createEvent(database, {
        userId: first.organizerOwner.id,
        organizationSlug: first.organizer.slug,
      }, {
        title: first.event.title,
        slug: first.event.slug,
        shortDescription: first.event.shortDescription,
        description: first.event.description,
        category: "CONCERT",
      }),
    ).rejects.toBeInstanceOf(EventConflictError);

    await expect(
      createEvent(database, {
        userId: second.organizerOwner.id,
        organizationSlug: second.organizer.slug,
      }, {
        title: "A different tenant event",
        slug: first.event.slug,
        shortDescription: "The same organizer-scoped slug in another tenant.",
        description:
          "This event proves that event slug uniqueness is deliberately scoped to the owning organizer.",
        category: "OTHER",
      }),
    ).resolves.toMatchObject({ slug: first.event.slug });

    await expect(
      findAuthorizedEvent(database, {
        userId: second.organizerOwner.id,
        organizationSlug: second.organizer.slug,
        eventId: first.event.id,
      }),
    ).resolves.toBeNull();
    await expect(
      updateEvent(database, {
        userId: second.organizerOwner.id,
        organizationSlug: first.organizer.slug,
        eventSlug: first.event.slug,
      }, {
        title: "Cross tenant mutation",
        shortDescription: "This mutation must not reach another organizer event.",
        description:
          "This attempted cross-tenant update should be rejected by scoped authorization before persistence.",
        category: "OTHER",
      }),
    ).rejects.toBeInstanceOf(EventAuthorizationError);
  });

  it("enforces OWNER/ADMIN management and MEMBER read-only permissions", async () => {
    const fixture = await createPhase3Fixture("Roles");
    const member = await createUser("Roles Member");
    const administrator = await createUser("Roles Admin");
    await database.membership.createMany({ data: [
      { userId: member.id, organizationId: fixture.organizer.id, role: "MEMBER" },
      { userId: administrator.id, organizationId: fixture.organizer.id, role: "ADMIN" },
    ] });

    await expect(createEvent(database, { userId: member.id, organizationSlug: fixture.organizer.slug }, {
      title: "Member Event",
      shortDescription: "Members cannot create persistent organizer events.",
      description: "This write must fail because organizer members are deliberately read-only during Phase 3.",
      category: "OTHER",
    })).rejects.toBeInstanceOf(EventAuthorizationError);
    await expect(createEvent(database, { userId: administrator.id, organizationSlug: fixture.organizer.slug }, {
      title: "Administrator Event",
      shortDescription: "Administrators can manage authorized organizer events.",
      description: "This event confirms that organizer administrators share event management capability with owners.",
      category: "OTHER",
    })).resolves.toMatchObject({ title: "Administrator Event" });
  });

  it("denies customer-only and venue-operator identities and ignores client ownership fields", async () => {
    const fixture = await createPhase3Fixture("Identity Boundary");
    const customer = await createUser("Identity Boundary Customer");

    await expect(createEvent(database, {
      userId: customer.id,
      organizationSlug: fixture.organizer.slug,
    }, {
      title: "Customer Event",
      shortDescription: "A customer without organizer membership cannot create this event.",
      description:
        "This attempted event creation proves that authentication alone does not confer organizer tenant capability.",
      category: "OTHER",
    })).rejects.toBeInstanceOf(EventAuthorizationError);

    await expect(createEvent(database, {
      userId: fixture.operatorOwner.id,
      organizationSlug: fixture.organizer.slug,
    }, {
      title: "Operator Event",
      shortDescription: "A venue-operator membership cannot manage organizer content.",
      description:
        "This attempted event creation proves that venue ownership and organizer event ownership remain separate capabilities.",
      category: "OTHER",
    })).rejects.toBeInstanceOf(EventAuthorizationError);

    const other = await createPhase3Fixture("Identity Boundary Other");
    const created = await createEvent(database, {
      userId: fixture.organizerOwner.id,
      organizationSlug: fixture.organizer.slug,
    }, {
      title: "Server Derived Ownership",
      shortDescription: "The server derives ownership from the authorized route context.",
      description:
        "A client-supplied organizer identifier is discarded by runtime validation and cannot move this event into another tenant.",
      category: "OTHER",
      organizerOrganizationId: other.organizer.id,
    } as Parameters<typeof createEvent>[2]);
    expect(created.organizerOrganizationId).toBe(fixture.organizer.id);
  });

  it("archives and restores eligible events, while cancellation preserves sessions", async () => {
    const fixture = await createPhase3Fixture("Lifecycle Event");
    const session = await createSession(fixture);
    await expect(archiveEvent(database, eventScope(fixture))).resolves.toMatchObject({ status: "ARCHIVED", preArchiveStatus: "DRAFT" });
    await expect(updateDraftEventSession(database, {
      ...eventScope(fixture),
      sessionId: session.id,
    }, sessionInput(fixture))).rejects.toBeInstanceOf(EventLifecycleError);
    await expect(createSessionPriceTier(database, {
      ...eventScope(fixture),
      sessionId: session.id,
    }, {
      name: "Archived tier",
      code: "ARCH",
      priceMinor: 1_000,
      currency: "AZN",
    })).rejects.toBeInstanceOf(EventLifecycleError);
    await expect(restoreEvent(database, eventScope(fixture))).resolves.toMatchObject({ status: "DRAFT", preArchiveStatus: null });
    await expect(cancelEvent(database, eventScope(fixture))).resolves.toMatchObject({ status: "CANCELLED" });
    await expect(database.eventSession.findUniqueOrThrow({ where: { id: session.id } })).resolves.toMatchObject({ status: "CANCELLED" });
    await expect(database.event.count({ where: { id: fixture.event.id } })).resolves.toBe(1);
  });
});

describe("Phase 3 venue access boundary", () => {
  it("allows operator OWNER/ADMIN grants, denies MEMBER grants, and revokes idempotently", async () => {
    const fixture = await createPhase3Fixture("Venue Grant");
    const secondOrganizerOwner = await createUser("Venue Grant Second Organizer");
    const secondOrganizer = await createOrganizerOrganization(database, { userId: secondOrganizerOwner.id, name: "Venue Grant Second Live" });
    const operatorMember = await createUser("Venue Grant Operator Member");
    const operatorAdmin = await createUser("Venue Grant Operator Admin");
    await database.membership.createMany({ data: [
      { userId: operatorMember.id, organizationId: fixture.operator.id, role: "MEMBER" },
      { userId: operatorAdmin.id, organizationId: fixture.operator.id, role: "ADMIN" },
    ] });

    await expect(grantVenueAccess(database, { userId: operatorMember.id, organizationSlug: fixture.operator.slug, venueSlug: fixture.venue.slug }, secondOrganizer.slug)).rejects.toBeInstanceOf(EventAuthorizationError);
    const adminGrant = await grantVenueAccess(database, { userId: operatorAdmin.id, organizationSlug: fixture.operator.slug, venueSlug: fixture.venue.slug }, secondOrganizer.slug);
    expect(adminGrant.status).toBe("ACTIVE");
    await expect(revokeVenueAccess(database, { userId: operatorAdmin.id, organizationSlug: fixture.operator.slug, venueSlug: fixture.venue.slug, grantId: adminGrant.id })).resolves.toMatchObject({ status: "REVOKED" });
    await expect(revokeVenueAccess(database, { userId: operatorAdmin.id, organizationSlug: fixture.operator.slug, venueSlug: fixture.venue.slug, grantId: adminGrant.id })).resolves.toMatchObject({ status: "REVOKED" });
  });

  it("prevents an organizer from approving its own venue access", async () => {
    const fixture = await createPhase3Fixture("No Self Approval");
    const secondOrganizerOwner = await createUser("No Self Approval Organizer");
    const secondOrganizer = await createOrganizerOrganization(database, {
      userId: secondOrganizerOwner.id,
      name: "Independent Self Approval Live",
    });

    await expect(grantVenueAccess(database, {
      userId: secondOrganizerOwner.id,
      organizationSlug: fixture.operator.slug,
      venueSlug: fixture.venue.slug,
    }, secondOrganizer.slug)).rejects.toBeInstanceOf(EventAuthorizationError);
  });

  it("blocks new sessions after revocation without corrupting published history", async () => {
    const fixture = await createPhase3Fixture("Revoke History");
    const session = await createSession(fixture);
    await priceAndPublishSession(fixture, session.id);
    await revokeVenueAccess(database, { userId: fixture.operatorOwner.id, organizationSlug: fixture.operator.slug, venueSlug: fixture.venue.slug, grantId: fixture.grant.id });

    await expect(createSession(fixture, { day: 11 })).rejects.toBeInstanceOf(EventAuthorizationError);
    await expect(database.eventSession.findUniqueOrThrow({ where: { id: session.id } })).resolves.toMatchObject({ status: "SCHEDULED", seatMapId: fixture.seatMap.id });
  });

  it("enforces organizer/operator kinds and grant actor roles in PostgreSQL", async () => {
    const fixture = await createPhase3Fixture("Grant Database");
    await expect(database.venueAccessGrant.create({ data: {
      organizerOrganizationId: fixture.operator.id,
      operatorOrganizationId: fixture.operator.id,
      venueId: fixture.venue.id,
      grantedByUserId: fixture.operatorOwner.id,
    } })).rejects.toThrow(/organizer organization/i);
  });
});

describe("Phase 3 sessions, conflicts, and ancestry", () => {
  it("creates a UTC session from venue-local input and binds the exact published map", async () => {
    const fixture = await createPhase3Fixture("Session Create");
    const session = await createSession(fixture);
    expect(session).toMatchObject({ venueId: fixture.venue.id, spaceId: fixture.space.id, seatMapId: fixture.seatMap.id, status: "DRAFT" });
    expect(session.startAt.toISOString()).toBe("2035-05-10T16:00:00.000Z");
  });

  it("rejects draft maps, wrong ancestry, ungranted venues, and client-guessed nested ids", async () => {
    const fixture = await createPhase3Fixture("Session Security");
    const draftMap = await createDraftSeatMap(database, {
      userId: fixture.operatorOwner.id,
      organizationSlug: fixture.operator.slug,
      venueSlug: fixture.venue.slug,
      spaceSlug: fixture.space.slug,
    }, { name: "Unpublished map" });
    await expect(createEventSession(database, eventScope(fixture), { ...sessionInput(fixture), seatMapId: draftMap.id })).rejects.toBeInstanceOf(EventAuthorizationError);

    const other = await createPhase3Fixture("Session Security Other");
    await expect(createEventSession(database, eventScope(fixture), { ...sessionInput(fixture), venueId: other.venue.id, spaceId: other.space.id, seatMapId: other.seatMap.id })).rejects.toBeInstanceOf(EventAuthorizationError);
    await expect(createEventSession(database, eventScope(fixture), { ...sessionInput(fixture), spaceId: other.space.id })).rejects.toBeInstanceOf(EventAuthorizationError);
  });

  it("rejects overlaps, permits exact boundaries, and ignores cancelled sessions", async () => {
    const fixture = await createPhase3Fixture("Session Conflict");
    const first = await createSession(fixture, { start: "20:00", end: "22:00" });
    await expect(createSession(fixture, { start: "21:00", end: "23:00" })).rejects.toBeInstanceOf(EventConflictError);
    await expect(createSession(fixture, { start: "22:00", end: "23:00" })).resolves.toMatchObject({ status: "DRAFT" });
    await cancelEventSession(database, { ...eventScope(fixture), sessionId: first.id });
    await expect(createSession(fixture, { start: "20:00", end: "21:00" })).resolves.toMatchObject({ status: "DRAFT" });
  });
});

describe("Phase 3 pricing, publication, and public visibility", () => {
  it("edits, reorders, and deletes unused draft tiers while allowing intentional zero prices", async () => {
    const fixture = await createPhase3Fixture("Pricing Draft Workflow");
    const session = await createSession(fixture);
    const scope = { ...eventScope(fixture), sessionId: session.id };
    const standard = await createSessionPriceTier(database, scope, {
      name: "Standard",
      code: "STD",
      priceMinor: 2_000,
      currency: "AZN",
    });
    const complimentary = await createSessionPriceTier(database, scope, {
      name: "Complimentary",
      code: "COMP",
      priceMinor: 0,
      currency: "AZN",
    });

    await expect(updateSessionPriceTier(database, {
      ...scope,
      priceTierId: standard.id,
    }, {
      name: "Standard admission",
      code: "STD",
      priceMinor: 2_500,
      currency: "AZN",
    })).resolves.toMatchObject({ priceMinor: 2_500 });
    await moveSessionPriceTier(database, {
      ...scope,
      priceTierId: complimentary.id,
      direction: "up",
    });
    await expect(database.sessionPriceTier.findMany({
      where: { sessionId: session.id },
      orderBy: { displayOrder: "asc" },
      select: { code: true },
    })).resolves.toEqual([{ code: "COMP" }, { code: "STD" }]);
    await expect(deleteUnusedSessionPriceTier(database, {
      ...scope,
      priceTierId: complimentary.id,
    })).resolves.toMatchObject({ id: complimentary.id });
  });

  it("rejects incomplete coverage, publishes atomically, and freezes the session and pricing", async () => {
    const fixture = await createPhase3Fixture("Session Publish");
    const session = await createSession(fixture);
    const scope = { ...eventScope(fixture), sessionId: session.id };
    await expect(publishEventSession(database, scope)).rejects.toBeInstanceOf(EventValidationError);

    const { tier, published } = await priceAndPublishSession(fixture, session.id);
    expect(published).toMatchObject({ status: "SCHEDULED", seatMapId: fixture.seatMap.id });
    await expect(publishEventSession(database, scope)).resolves.toMatchObject({ id: session.id, status: "SCHEDULED" });
    await expect(updateDraftEventSession(database, scope, { ...sessionInput(fixture), startLocal: "2035-05-10T21:00", endLocal: "2035-05-10T23:00" })).rejects.toBeInstanceOf(EventLifecycleError);
    await expect(createSessionPriceTier(database, scope, { name: "Late tier", code: "LATE", priceMinor: 100, currency: "AZN" })).rejects.toBeInstanceOf(EventLifecycleError);
    await expect(database.sessionPriceTier.update({ where: { id: tier.id }, data: { priceMinor: 1 } })).rejects.toThrow(/draft sessions/i);
    await expect(database.seatMap.delete({ where: { id: fixture.seatMap.id } })).rejects.toThrow();
  });

  it("rejects cross-session tiers and cross-map sections at the database boundary", async () => {
    const fixture = await createPhase3Fixture("Pricing Ancestry");
    const first = await createSession(fixture, { day: 10 });
    const second = await createSession(fixture, { day: 11 });
    const firstTier = await createSessionPriceTier(database, { ...eventScope(fixture), sessionId: first.id }, { name: "First", code: "FIRST", priceMinor: 1_000, currency: "AZN" });
    const secondTier = await createSessionPriceTier(database, { ...eventScope(fixture), sessionId: second.id }, { name: "Second", code: "SECOND", priceMinor: 2_000, currency: "AZN" });
    await expect(database.sessionSectionPricing.create({ data: { sessionId: first.id, sectionId: fixture.section.id, priceTierId: secondTier.id } })).rejects.toThrow(/another session/i);

    const other = await createPhase3Fixture("Pricing Ancestry Other");
    await expect(database.sessionSectionPricing.create({ data: { sessionId: first.id, sectionId: other.section.id, priceTierId: firstTier.id } })).rejects.toThrow(/another seat map/i);
  });

  it("publishes a visible event only after a valid future session and returns true 404 data for other slugs", async () => {
    const fixture = await createPhase3Fixture("Public Event");
    await expect(publishEvent(database, eventScope(fixture))).rejects.toBeInstanceOf(EventValidationError);
    const session = await createSession(fixture);
    await priceAndPublishSession(fixture, session.id);
    const publishedEvent = await publishEvent(database, eventScope(fixture));
    expect(publishedEvent.status).toBe("PUBLISHED");

    const publicEvents = await getPublicEvents(new Date("2035-01-01T00:00:00Z"));
    expect(publicEvents.map((event) => event.slug)).toContain(fixture.event.publicSlug);
    await expect(getPublicEventBySlug(fixture.event.publicSlug, new Date("2035-01-01T00:00:00Z"))).resolves.toMatchObject({ title: fixture.event.title, minimumPriceMinor: 2_500, sellableCapacity: 6 });
    await expect(getPublicEventBySlug("missing--event", new Date("2035-01-01T00:00:00Z"))).resolves.toBeNull();
  });
});
