import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client";
import { toVenueLocalInputValue } from "../../src/features/events/date-time";
import { DEFAULT_HOLD_CONFIGURATION } from "../../src/features/holds/config";
import { createDatabaseClient } from "../../src/lib/database";
import {
  cancelEventSession,
  createEventSession,
  publishEventSession,
} from "../../src/server/events/event-session-service";
import {
  cancelEvent,
  createEvent,
  publishEvent,
} from "../../src/server/events/event-service";
import {
  assignSessionSectionPricing,
  createSessionPriceTier,
} from "../../src/server/events/pricing-service";
import {
  HoldAuthorizationError,
  HoldConflictError,
  HoldEligibilityError,
  HoldValidationError,
} from "../../src/server/holds/errors";
import {
  sweepExpiredHolds,
} from "../../src/server/holds/expiry-service";
import {
  acquireSeatHold,
  releaseSeatHold,
} from "../../src/server/holds/hold-service";
import {
  backfillPublishedSessionInventory,
} from "../../src/server/holds/inventory-service";
import {
  dispatchInventoryEventBatch,
  type OutboxDispatcherConfiguration,
} from "../../src/server/inventory-events/dispatcher-service";
import type { InventoryEventTransport } from "../../src/server/inventory-events/redis-transport";
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
import { resetIntegrationDatabase } from "./reset-database";

let database: PrismaClient;

const PRICE_MINOR = 2_500;
const CURRENCY = "AZN" as const;

async function createUser(prefix: string) {
  return database.user.create({
    data: {
      name: `${prefix} User`,
      email: `${prefix.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Math.random()
        .toString(36)
        .slice(2, 8)}@example.com`,
    },
  });
}

// Session times relative to real "now" so publication yields an ON_SALE,
// currently-sellable session. dayOffset separates additional sessions in the
// same space without violating the overlap exclusion constraint.
function sellableSessionTimes(timeZone: string, dayOffset = 0) {
  const reference = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const start = new Date(reference + (30 + dayOffset) * day);
  return {
    startLocal: toVenueLocalInputValue(start, timeZone),
    endLocal: toVenueLocalInputValue(new Date(start.getTime() + 2 * 60 * 60 * 1000), timeZone),
    salesStartLocal: toVenueLocalInputValue(new Date(reference - 60 * 60 * 1000), timeZone),
    salesEndLocal: toVenueLocalInputValue(new Date(reference + 29 * day), timeZone),
  };
}

interface FixtureOptions {
  rows?: number;
  seatsPerRow?: number;
  blockedSeatCount?: number;
}

async function createSellableFixture(prefix: string, options: FixtureOptions = {}) {
  const rows = options.rows ?? 3;
  const seatsPerRow = options.seatsPerRow ?? 3;

  const operatorOwner = await createUser(`${prefix} Operator`);
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
    { userId: operatorOwner.id, organizationSlug: operator.slug, venueSlug: venue.slug },
    { name: "Main Auditorium", type: "THEATRE", status: "ACTIVE" },
  );
  const mapScope = {
    userId: operatorOwner.id,
    organizationSlug: operator.slug,
    venueSlug: venue.slug,
    spaceSlug: space.slug,
  };
  const seatMap = await createDraftSeatMap(database, mapScope, { name: "Session layout" });
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
      rowCount: rows,
      seatsPerRow,
      startSeatNumber: 1,
      horizontalSpacing: 40,
      verticalSpacing: 40,
    },
  );

  let blockedSeatIds: string[] = [];
  if (options.blockedSeatCount && options.blockedSeatCount > 0) {
    const toBlock = await database.seat.findMany({
      where: { row: { sectionId: section.id } },
      orderBy: [{ row: { displayOrder: "asc" } }, { displayOrder: "asc" }],
      take: options.blockedSeatCount,
      select: { id: true },
    });
    blockedSeatIds = toBlock.map((seat) => seat.id);
    await database.seat.updateMany({
      where: { id: { in: blockedSeatIds } },
      data: { state: "BLOCKED" },
    });
  }

  await publishSeatMap(database, { ...mapScope, seatMapId: seatMap.id });

  const organizerOwner = await createUser(`${prefix} Organizer`);
  const organizer = await createOrganizerOrganization(database, {
    userId: organizerOwner.id,
    name: `${prefix} Live`,
  });
  const grant = await grantVenueAccess(
    database,
    { userId: operatorOwner.id, organizationSlug: operator.slug, venueSlug: venue.slug },
    organizer.slug,
  );
  const event = await createEvent(
    database,
    { userId: organizerOwner.id, organizationSlug: organizer.slug },
    {
      title: `${prefix} Event`,
      shortDescription: "A sellable event configured for Phase 4A integration testing.",
      description:
        "A complete persistent event description used to verify inventory materialization and atomic seat holds.",
      category: "CONCERT",
      imagePath: "/events/aurora-room.svg",
    },
  );

  const organizerScope = {
    userId: organizerOwner.id,
    organizationSlug: organizer.slug,
    eventSlug: event.slug,
  };

  const session = await addSellableSession(organizerScope, {
    venueId: venue.id,
    spaceId: space.id,
    seatMapId: seatMap.id,
    sectionId: section.id,
    timeZone: venue.timeZone,
  });
  await publishEvent(database, organizerScope);

  const inventory = await database.sessionSeatInventory.findMany({
    where: { sessionId: session.id },
    orderBy: { seatId: "asc" },
    select: { id: true, seatId: true, priceMinor: true, currency: true },
  });

  return {
    operatorOwner,
    operator,
    venue,
    space,
    seatMap,
    section,
    organizerOwner,
    organizer,
    organizerScope,
    grant,
    event,
    session,
    inventory,
    seatIds: inventory.map((row) => row.seatId),
    blockedSeatIds,
  };
}

async function addSellableSession(
  organizerScope: { userId: string; organizationSlug: string; eventSlug: string },
  input: {
    venueId: string;
    spaceId: string;
    seatMapId: string;
    sectionId: string;
    timeZone: string;
    dayOffset?: number;
  },
) {
  const session = await createEventSession(database, organizerScope, {
    venueId: input.venueId,
    spaceId: input.spaceId,
    seatMapId: input.seatMapId,
    ...sellableSessionTimes(input.timeZone, input.dayOffset ?? 0),
  });
  const scope = { ...organizerScope, sessionId: session.id };
  const tier = await createSessionPriceTier(database, scope, {
    name: "Standard",
    code: "STD",
    priceMinor: PRICE_MINOR,
    currency: CURRENCY,
  });
  await assignSessionSectionPricing(database, scope, {
    assignments: [{ sectionId: input.sectionId, priceTierId: tier.id }],
  });
  await publishEventSession(database, scope);
  return session;
}

// Simulate a session published before Phase 4A (or a corrupt partial state) by
// deleting inventory rows. Inventory is deliberately undeletable in normal
// operation, so this test-only helper disables that protection just for the
// deletion and restores it immediately.
async function deleteInventoryForTest(whereClause: string, param: string) {
  await database.$executeRawUnsafe(
    `ALTER TABLE "SessionSeatInventory" DISABLE TRIGGER "SessionSeatInventory_protect_snapshot_trigger"`,
  );
  try {
    await database.$executeRawUnsafe(
      `DELETE FROM "SessionSeatInventory" WHERE ${whereClause}`,
      param,
    );
  } finally {
    await database.$executeRawUnsafe(
      `ALTER TABLE "SessionSeatInventory" ENABLE TRIGGER "SessionSeatInventory_protect_snapshot_trigger"`,
    );
  }
}

async function inventoryStates(sessionId: string) {
  const rows = await database.sessionSeatInventory.findMany({
    where: { sessionId },
    select: { state: true },
  });
  return {
    total: rows.length,
    available: rows.filter((row) => row.state === "AVAILABLE").length,
    held: rows.filter((row) => row.state === "HELD").length,
  };
}

function key(label: string) {
  return `idem-${label}-${Math.random().toString(36).slice(2, 12)}`;
}

beforeEach(async () => {
  database = createDatabaseClient();
  await resetIntegrationDatabase(database);
});

afterEach(async () => {
  await database.$disconnect();
});

describe("Phase 4A inventory materialization", () => {
  it("materializes one inventory row per active seat with the tier price snapshot", async () => {
    const fixture = await createSellableFixture("Materialize");
    expect(fixture.inventory).toHaveLength(9);
    for (const row of fixture.inventory) {
      expect(row.priceMinor).toBe(PRICE_MINOR);
      expect(row.currency).toBe(CURRENCY);
    }
    const states = await inventoryStates(fixture.session.id);
    expect(states).toEqual({ total: 9, available: 9, held: 0 });
  });

  it("is idempotent under repeated publication and never duplicates rows", async () => {
    const fixture = await createSellableFixture("Idempotent Materialize");
    // Re-publishing an already-published session is a no-op and must not add rows.
    await publishEventSession(database, {
      ...fixture.organizerScope,
      sessionId: fixture.session.id,
    });
    const count = await database.sessionSeatInventory.count({
      where: { sessionId: fixture.session.id },
    });
    expect(count).toBe(9);
  });

  it("excludes blocked physical seats from inventory", async () => {
    const fixture = await createSellableFixture("Blocked Seats", {
      blockedSeatCount: 2,
    });
    expect(fixture.inventory).toHaveLength(7);
    const inventorySeatIds = new Set(fixture.inventory.map((row) => row.seatId));
    for (const blockedId of fixture.blockedSeatIds) {
      expect(inventorySeatIds.has(blockedId)).toBe(false);
    }
  });

  it("backfills eligible published sessions lacking inventory and then skips them", async () => {
    const fixture = await createSellableFixture("Backfill");
    // Simulate a session published before Phase 4A by removing its inventory.
    await deleteInventoryForTest(`"sessionId" = $1`, fixture.session.id);
    await expect(
      database.sessionSeatInventory.count({ where: { sessionId: fixture.session.id } }),
    ).resolves.toBe(0);

    const first = await backfillPublishedSessionInventory(database);
    expect(first.materialized).toBe(1);
    expect(first.scanned).toBeGreaterThanOrEqual(1);
    await expect(
      database.sessionSeatInventory.count({ where: { sessionId: fixture.session.id } }),
    ).resolves.toBe(9);

    const second = await backfillPublishedSessionInventory(database);
    expect(second.materialized).toBe(0);
    expect(second.skippedComplete).toBeGreaterThanOrEqual(1);
  });

  it("refuses partial existing inventory during backfill", async () => {
    const fixture = await createSellableFixture("Partial Backfill");
    // Remove a single row to create an inconsistent partial state.
    await deleteInventoryForTest(`"id" = $1`, fixture.inventory[0]!.id);
    const summary = await backfillPublishedSessionInventory(database);
    expect(summary.refusedInconsistent).toBe(1);
    expect(summary.materialized).toBe(0);
    await expect(
      database.sessionSeatInventory.count({ where: { sessionId: fixture.session.id } }),
    ).resolves.toBe(8);
  });
});

describe("Phase 4A hold acquisition", () => {
  it("acquires a single seat and marks it held with a server-owned snapshot", async () => {
    const fixture = await createSellableFixture("Single Hold");
    const customer = await createUser("Single Customer");
    const { hold } = await acquireSeatHold(
      database,
      { userId: customer.id },
      { sessionId: fixture.session.id, seatIds: [fixture.seatIds[0]], idempotencyKey: key("single") },
    );
    expect(hold.status).toBe("ACTIVE");
    expect(hold.seatCount).toBe(1);
    expect(hold.totalMinor).toBe(PRICE_MINOR);
    expect(hold.currency).toBe(CURRENCY);
    expect(hold.publicToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const states = await inventoryStates(fixture.session.id);
    expect(states.held).toBe(1);
  });

  it("acquires multiple seats atomically and totals with integer arithmetic", async () => {
    const fixture = await createSellableFixture("Multi Hold");
    const customer = await createUser("Multi Customer");
    const { hold } = await acquireSeatHold(
      database,
      { userId: customer.id },
      {
        sessionId: fixture.session.id,
        seatIds: fixture.seatIds.slice(0, 4),
        idempotencyKey: key("multi"),
      },
    );
    expect(hold.seatCount).toBe(4);
    expect(hold.totalMinor).toBe(PRICE_MINOR * 4);
    const states = await inventoryStates(fixture.session.id);
    expect(states.held).toBe(4);
  });

  it("rolls back the whole request if any selected seat is unavailable", async () => {
    const fixture = await createSellableFixture("All Or Nothing");
    const first = await createUser("AoN First");
    const second = await createUser("AoN Second");
    // First customer holds one seat that the second will also request.
    await acquireSeatHold(
      database,
      { userId: first.id },
      { sessionId: fixture.session.id, seatIds: [fixture.seatIds[2]], idempotencyKey: key("aon-1") },
    );
    await expect(
      acquireSeatHold(
        database,
        { userId: second.id },
        {
          sessionId: fixture.session.id,
          seatIds: [fixture.seatIds[0], fixture.seatIds[1], fixture.seatIds[2], fixture.seatIds[3], fixture.seatIds[4]],
          idempotencyKey: key("aon-2"),
        },
      ),
    ).rejects.toBeInstanceOf(HoldConflictError);
    // None of the second customer's other four seats may remain held.
    const states = await inventoryStates(fixture.session.id);
    expect(states.held).toBe(1);
  });

  it("rejects duplicate seat ids and over-limit selections", async () => {
    const fixture = await createSellableFixture("Validation");
    const customer = await createUser("Validation Customer");
    await expect(
      acquireSeatHold(
        database,
        { userId: customer.id },
        {
          sessionId: fixture.session.id,
          seatIds: [fixture.seatIds[0], fixture.seatIds[0]],
          idempotencyKey: key("dup"),
        },
      ),
    ).rejects.toBeInstanceOf(HoldValidationError);

    const tooMany = Array.from(
      { length: DEFAULT_HOLD_CONFIGURATION.maxSeatsPerHold + 1 },
      (_, index) => `seat-${index}`,
    );
    await expect(
      acquireSeatHold(
        database,
        { userId: customer.id },
        { sessionId: fixture.session.id, seatIds: tooMany, idempotencyKey: key("many") },
      ),
    ).rejects.toBeInstanceOf(HoldValidationError);
  });

  it("rejects seats that belong to another session (no cross-session mixing)", async () => {
    const fixture = await createSellableFixture("Cross Session");
    const other = await createSellableFixture("Cross Session Other");
    const customer = await createUser("Cross Session Customer");
    await expect(
      acquireSeatHold(
        database,
        { userId: customer.id },
        {
          sessionId: fixture.session.id,
          seatIds: [fixture.seatIds[0], other.seatIds[0]],
          idempotencyKey: key("cross"),
        },
      ),
    ).rejects.toBeInstanceOf(HoldValidationError);
    expect((await inventoryStates(fixture.session.id)).held).toBe(0);
  });

  it("rejects holding a blocked physical seat by id", async () => {
    const fixture = await createSellableFixture("Blocked Hold", { blockedSeatCount: 1 });
    const customer = await createUser("Blocked Customer");
    await expect(
      acquireSeatHold(
        database,
        { userId: customer.id },
        {
          sessionId: fixture.session.id,
          seatIds: [fixture.blockedSeatIds[0]],
          idempotencyKey: key("blocked"),
        },
      ),
    ).rejects.toBeInstanceOf(HoldValidationError);
  });

  it("rejects anonymous holds", async () => {
    const fixture = await createSellableFixture("Anonymous");
    await expect(
      acquireSeatHold(
        database,
        { userId: "" },
        { sessionId: fixture.session.id, seatIds: [fixture.seatIds[0]], idempotencyKey: key("anon") },
      ),
    ).rejects.toThrow();
  });
});

describe("Phase 4A idempotency", () => {
  it("replays the identical request without creating a duplicate hold", async () => {
    const fixture = await createSellableFixture("Idempotent Retry");
    const customer = await createUser("Idempotent Customer");
    const idempotencyKey = key("retry");
    const request = {
      sessionId: fixture.session.id,
      seatIds: [fixture.seatIds[0], fixture.seatIds[1]],
      idempotencyKey,
    };
    const first = await acquireSeatHold(database, { userId: customer.id }, request);
    const second = await acquireSeatHold(database, { userId: customer.id }, request);
    expect(second.replayed).toBe(true);
    expect(second.hold.publicToken).toBe(first.hold.publicToken);
    await expect(
      database.seatHold.count({ where: { sessionId: fixture.session.id, userId: customer.id } }),
    ).resolves.toBe(1);
  });

  it("rejects reuse of an idempotency key with a different payload", async () => {
    const fixture = await createSellableFixture("Idempotent Mismatch");
    const customer = await createUser("Mismatch Customer");
    const idempotencyKey = key("mismatch");
    await acquireSeatHold(database, { userId: customer.id }, {
      sessionId: fixture.session.id,
      seatIds: [fixture.seatIds[0]],
      idempotencyKey,
    });
    await expect(
      acquireSeatHold(database, { userId: customer.id }, {
        sessionId: fixture.session.id,
        seatIds: [fixture.seatIds[1]],
        idempotencyKey,
      }),
    ).rejects.toBeInstanceOf(HoldConflictError);
  });
});

describe("Phase 4A concurrency (truly concurrent database operations)", () => {
  it("lets exactly one of two concurrent claimants hold the same single seat", async () => {
    const fixture = await createSellableFixture("Concurrent Single");
    const first = await createUser("Concurrent A");
    const second = await createUser("Concurrent B");
    const seatIds = [fixture.seatIds[0]];

    const results = await Promise.allSettled([
      acquireSeatHold(database, { userId: first.id }, {
        sessionId: fixture.session.id,
        seatIds,
        idempotencyKey: key("c1"),
      }),
      acquireSeatHold(database, { userId: second.id }, {
        sessionId: fixture.session.id,
        seatIds,
        idempotencyKey: key("c2"),
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((await inventoryStates(fixture.session.id)).held).toBe(1);
  });

  it("prevents both of two overlapping multi-seat requests from taking the shared seat", async () => {
    const fixture = await createSellableFixture("Concurrent Overlap");
    const first = await createUser("Overlap A");
    const second = await createUser("Overlap B");

    const results = await Promise.allSettled([
      acquireSeatHold(database, { userId: first.id }, {
        sessionId: fixture.session.id,
        seatIds: [fixture.seatIds[0], fixture.seatIds[1], fixture.seatIds[2]],
        idempotencyKey: key("o1"),
      }),
      acquireSeatHold(database, { userId: second.id }, {
        sessionId: fixture.session.id,
        seatIds: [fixture.seatIds[2], fixture.seatIds[3], fixture.seatIds[4]],
        idempotencyKey: key("o2"),
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    // The winner holds exactly 3 seats; the shared seat is never double-held.
    expect((await inventoryStates(fixture.session.id)).held).toBe(3);
  });

  it("lets two concurrent non-overlapping requests both succeed", async () => {
    const fixture = await createSellableFixture("Concurrent Disjoint");
    const first = await createUser("Disjoint A");
    const second = await createUser("Disjoint B");

    const results = await Promise.allSettled([
      acquireSeatHold(database, { userId: first.id }, {
        sessionId: fixture.session.id,
        seatIds: [fixture.seatIds[0], fixture.seatIds[1]],
        idempotencyKey: key("d1"),
      }),
      acquireSeatHold(database, { userId: second.id }, {
        sessionId: fixture.session.id,
        seatIds: [fixture.seatIds[6], fixture.seatIds[7]],
        idempotencyKey: key("d2"),
      }),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect((await inventoryStates(fixture.session.id)).held).toBe(4);
  });
});

describe("Phase 4A release and expiry", () => {
  it("releases the owner's hold and returns seats to AVAILABLE, idempotently", async () => {
    const fixture = await createSellableFixture("Release");
    const customer = await createUser("Release Customer");
    const { hold } = await acquireSeatHold(database, { userId: customer.id }, {
      sessionId: fixture.session.id,
      seatIds: [fixture.seatIds[0], fixture.seatIds[1]],
      idempotencyKey: key("release"),
    });
    expect((await inventoryStates(fixture.session.id)).held).toBe(2);

    const released = await releaseSeatHold(database, { userId: customer.id }, {
      publicToken: hold.publicToken,
    });
    expect(released.released).toBe(true);
    expect(released.hold.status).toBe("RELEASED");
    expect((await inventoryStates(fixture.session.id)).held).toBe(0);

    // Second release is a no-op success; historical items remain.
    const again = await releaseSeatHold(database, { userId: customer.id }, {
      publicToken: hold.publicToken,
    });
    expect(again.released).toBe(false);
    await expect(
      database.seatHoldItem.count({ where: { hold: { publicToken: hold.publicToken } } }),
    ).resolves.toBe(2);
  });

  it("denies releasing another customer's hold via its public token", async () => {
    const fixture = await createSellableFixture("Release Denial");
    const owner = await createUser("Release Owner");
    const attacker = await createUser("Release Attacker");
    const { hold } = await acquireSeatHold(database, { userId: owner.id }, {
      sessionId: fixture.session.id,
      seatIds: [fixture.seatIds[0]],
      idempotencyKey: key("owned"),
    });
    await expect(
      releaseSeatHold(database, { userId: attacker.id }, { publicToken: hold.publicToken }),
    ).rejects.toBeInstanceOf(HoldAuthorizationError);
    expect((await inventoryStates(fixture.session.id)).held).toBe(1);
  });

  it("lets a released seat be reacquired", async () => {
    const fixture = await createSellableFixture("Reacquire Released");
    const first = await createUser("Reacquire First");
    const second = await createUser("Reacquire Second");
    const { hold } = await acquireSeatHold(database, { userId: first.id }, {
      sessionId: fixture.session.id,
      seatIds: [fixture.seatIds[0]],
      idempotencyKey: key("ra-1"),
    });
    await releaseSeatHold(database, { userId: first.id }, { publicToken: hold.publicToken });
    const second_hold = await acquireSeatHold(database, { userId: second.id }, {
      sessionId: fixture.session.id,
      seatIds: [fixture.seatIds[0]],
      idempotencyKey: key("ra-2"),
    });
    expect(second_hold.hold.status).toBe("ACTIVE");
  });

  it("expires overdue holds via the sweeper and frees their inventory", async () => {
    const fixture = await createSellableFixture("Sweep");
    const customer = await createUser("Sweep Customer");
    const { hold } = await acquireSeatHold(database, { userId: customer.id }, {
      sessionId: fixture.session.id,
      seatIds: [fixture.seatIds[0], fixture.seatIds[1]],
      idempotencyKey: key("sweep"),
    });

    const future = new Date(Date.now() + 40 * 60 * 1000);
    const result = await sweepExpiredHolds(database, { now: future });
    expect(result.holdsExpired).toBe(1);
    expect(result.seatsReleased).toBe(2);
    await expect(
      database.seatHold.findUniqueOrThrow({ where: { publicToken: hold.publicToken } }),
    ).resolves.toMatchObject({ status: "EXPIRED" });
    expect((await inventoryStates(fixture.session.id)).held).toBe(0);
  });

  it("is safe when two sweepers run concurrently (no hold expired twice)", async () => {
    const fixture = await createSellableFixture("Concurrent Sweep");
    for (let index = 0; index < 5; index += 1) {
      const customer = await createUser(`Sweeper Customer ${index}`);
      await acquireSeatHold(database, { userId: customer.id }, {
        sessionId: fixture.session.id,
        seatIds: [fixture.seatIds[index]],
        idempotencyKey: key(`sweep-${index}`),
      });
    }
    const future = new Date(Date.now() + 40 * 60 * 1000);
    const [a, b] = await Promise.all([
      sweepExpiredHolds(database, { now: future, batchSize: 2 }),
      sweepExpiredHolds(database, { now: future, batchSize: 2 }),
    ]);
    expect(a.holdsExpired + b.holdsExpired).toBe(5);
    await expect(
      database.seatHold.count({ where: { sessionId: fixture.session.id, status: "ACTIVE" } }),
    ).resolves.toBe(0);
  });

  it("lazily reclaims an expired seat during a later acquisition", async () => {
    const fixture = await createSellableFixture("Lazy Reclaim");
    const first = await createUser("Lazy First");
    const second = await createUser("Lazy Second");
    await acquireSeatHold(database, { userId: first.id }, {
      sessionId: fixture.session.id,
      seatIds: [fixture.seatIds[0]],
      idempotencyKey: key("lazy-1"),
    });
    // No sweeper runs; a later acquisition must still reclaim the expired seat.
    const future = new Date(Date.now() + 40 * 60 * 1000);
    const reclaimed = await acquireSeatHold(database, { userId: second.id }, {
      sessionId: fixture.session.id,
      seatIds: [fixture.seatIds[0]],
      idempotencyKey: key("lazy-2"),
    }, { now: future });
    expect(reclaimed.hold.status).toBe("ACTIVE");
    await expect(
      database.seatHold.count({ where: { sessionId: fixture.session.id, status: "EXPIRED" } }),
    ).resolves.toBe(1);
  });
});

describe("Phase 4A eligibility and cancellation", () => {
  it("rejects holds once the sales window has ended", async () => {
    const fixture = await createSellableFixture("Sales Window");
    const customer = await createUser("Window Customer");
    const afterSales = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    await expect(
      acquireSeatHold(
        database,
        { userId: customer.id },
        { sessionId: fixture.session.id, seatIds: [fixture.seatIds[0]], idempotencyKey: key("late") },
        { now: afterSales },
      ),
    ).rejects.toBeInstanceOf(HoldEligibilityError);
  });

  it("releases active holds and rejects new ones when a session is cancelled", async () => {
    const fixture = await createSellableFixture("Cancellation");
    const holder = await createUser("Cancellation Holder");
    const later = await createUser("Cancellation Later");
    const { hold } = await acquireSeatHold(database, { userId: holder.id }, {
      sessionId: fixture.session.id,
      seatIds: [fixture.seatIds[0], fixture.seatIds[1]],
      idempotencyKey: key("cancel"),
    });

    await cancelEventSession(database, {
      ...fixture.organizerScope,
      sessionId: fixture.session.id,
    });

    await expect(
      database.seatHold.findUniqueOrThrow({ where: { publicToken: hold.publicToken } }),
    ).resolves.toMatchObject({ status: "RELEASED" });
    expect((await inventoryStates(fixture.session.id)).held).toBe(0);
    // History is preserved.
    await expect(
      database.seatHoldItem.count({ where: { hold: { publicToken: hold.publicToken } } }),
    ).resolves.toBe(2);

    await expect(
      acquireSeatHold(database, { userId: later.id }, {
        sessionId: fixture.session.id,
        seatIds: [fixture.seatIds[2]],
        idempotencyKey: key("post-cancel"),
      }),
    ).rejects.toBeInstanceOf(HoldEligibilityError);
  });
});

describe("Phase 4A database invariant enforcement", () => {
  it("rejects direct writes that violate inventory state consistency", async () => {
    const fixture = await createSellableFixture("Invariant State");
    await expect(
      database.sessionSeatInventory.update({
        where: { id: fixture.inventory[0]!.id },
        data: { state: "HELD" },
      }),
    ).rejects.toThrow();
  });

  it("rejects moving inventory to another session and mutating its price snapshot", async () => {
    const fixture = await createSellableFixture("Invariant Immutable");
    const other = await createSellableFixture("Invariant Immutable Other");
    await expect(
      database.sessionSeatInventory.update({
        where: { id: fixture.inventory[0]!.id },
        data: { sessionId: other.session.id },
      }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      database.sessionSeatInventory.update({
        where: { id: fixture.inventory[0]!.id },
        data: { priceMinor: 1 },
      }),
    ).rejects.toThrow(/immutable/i);
  });

  it("preserves holds and inventory as permanent history", async () => {
    const fixture = await createSellableFixture("Invariant History");
    const customer = await createUser("History Customer");
    const { hold } = await acquireSeatHold(database, { userId: customer.id }, {
      sessionId: fixture.session.id,
      seatIds: [fixture.seatIds[0]],
      idempotencyKey: key("history"),
    });
    const holdRow = await database.seatHold.findUniqueOrThrow({
      where: { publicToken: hold.publicToken },
      select: { id: true },
    });
    await expect(
      database.seatHold.delete({ where: { id: holdRow.id } }),
    ).rejects.toThrow();
    await expect(
      database.sessionSeatInventory.delete({ where: { id: fixture.inventory[0]!.id } }),
    ).rejects.toThrow();
  });

  it("rejects a hold item whose price does not match the inventory snapshot", async () => {
    const fixture = await createSellableFixture("Invariant Item");
    const customer = await createUser("Item Customer");
    const { hold } = await acquireSeatHold(database, { userId: customer.id }, {
      sessionId: fixture.session.id,
      seatIds: [fixture.seatIds[0]],
      idempotencyKey: key("item"),
    });
    const holdRow = await database.seatHold.findUniqueOrThrow({
      where: { publicToken: hold.publicToken },
      select: { id: true },
    });
    await expect(
      database.seatHoldItem.create({
        data: {
          holdId: holdRow.id,
          inventoryId: fixture.inventory[1]!.id,
          priceMinor: 999_999,
          currency: CURRENCY,
        },
      }),
    ).rejects.toThrow(/snapshot/i);
  });
});

const dispatcherConfiguration: OutboxDispatcherConfiguration = {
  batchSize: 100,
  maximumAttempts: 3,
  backoffBaseMs: 1_000,
  backoffMaximumMs: 30_000,
};

describe("Phase 4B transactional inventory outbox", () => {
  it("commits a safe outbox record atomically with hold creation", async () => {
    const fixture = await createSellableFixture("Outbox Hold");
    const customer = await createUser("Outbox Hold Customer");
    const result = await acquireSeatHold(database, { userId: customer.id }, {
      sessionId: fixture.session.id,
      seatIds: [fixture.seatIds[0]],
      idempotencyKey: key("outbox-hold"),
    });
    const event = await database.inventoryEventOutbox.findFirstOrThrow({
      where: { eventType: "HOLD_CREATED", sessionId: fixture.session.id },
    });
    const serialized = JSON.stringify(event.payload);
    expect(event.aggregateId).not.toBeNull();
    expect(serialized).not.toContain(customer.id);
    expect(serialized).not.toContain(customer.email);
    expect(serialized).not.toContain(result.hold.publicToken);
  });

  it("rolls back the outbox when an all-or-nothing hold fails", async () => {
    const fixture = await createSellableFixture("Outbox Rollback");
    const winner = await createUser("Outbox Winner");
    const loser = await createUser("Outbox Loser");
    await acquireSeatHold(database, { userId: winner.id }, {
      sessionId: fixture.session.id,
      seatIds: [fixture.seatIds[0]],
      idempotencyKey: key("outbox-winner"),
    });
    const before = await database.inventoryEventOutbox.count({
      where: { eventType: "HOLD_CREATED" },
    });
    await expect(
      acquireSeatHold(database, { userId: loser.id }, {
        sessionId: fixture.session.id,
        seatIds: [fixture.seatIds[0], fixture.seatIds[1]],
        idempotencyKey: key("outbox-loser"),
      }),
    ).rejects.toBeInstanceOf(HoldConflictError);
    expect(
      await database.inventoryEventOutbox.count({ where: { eventType: "HOLD_CREATED" } }),
    ).toBe(before);
    expect(await database.seatHold.count({ where: { userId: loser.id } })).toBe(0);
  });

  it("writes manual release and sweeper expiry events in their mutation transactions", async () => {
    const fixture = await createSellableFixture("Outbox Release Expiry");
    const releaseCustomer = await createUser("Outbox Release Customer");
    const expiryCustomer = await createUser("Outbox Expiry Customer");
    const released = await acquireSeatHold(database, { userId: releaseCustomer.id }, {
      sessionId: fixture.session.id,
      seatIds: [fixture.seatIds[0]],
      idempotencyKey: key("outbox-release"),
    });
    await releaseSeatHold(database, { userId: releaseCustomer.id }, {
      publicToken: released.hold.publicToken,
    });
    expect(
      await database.inventoryEventOutbox.count({ where: { eventType: "HOLD_RELEASED" } }),
    ).toBe(1);

    const acquiredAt = new Date(Date.now() + 1_000);
    await acquireSeatHold(
      database,
      { userId: expiryCustomer.id },
      {
        sessionId: fixture.session.id,
        seatIds: [fixture.seatIds[1]],
        idempotencyKey: key("outbox-expiry"),
      },
      {
        now: acquiredAt,
        config: { ...DEFAULT_HOLD_CONFIGURATION, holdDurationMs: 1_000 },
      },
    );
    await sweepExpiredHolds(database, { now: new Date(acquiredAt.getTime() + 1_001) });
    expect(
      await database.inventoryEventOutbox.count({ where: { eventType: "HOLD_EXPIRED" } }),
    ).toBe(1);
  });

  it("writes lazy-expiry and session-cancellation invalidations", async () => {
    const fixture = await createSellableFixture("Outbox Lazy Cancel");
    const expiredCustomer = await createUser("Outbox Lazy Expired");
    const replacementCustomer = await createUser("Outbox Lazy Replacement");
    const acquiredAt = new Date(Date.now() + 1_000);
    await acquireSeatHold(
      database,
      { userId: expiredCustomer.id },
      {
        sessionId: fixture.session.id,
        seatIds: [fixture.seatIds[0]],
        idempotencyKey: key("outbox-lazy-old"),
      },
      {
        now: acquiredAt,
        config: { ...DEFAULT_HOLD_CONFIGURATION, holdDurationMs: 1_000 },
      },
    );
    await acquireSeatHold(
      database,
      { userId: replacementCustomer.id },
      {
        sessionId: fixture.session.id,
        seatIds: [fixture.seatIds[0]],
        idempotencyKey: key("outbox-lazy-new"),
      },
      { now: new Date(acquiredAt.getTime() + 1_001) },
    );
    expect(
      await database.inventoryEventOutbox.count({ where: { eventType: "HOLD_EXPIRED" } }),
    ).toBe(1);

    await cancelEventSession(database, {
      ...fixture.organizerScope,
      sessionId: fixture.session.id,
    });
    expect(
      await database.inventoryEventOutbox.count({ where: { eventType: "SESSION_CANCELLED" } }),
    ).toBe(1);
    expect(await database.seatHold.count({ where: { status: "ACTIVE" } })).toBe(0);
  });

  it("releases active holds and emits session invalidation when the parent event is cancelled", async () => {
    const fixture = await createSellableFixture("Outbox Event Cancel");
    const customer = await createUser("Outbox Event Cancel Customer");
    await acquireSeatHold(database, { userId: customer.id }, {
      sessionId: fixture.session.id,
      seatIds: [fixture.seatIds[0]],
      idempotencyKey: key("outbox-event-cancel"),
    });
    await cancelEvent(database, fixture.organizerScope);
    expect(await database.seatHold.count({ where: { status: "ACTIVE" } })).toBe(0);
    expect(await inventoryStates(fixture.session.id)).toEqual({
      total: fixture.inventory.length,
      available: fixture.inventory.length,
      held: 0,
    });
    expect(
      await database.inventoryEventOutbox.count({
        where: { sessionId: fixture.session.id, eventType: "SESSION_CANCELLED" },
      }),
    ).toBe(1);
  });
});

describe("Phase 4B concurrent outbox dispatcher", () => {
  it("partitions claims across workers without duplicate publication", async () => {
    const fixture = await createSellableFixture("Dispatcher Claims");
    const customer = await createUser("Dispatcher Customer");
    const acquired = await acquireSeatHold(database, { userId: customer.id }, {
      sessionId: fixture.session.id,
      seatIds: [fixture.seatIds[0]],
      idempotencyKey: key("dispatcher-hold"),
    });
    await releaseSeatHold(database, { userId: customer.id }, {
      publicToken: acquired.hold.publicToken,
    });

    const published: string[] = [];
    const transport: InventoryEventTransport = {
      async publish(event) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        published.push(event.eventId);
      },
    };
    const configuration = { ...dispatcherConfiguration, batchSize: 2 };
    const now = new Date(Date.now() + 1_000);
    const results = await Promise.all([
      dispatchInventoryEventBatch(database, transport, configuration, now),
      dispatchInventoryEventBatch(database, transport, configuration, now),
    ]);
    expect(results.reduce((sum, result) => sum + result.processed, 0)).toBe(3);
    expect(new Set(published).size).toBe(3);
    expect(await database.inventoryEventOutbox.count({ where: { processedAt: null } })).toBe(0);
  });

  it("applies retry backoff and dead-letters at the configured bound", async () => {
    await createSellableFixture("Dispatcher Retry");
    const transport: InventoryEventTransport = {
      async publish() {
        throw new Error("Redis delivery unavailable");
      },
    };
    const configuration = {
      ...dispatcherConfiguration,
      batchSize: 1,
      maximumAttempts: 2,
      backoffBaseMs: 100,
      backoffMaximumMs: 100,
    };
    const firstNow = new Date(Date.now() + 1_000);
    const first = await dispatchInventoryEventBatch(
      database,
      transport,
      configuration,
      firstNow,
    );
    expect(first).toMatchObject({ failed: 1, deadLettered: 0 });
    const second = await dispatchInventoryEventBatch(
      database,
      transport,
      configuration,
      new Date(firstNow.getTime() + 101),
    );
    expect(second).toMatchObject({ failed: 1, deadLettered: 1 });
    const row = await database.inventoryEventOutbox.findFirstOrThrow();
    expect(row).toMatchObject({ attemptCount: 2, processedAt: null });
    expect(row.deadLetterAt).not.toBeNull();
    expect(row.lastError).toMatch(/Redis delivery unavailable/);
  });
});
