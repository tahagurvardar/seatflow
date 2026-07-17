import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client";
import { createDatabaseClient } from "../../src/lib/database";
import { createOrganizerOrganization } from "../../src/server/organizations/create-organizer-organization";
import { createVenueOperatorOrganization } from "../../src/server/organizations/create-venue-operator-organization";
import {
  bulkGenerateRows,
  clonePublishedSeatMap,
  createDraftSeatMap,
  createRow,
  createSeat,
  createSection,
  publishSeatMap,
  updateDraftSeatMap,
  updateSeat,
} from "../../src/server/seat-maps/seat-map-service";
import {
  findAuthorizedRow,
  findAuthorizedSeat,
  findAuthorizedSeatMap,
  findAuthorizedSection,
} from "../../src/server/authorization/venue-resources";
import {
  SeatMapValidationError,
  VenueManagementAuthorizationError,
  VenueManagementConflictError,
  VenueManagementLifecycleError,
} from "../../src/server/venues/errors";
import {
  createSpace,
  updateSpace,
} from "../../src/server/venues/space-service";
import { archiveVenue, createVenue, restoreVenue } from "../../src/server/venues/venue-service";
import { resetIntegrationDatabase } from "./reset-database";

let database: PrismaClient;

async function createOperatorFixture(prefix: string) {
  const user = await database.user.create({
    data: { name: `${prefix} Owner`, email: `${prefix.toLowerCase()}@example.com` },
  });
  const organization = await createVenueOperatorOrganization(database, {
    userId: user.id,
    name: `${prefix} Venue Group`,
  });
  const venue = await createVenue(
    database,
    { userId: user.id, organizationSlug: organization.slug },
    {
      name: `${prefix} Hall`,
      description: `${prefix} venue`,
      addressLine1: "1 Promenade Avenue",
      city: "Baku",
      countryCode: "AZ",
      timeZone: "Asia/Baku",
      status: "ACTIVE",
    },
  );
  const space = await createSpace(
    database,
    { userId: user.id, organizationSlug: organization.slug, venueSlug: venue.slug },
    {
      name: "Main Auditorium",
      description: "Primary seating space",
      type: "THEATRE",
      status: "ACTIVE",
    },
  );

  return { user, organization, venue, space };
}

function spaceScope(fixture: Awaited<ReturnType<typeof createOperatorFixture>>) {
  return {
    userId: fixture.user.id,
    organizationSlug: fixture.organization.slug,
    venueSlug: fixture.venue.slug,
    spaceSlug: fixture.space.slug,
  };
}

async function createCompleteDraft(fixture: Awaited<ReturnType<typeof createOperatorFixture>>) {
  const scope = spaceScope(fixture);
  const seatMap = await createDraftSeatMap(database, scope, { name: "Main layout" });
  const section = await createSection(database, { ...scope, seatMapId: seatMap.id }, {
    name: "Orchestra",
    code: "ORCH",
  });
  await bulkGenerateRows(
    database,
    { ...scope, seatMapId: seatMap.id, sectionId: section.id },
    {
      startRowLabel: "A",
      rowCount: 2,
      seatsPerRow: 3,
      startSeatNumber: 1,
      horizontalSpacing: 40,
      verticalSpacing: 40,
    },
  );
  return { scope, seatMap, section };
}

beforeEach(async () => {
  database = createDatabaseClient();
  await resetIntegrationDatabase(database);
});

afterEach(async () => {
  await database.$disconnect();
});

describe("venue-operator tenant boundaries", () => {
  it("creates tenant-owned venues and prevents wrong-kind, MEMBER, and cross-tenant writes", async () => {
    const fixture = await createOperatorFixture("North");
    expect(fixture.organization.kind).toBe("VENUE_OPERATOR");
    expect(fixture.organization.memberships[0]).toMatchObject({
      userId: fixture.user.id,
      role: "OWNER",
    });

    const member = await database.user.create({
      data: { name: "Read Only", email: "member@example.com" },
    });
    await database.membership.create({
      data: { userId: member.id, organizationId: fixture.organization.id, role: "MEMBER" },
    });
    await expect(
      createVenue(database, { userId: member.id, organizationSlug: fixture.organization.slug }, {
        name: "Forbidden Venue",
        addressLine1: "2 Other Street",
        city: "Baku",
        countryCode: "AZ",
        timeZone: "Asia/Baku",
        status: "ACTIVE",
      }),
    ).rejects.toBeInstanceOf(VenueManagementAuthorizationError);

    const organizerOwner = await database.user.create({
      data: { name: "Organizer", email: "organizer-phase2@example.com" },
    });
    const organizer = await createOrganizerOrganization(database, {
      userId: organizerOwner.id,
      name: "Organizer Only",
    });
    await expect(
      createVenue(database, { userId: organizerOwner.id, organizationSlug: organizer.slug }, {
        name: "Wrong Kind Venue",
        addressLine1: "3 Other Street",
        city: "Baku",
        countryCode: "AZ",
        timeZone: "Asia/Baku",
        status: "ACTIVE",
      }),
    ).rejects.toBeInstanceOf(VenueManagementAuthorizationError);

    const other = await createOperatorFixture("South");
    await expect(
      createSpace(database, {
        userId: fixture.user.id,
        organizationSlug: fixture.organization.slug,
        venueSlug: other.venue.slug,
      }, {
        name: "Cross Tenant Space",
        type: "GENERAL",
        status: "ACTIVE",
      }),
    ).rejects.toBeInstanceOf(VenueManagementAuthorizationError);

    const administrator = await database.user.create({
      data: { name: "Venue Admin", email: "venue-admin@example.com" },
    });
    await database.membership.create({
      data: {
        userId: administrator.id,
        organizationId: fixture.organization.id,
        role: "ADMIN",
      },
    });
    await expect(
      createVenue(
        database,
        {
          userId: administrator.id,
          organizationSlug: fixture.organization.slug,
        },
        {
          name: "Admin Managed Venue",
          addressLine1: "4 Promenade Avenue",
          city: "Baku",
          countryCode: "AZ",
          timeZone: "Asia/Baku",
          status: "ACTIVE",
        },
      ),
    ).resolves.toMatchObject({ name: "Admin Managed Venue" });
  });

  it("keeps venue and space slugs unique only inside their natural tenant scope", async () => {
    const north = await createOperatorFixture("Scoped North");
    const south = await createOperatorFixture("Scoped South");
    const sharedVenueInput = {
      name: "Shared Name",
      slug: "shared-venue",
      addressLine1: "10 Shared Street",
      city: "Baku",
      countryCode: "AZ",
      timeZone: "Asia/Baku",
      status: "ACTIVE" as const,
    };

    await expect(
      createVenue(
        database,
        {
          userId: north.user.id,
          organizationSlug: north.organization.slug,
        },
        sharedVenueInput,
      ),
    ).resolves.toMatchObject({ slug: "shared-venue" });
    await expect(
      createVenue(
        database,
        {
          userId: south.user.id,
          organizationSlug: south.organization.slug,
        },
        sharedVenueInput,
      ),
    ).resolves.toMatchObject({ slug: "shared-venue" });
    await expect(
      createVenue(
        database,
        {
          userId: north.user.id,
          organizationSlug: north.organization.slug,
        },
        { ...sharedVenueInput, name: "Duplicate in North" },
      ),
    ).rejects.toBeInstanceOf(VenueManagementConflictError);

    await expect(
      createSpace(database, {
        userId: north.user.id,
        organizationSlug: north.organization.slug,
        venueSlug: north.venue.slug,
      }, {
        name: "Duplicate Main Auditorium",
        slug: north.space.slug,
        type: "GENERAL",
        status: "ACTIVE",
      }),
    ).rejects.toBeInstanceOf(VenueManagementConflictError);
  });

  it("rejects guessed nested IDs for reads and writes across tenants", async () => {
    const north = await createOperatorFixture("Nested North");
    const south = await createOperatorFixture("Nested South");
    const { seatMap, section } = await createCompleteDraft(north);
    const row = await database.seatRow.findFirstOrThrow({
      where: { sectionId: section.id },
    });
    const seat = await database.seat.findFirstOrThrow({
      where: { rowId: row.id },
    });
    const guessedScope = {
      userId: south.user.id,
      organizationSlug: south.organization.slug,
      venueSlug: north.venue.slug,
      spaceSlug: north.space.slug,
      seatMapId: seatMap.id,
    };

    await expect(
      findAuthorizedSeatMap(database, guessedScope),
    ).resolves.toBeNull();
    await expect(
      findAuthorizedSection(database, {
        ...guessedScope,
        sectionId: section.id,
      }),
    ).resolves.toBeNull();
    await expect(
      findAuthorizedRow(database, {
        ...guessedScope,
        sectionId: section.id,
        rowId: row.id,
      }),
    ).resolves.toBeNull();
    await expect(
      findAuthorizedSeat(database, {
        ...guessedScope,
        sectionId: section.id,
        rowId: row.id,
        seatId: seat.id,
      }),
    ).resolves.toBeNull();
    await expect(
      updateSeat(database, {
        ...guessedScope,
        sectionId: section.id,
        rowId: row.id,
        seatId: seat.id,
      }, {
        label: seat.label,
        x: seat.x,
        y: seat.y,
        type: "PREMIUM",
        state: "BLOCKED",
      }),
    ).rejects.toBeInstanceOf(VenueManagementAuthorizationError);

    const readOnlyMember = await database.user.create({
      data: { name: "Draft Reader", email: "draft-reader@example.com" },
    });
    await database.membership.create({
      data: {
        userId: readOnlyMember.id,
        organizationId: north.organization.id,
        role: "MEMBER",
      },
    });
    await expect(
      findAuthorizedSeatMap(database, {
        userId: readOnlyMember.id,
        organizationSlug: north.organization.slug,
        venueSlug: north.venue.slug,
        spaceSlug: north.space.slug,
        seatMapId: seatMap.id,
      }),
    ).resolves.toMatchObject({ seatMap: { id: seatMap.id } });
  });

  it("archives and restores a venue without deleting nested data", async () => {
    const fixture = await createOperatorFixture("Lifecycle");
    const scope = {
      userId: fixture.user.id,
      organizationSlug: fixture.organization.slug,
      venueSlug: fixture.venue.slug,
    };

    await expect(archiveVenue(database, scope)).resolves.toMatchObject({ status: "ARCHIVED" });
    expect(await database.space.count({ where: { venueId: fixture.venue.id } })).toBe(1);
    await expect(restoreVenue(database, scope)).resolves.toMatchObject({
      status: "ACTIVE",
      archivedAt: null,
    });
  });

  it("makes nested spaces and draft maps read-only while a parent is archived", async () => {
    const fixture = await createOperatorFixture("Parent Archive");
    const draft = await createDraftSeatMap(database, spaceScope(fixture), {
      name: "Paused layout",
    });
    await archiveVenue(database, {
      userId: fixture.user.id,
      organizationSlug: fixture.organization.slug,
      venueSlug: fixture.venue.slug,
    });

    await expect(
      updateSpace(database, spaceScope(fixture), {
        name: fixture.space.name,
        type: fixture.space.type,
        status: "ACTIVE",
      }),
    ).rejects.toBeInstanceOf(VenueManagementLifecycleError);
    await expect(
      createSection(database, {
        ...spaceScope(fixture),
        seatMapId: draft.id,
      }, {
        name: "Main",
        code: "MAIN",
      }),
    ).rejects.toBeInstanceOf(VenueManagementLifecycleError);
    await expect(
      updateDraftSeatMap(database, {
        ...spaceScope(fixture),
        seatMapId: draft.id,
      }, { name: "Direct URL edit" }),
    ).rejects.toBeInstanceOf(VenueManagementLifecycleError);
  });

  it("enforces venue-operator ownership at the database boundary", async () => {
    const owner = await database.user.create({
      data: { name: "Organizer Owner", email: "db-kind-owner@example.com" },
    });
    const organizer = await createOrganizerOrganization(database, {
      userId: owner.id,
      name: "Database Kind Organizer",
    });

    await expect(
      database.venue.create({
        data: {
          organizationId: organizer.id,
          name: "Invalid Organizer Venue",
          slug: "invalid-organizer-venue",
          addressLine1: "1 Invalid Street",
          city: "Baku",
          countryCode: "AZ",
          timeZone: "Asia/Baku",
          status: "ACTIVE",
        },
      }),
    ).rejects.toThrow(/venue-operator organization/i);
  });
});

describe("seat-map limits and atomic generation", () => {
  it("rolls back conflicting generation and enforces the map-wide seat cap", async () => {
    const fixture = await createOperatorFixture("Capacity");
    const scope = spaceScope(fixture);
    const seatMap = await createDraftSeatMap(database, scope, { name: "Capacity layout" });
    const section = await createSection(database, { ...scope, seatMapId: seatMap.id }, {
      name: "Main",
      code: "MAIN",
    });
    const generationScope = { ...scope, seatMapId: seatMap.id, sectionId: section.id };
    const largeBatch = {
      startRowLabel: "A",
      rowCount: 30,
      seatsPerRow: 80,
      startSeatNumber: 1,
      horizontalSpacing: 10,
      verticalSpacing: 10,
    } as const;

    await bulkGenerateRows(database, generationScope, largeBatch);
    expect(await database.seat.count()).toBe(2_400);

    await expect(
      bulkGenerateRows(database, generationScope, largeBatch),
    ).rejects.toBeInstanceOf(VenueManagementConflictError);
    expect(await database.seat.count()).toBe(2_400);

    await expect(
      bulkGenerateRows(database, generationScope, {
        ...largeBatch,
        startRowLabel: "AE",
        rowCount: 8,
      }),
    ).rejects.toBeInstanceOf(SeatMapValidationError);
    expect(await database.seat.count()).toBe(2_400);
  }, 15_000);
});

describe("seat-map version and parent integrity", () => {
  it("assigns versions on the server and enforces scoped uniqueness", async () => {
    const fixture = await createOperatorFixture("Versions");
    const scope = spaceScope(fixture);
    const first = await createDraftSeatMap(
      database,
      scope,
      { name: "First", version: 99 } as { name: string },
    );
    const second = await createDraftSeatMap(database, scope, { name: "Second" });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    await expect(
      database.seatMap.create({
        data: {
          spaceId: fixture.space.id,
          name: "Duplicate version",
          version: 2,
        },
      }),
    ).rejects.toThrow();
  });

  it("does not accept client parent changes and rejects cross-space clone provenance", async () => {
    const fixture = await createOperatorFixture("Parents");
    const scope = spaceScope(fixture);
    const seatMap = await createDraftSeatMap(database, scope, { name: "Parent map" });
    const section = await createSection(database, {
      ...scope,
      seatMapId: seatMap.id,
    }, { name: "Main", code: "MAIN" });
    const row = await createRow(database, {
      ...scope,
      seatMapId: seatMap.id,
      sectionId: section.id,
    }, { label: "A" });
    const seat = await createSeat(database, {
      ...scope,
      seatMapId: seatMap.id,
      sectionId: section.id,
      rowId: row.id,
    }, {
      label: "1",
      x: 0,
      y: 0,
      type: "STANDARD",
      state: "ACTIVE",
    });

    await updateSeat(database, {
      ...scope,
      seatMapId: seatMap.id,
      sectionId: section.id,
      rowId: row.id,
      seatId: seat.id,
    }, {
      label: "1",
      x: 0,
      y: 0,
      type: "PREMIUM",
      state: "ACTIVE",
      rowId: "attacker-controlled-parent",
    } as Parameters<typeof updateSeat>[2]);
    expect(
      await database.seat.findUniqueOrThrow({ where: { id: seat.id } }),
    ).toMatchObject({ rowId: row.id, type: "PREMIUM" });

    const secondSpace = await createSpace(database, {
      userId: fixture.user.id,
      organizationSlug: fixture.organization.slug,
      venueSlug: fixture.venue.slug,
    }, {
      name: "Second Auditorium",
      type: "THEATRE",
      status: "ACTIVE",
    });
    const secondMap = await createDraftSeatMap(database, {
      userId: fixture.user.id,
      organizationSlug: fixture.organization.slug,
      venueSlug: fixture.venue.slug,
      spaceSlug: secondSpace.slug,
    }, { name: "Second map" });

    await expect(
      database.seatMap.update({
        where: { id: secondMap.id },
        data: { sourceSeatMapId: seatMap.id },
      }),
    ).rejects.toThrow(/source from the same space/i);
    await expect(
      database.venue.delete({ where: { id: fixture.venue.id } }),
    ).rejects.toThrow();
  });
});

describe("published seat-map lifecycle", () => {
  it("rejects direct re-parenting out of an immutable published graph", async () => {
    const fixture = await createOperatorFixture("Reparent");
    const { scope, seatMap } = await createCompleteDraft(fixture);
    await publishSeatMap(database, { ...scope, seatMapId: seatMap.id });

    const sourceSection = await database.seatSection.findFirstOrThrow({
      where: { seatMapId: seatMap.id },
      include: { rows: { include: { seats: true } } },
    });
    const sourceRow = sourceSection.rows[0];
    const sourceSeat = sourceRow?.seats[0];
    if (!sourceRow || !sourceSeat) {
      throw new Error("Expected the published fixture to contain a row and seat.");
    }

    const targetMap = await createDraftSeatMap(database, scope, {
      name: "Re-parenting target",
    });
    const targetSection = await createSection(
      database,
      { ...scope, seatMapId: targetMap.id },
      { name: "Target", code: "TARGET" },
    );
    const targetRow = await createRow(
      database,
      {
        ...scope,
        seatMapId: targetMap.id,
        sectionId: targetSection.id,
      },
      { label: "Z" },
    );

    await expect(
      database.seatSection.update({
        where: { id: sourceSection.id },
        data: { seatMapId: targetMap.id },
      }),
    ).rejects.toThrow(/draft maps/i);
    await expect(
      database.seatRow.update({
        where: { id: sourceRow.id },
        data: { sectionId: targetSection.id },
      }),
    ).rejects.toThrow(/draft maps/i);
    await expect(
      database.seat.update({
        where: { id: sourceSeat.id },
        data: { rowId: targetRow.id },
      }),
    ).rejects.toThrow(/draft maps/i);

    await expect(
      database.seat.findUniqueOrThrow({ where: { id: sourceSeat.id } }),
    ).resolves.toMatchObject({ rowId: sourceRow.id });
  });

  it("publishes idempotently, protects the snapshot, deep-clones, and archives the prior version", async () => {
    const fixture = await createOperatorFixture("Publish");
    const { scope, seatMap } = await createCompleteDraft(fixture);
    const published = await publishSeatMap(database, { ...scope, seatMapId: seatMap.id });

    expect(published.status).toBe("PUBLISHED");
    await expect(
      publishSeatMap(database, { ...scope, seatMapId: seatMap.id }),
    ).resolves.toMatchObject({ id: seatMap.id, status: "PUBLISHED" });

    const sourceSeat = await database.seat.findFirstOrThrow({
      where: { row: { section: { seatMapId: seatMap.id } } },
      orderBy: { displayOrder: "asc" },
    });
    await expect(
      database.seat.update({ where: { id: sourceSeat.id }, data: { state: "BLOCKED" } }),
    ).rejects.toThrow();
    await expect(
      database.seatMap.update({
        where: { id: seatMap.id },
        data: { name: "Mutated published name" },
      }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      database.seatMap.delete({ where: { id: seatMap.id } }),
    ).rejects.toThrow(/cannot be deleted/i);

    const clone = await clonePublishedSeatMap(database, { ...scope, seatMapId: seatMap.id });
    expect(clone).toMatchObject({ version: 2, status: "DRAFT", sourceSeatMapId: seatMap.id });
    expect(clone.sections).toHaveLength(published.sections.length);
    expect(clone.sections[0].rows[0].seats).toHaveLength(published.sections[0].rows[0].seats.length);

    const cloneSeat = clone.sections[0].rows[0].seats[0];
    await updateSeat(database, {
      ...scope,
      seatMapId: clone.id,
      sectionId: clone.sections[0].id,
      rowId: clone.sections[0].rows[0].id,
      seatId: cloneSeat.id,
    }, {
      label: cloneSeat.label,
      x: cloneSeat.x,
      y: cloneSeat.y,
      type: "PREMIUM",
      state: "BLOCKED",
    });
    expect((await database.seat.findUniqueOrThrow({ where: { id: sourceSeat.id } })).state).toBe("ACTIVE");

    await publishSeatMap(database, { ...scope, seatMapId: clone.id });
    const versions = await database.seatMap.findMany({
      where: { spaceId: fixture.space.id },
      orderBy: { version: "asc" },
    });
    expect(versions.map(({ version, status }) => ({ version, status }))).toEqual([
      { version: 1, status: "ARCHIVED" },
      { version: 2, status: "PUBLISHED" },
    ]);

    await expect(database.seatMap.create({
      data: {
        spaceId: fixture.space.id,
        name: "Impossible second current map",
        version: 3,
        status: "PUBLISHED",
        publishedAt: new Date(),
      },
    })).rejects.toThrow();
  });

  it("does not archive the current version when a new draft fails validation", async () => {
    const fixture = await createOperatorFixture("Rollback");
    const { scope, seatMap } = await createCompleteDraft(fixture);
    await publishSeatMap(database, { ...scope, seatMapId: seatMap.id });
    const emptyDraft = await createDraftSeatMap(database, scope, { name: "Incomplete layout" });

    await expect(
      publishSeatMap(database, { ...scope, seatMapId: emptyDraft.id }),
    ).rejects.toBeInstanceOf(SeatMapValidationError);
    await expect(database.seatMap.findUniqueOrThrow({ where: { id: seatMap.id } })).resolves.toMatchObject({
      status: "PUBLISHED",
    });
    await expect(database.seatMap.findUniqueOrThrow({ where: { id: emptyDraft.id } })).resolves.toMatchObject({
      status: "DRAFT",
    });
  });
});
