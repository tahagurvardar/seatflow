import {
  Prisma,
  type PrismaClient,
} from "@/generated/prisma/client";
import type { EventStatus } from "@/generated/prisma/enums";
import { zonedLocalDateTimeToUtc } from "@/features/events/date-time";
import {
  canCancelSession,
  canEditSession,
  canPauseSessionSales,
} from "@/features/events/lifecycle";
import { calculatePricingCoverage } from "@/features/events/pricing";
import {
  eventSessionInputSchema,
  sessionDateRangeSchema,
  type EventSessionInput,
} from "@/features/events/schema";
import { findAuthorizedEventSession, findAuthorizedEvent } from "@/server/authorization/event-resources";
import { withSerializableRetry } from "@/server/database/serializable-transaction";
import {
  EventAuthorizationError,
  EventConflictError,
  EventLifecycleError,
  EventValidationError,
  isSessionOverlapConstraintError,
} from "@/server/events/errors";
import { releaseActiveHoldsForSession } from "@/server/holds/expiry-service";
import { ensureSessionInventory } from "@/server/holds/inventory-service";

export const eventSessionDetailInclude = {
  venue: true,
  space: true,
  seatMap: {
    include: {
      sections: {
        orderBy: [{ displayOrder: "asc" }, { code: "asc" }],
        include: {
          rows: {
            orderBy: [{ displayOrder: "asc" }, { label: "asc" }],
            include: {
              seats: {
                orderBy: [{ displayOrder: "asc" }, { label: "asc" }],
              },
            },
          },
        },
      },
    },
  },
  priceTiers: {
    orderBy: [{ displayOrder: "asc" }, { code: "asc" }],
  },
  sectionPricing: true,
} satisfies Prisma.EventSessionInclude;

interface EventScope {
  userId: string;
  organizationSlug: string;
  eventSlug: string;
}

interface SessionScope extends EventScope {
  sessionId: string;
}

function assertEventAllowsSessionManagement(status: EventStatus) {
  if (!["DRAFT", "PUBLISHED"].includes(status)) {
    throw new EventLifecycleError(
      "Restore an archived event before changing its sessions.",
    );
  }
}

function parseSessionTimes(input: EventSessionInput, timeZone: string) {
  try {
    return sessionDateRangeSchema.parse({
      startAt: zonedLocalDateTimeToUtc(input.startLocal, timeZone),
      endAt: zonedLocalDateTimeToUtc(input.endLocal, timeZone),
      salesStartAt: zonedLocalDateTimeToUtc(input.salesStartLocal, timeZone),
      salesEndAt: zonedLocalDateTimeToUtc(input.salesEndLocal, timeZone),
    });
  } catch (error) {
    if (error instanceof Error && error.name !== "ZodError") {
      throw new EventValidationError([error.message]);
    }
    throw error;
  }
}

async function loadAuthorizedConfiguration(
  transaction: Prisma.TransactionClient,
  organizerOrganizationId: string,
  input: Pick<EventSessionInput, "venueId" | "spaceId" | "seatMapId">,
) {
  const [venue, space, seatMap, activeGrant] = await Promise.all([
    transaction.venue.findUnique({ where: { id: input.venueId } }),
    transaction.space.findUnique({ where: { id: input.spaceId } }),
    transaction.seatMap.findUnique({ where: { id: input.seatMapId } }),
    transaction.venueAccessGrant.findFirst({
      where: {
        organizerOrganizationId,
        venueId: input.venueId,
        status: "ACTIVE",
      },
    }),
  ]);

  if (!venue || !space || !seatMap || !activeGrant) {
    throw new EventAuthorizationError();
  }
  if (venue.status !== "ACTIVE" || space.status !== "ACTIVE") {
    throw new EventLifecycleError("Sessions require an active venue and space.");
  }
  if (space.venueId !== venue.id) {
    throw new EventAuthorizationError();
  }
  if (seatMap.spaceId !== space.id || seatMap.status !== "PUBLISHED") {
    throw new EventAuthorizationError();
  }

  return { venue, space, seatMap };
}

async function findConflict(
  transaction: Prisma.TransactionClient,
  input: {
    spaceId: string;
    startAt: Date;
    endAt: Date;
    excludeSessionId?: string;
  },
) {
  return transaction.eventSession.findFirst({
    where: {
      spaceId: input.spaceId,
      status: { not: "CANCELLED" },
      startAt: { lt: input.endAt },
      endAt: { gt: input.startAt },
      ...(input.excludeSessionId ? { id: { not: input.excludeSessionId } } : {}),
    },
    select: { id: true },
  });
}

function throwOverlap() {
  throw new EventConflictError(
    "Another non-cancelled session already occupies this space during that time.",
  );
}

export async function createEventSession(
  database: PrismaClient,
  scope: EventScope,
  rawInput: EventSessionInput,
) {
  const access = await findAuthorizedEvent(database, {
    ...scope,
    minimumRole: "ADMIN",
  });
  if (!access) throw new EventAuthorizationError();
  if (!["DRAFT", "PUBLISHED"].includes(access.event.status)) {
    throw new EventLifecycleError("Sessions cannot be added to this event.");
  }
  const input = eventSessionInputSchema.parse(rawInput);

  try {
    return await withSerializableRetry(database, async (transaction) => {
      const event = await transaction.event.findFirst({
        where: {
          id: access.event.id,
          organizerOrganizationId: access.membership.organizationId,
          status: { in: ["DRAFT", "PUBLISHED"] },
        },
      });
      if (!event) throw new EventAuthorizationError();

      const configuration = await loadAuthorizedConfiguration(
        transaction,
        access.membership.organizationId,
        input,
      );
      const times = parseSessionTimes(input, configuration.venue.timeZone);
      if (await findConflict(transaction, { spaceId: input.spaceId, ...times })) {
        throwOverlap();
      }

      return transaction.eventSession.create({
        data: {
          eventId: event.id,
          venueId: configuration.venue.id,
          spaceId: configuration.space.id,
          seatMapId: configuration.seatMap.id,
          ...times,
        },
      });
    });
  } catch (error) {
    if (isSessionOverlapConstraintError(error)) throwOverlap();
    throw error;
  }
}

export async function updateDraftEventSession(
  database: PrismaClient,
  scope: SessionScope,
  rawInput: EventSessionInput,
) {
  const access = await findAuthorizedEventSession(database, {
    ...scope,
    minimumRole: "ADMIN",
  });
  if (!access) throw new EventAuthorizationError();
  assertEventAllowsSessionManagement(access.event.status);
  if (!canEditSession(access.eventSession.status)) {
    throw new EventLifecycleError("Only draft sessions can be edited.");
  }
  const input = eventSessionInputSchema.parse(rawInput);

  try {
    return await withSerializableRetry(database, async (transaction) => {
      const eventSession = await transaction.eventSession.findFirst({
        where: {
          id: access.eventSession.id,
          eventId: access.event.id,
          status: "DRAFT",
          event: { status: { in: ["DRAFT", "PUBLISHED"] } },
        },
      });
      if (!eventSession) {
        throw new EventLifecycleError("Only draft sessions can be edited.");
      }

      const configuration = await loadAuthorizedConfiguration(
        transaction,
        access.membership.organizationId,
        input,
      );
      const times = parseSessionTimes(input, configuration.venue.timeZone);
      if (
        await findConflict(transaction, {
          spaceId: input.spaceId,
          ...times,
          excludeSessionId: eventSession.id,
        })
      ) {
        throwOverlap();
      }

      return transaction.eventSession.update({
        where: { id: eventSession.id },
        data: {
          venueId: configuration.venue.id,
          spaceId: configuration.space.id,
          seatMapId: configuration.seatMap.id,
          ...times,
        },
      });
    });
  } catch (error) {
    if (isSessionOverlapConstraintError(error)) throwOverlap();
    throw error;
  }
}

export function getSessionPricingCoverage(
  eventSession: Prisma.EventSessionGetPayload<{
    include: typeof eventSessionDetailInclude;
  }>,
) {
  return calculatePricingCoverage(
    eventSession.seatMap.sections,
    eventSession.priceTiers,
    eventSession.sectionPricing,
  );
}

export async function getSessionPublicationReadiness(
  database: PrismaClient,
  sessionId: string,
) {
  const eventSession = await database.eventSession.findUnique({
    where: { id: sessionId },
    include: eventSessionDetailInclude,
  });
  if (!eventSession) throw new EventAuthorizationError();

  const coverage = getSessionPricingCoverage(eventSession);
  const issues = [...coverage.issues];
  if (coverage.totalSellable <= 0) {
    issues.push("The published seat map must have positive sellable capacity.");
  }
  if (eventSession.priceTiers.length === 0) {
    issues.push("Add at least one price tier.");
  }

  return { eventSession, coverage, issues: [...new Set(issues)] };
}

export async function publishEventSession(
  database: PrismaClient,
  scope: SessionScope,
) {
  const access = await findAuthorizedEventSession(database, {
    ...scope,
    minimumRole: "ADMIN",
  });
  if (!access) throw new EventAuthorizationError();

  try {
    return await withSerializableRetry(database, async (transaction) => {
      const eventSession = await transaction.eventSession.findFirst({
        where: { id: access.eventSession.id, eventId: access.event.id },
        include: {
          ...eventSessionDetailInclude,
          event: true,
        },
      });
      if (!eventSession) throw new EventAuthorizationError();
      if (["SCHEDULED", "ON_SALE", "SALES_PAUSED"].includes(eventSession.status)) {
        return eventSession;
      }
      if (eventSession.status !== "DRAFT") {
        throw new EventLifecycleError("This session cannot be published from its current state.");
      }
      if (!["DRAFT", "PUBLISHED"].includes(eventSession.event.status)) {
        throw new EventLifecycleError("The parent event is not eligible for session publication.");
      }

      await loadAuthorizedConfiguration(
        transaction,
        access.membership.organizationId,
        eventSession,
      );
      sessionDateRangeSchema.parse(eventSession);

      const now = new Date();
      const coverage = getSessionPricingCoverage(eventSession);
      const issues = [...coverage.issues];
      if (eventSession.startAt <= now) issues.push("The session start time must be in the future.");
      if (eventSession.salesEndAt <= now) issues.push("The sales window has already ended.");
      if (coverage.totalSellable <= 0) {
        issues.push("The published seat map must have positive sellable capacity.");
      }
      if (eventSession.priceTiers.length === 0) issues.push("Add at least one price tier.");
      if (
        await findConflict(transaction, {
          spaceId: eventSession.spaceId,
          startAt: eventSession.startAt,
          endAt: eventSession.endAt,
          excludeSessionId: eventSession.id,
        })
      ) {
        issues.push("Another non-cancelled session overlaps this space and time.");
      }
      if (issues.length > 0) throw new EventValidationError([...new Set(issues)]);

      const status =
        eventSession.salesStartAt <= now && now < eventSession.salesEndAt
          ? "ON_SALE"
          : "SCHEDULED";

      // Materialize authoritative sellable inventory before completing the
      // publication transition, so a published session always has consistent
      // inventory equal to its sellable capacity.
      await ensureSessionInventory(transaction, eventSession.id);

      return transaction.eventSession.update({
        where: { id: eventSession.id },
        data: { status, publishedAt: now },
        include: eventSessionDetailInclude,
      });
    });
  } catch (error) {
    if (isSessionOverlapConstraintError(error)) throwOverlap();
    throw error;
  }
}

export async function pauseEventSessionSales(
  database: PrismaClient,
  scope: SessionScope,
) {
  const access = await findAuthorizedEventSession(database, {
    ...scope,
    minimumRole: "ADMIN",
  });
  if (!access) throw new EventAuthorizationError();
  assertEventAllowsSessionManagement(access.event.status);
  if (!canPauseSessionSales(access.eventSession.status)) {
    throw new EventLifecycleError("Only an on-sale session can be paused.");
  }

  return database.eventSession.update({
    where: { id: access.eventSession.id },
    data: { status: "SALES_PAUSED" },
  });
}

export async function resumeEventSessionSales(
  database: PrismaClient,
  scope: SessionScope,
) {
  const access = await findAuthorizedEventSession(database, {
    ...scope,
    minimumRole: "ADMIN",
  });
  if (!access) throw new EventAuthorizationError();
  assertEventAllowsSessionManagement(access.event.status);
  if (!["SCHEDULED", "SALES_PAUSED"].includes(access.eventSession.status)) {
    throw new EventLifecycleError("Only a scheduled or paused session can open sales.");
  }
  const now = new Date();
  if (now < access.eventSession.salesStartAt || now >= access.eventSession.salesEndAt) {
    throw new EventLifecycleError("Sales can open only inside the configured sales window.");
  }

  return database.eventSession.update({
    where: { id: access.eventSession.id },
    data: { status: "ON_SALE" },
  });
}

export async function cancelEventSession(
  database: PrismaClient,
  scope: SessionScope,
) {
  const access = await findAuthorizedEventSession(database, {
    ...scope,
    minimumRole: "ADMIN",
  });
  if (!access) throw new EventAuthorizationError();
  if (access.eventSession.status === "CANCELLED") return access.eventSession;
  assertEventAllowsSessionManagement(access.event.status);
  if (!canCancelSession(access.eventSession.status)) {
    throw new EventLifecycleError("This session cannot be cancelled.");
  }

  const now = new Date();
  return withSerializableRetry(database, async (transaction) => {
    // Lock the session's inventory first so any in-flight hold acquisition
    // serializes with this cancellation and cannot slip a hold onto the
    // session as it is being cancelled.
    await transaction.$queryRaw`
      SELECT "id" FROM "SessionSeatInventory"
      WHERE "sessionId" = ${access.eventSession.id}
      FOR UPDATE
    `;
    const cancelled = await transaction.eventSession.update({
      where: { id: access.eventSession.id },
      data: { status: "CANCELLED", cancelledAt: now },
    });
    // Existing active holds are released (not invented into bookings) and their
    // seats returned to AVAILABLE; hold history is preserved.
    await releaseActiveHoldsForSession(transaction, access.eventSession.id, now);
    return cancelled;
  });
}
