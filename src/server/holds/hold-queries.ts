import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { SupportedCurrency } from "@/config/site";
import { getHoldConfiguration } from "@/features/holds/config";
import {
  evaluateSessionSalesEligibility,
  type SessionSalesEligibility,
} from "@/features/holds/eligibility";
import {
  countSelectionStates,
  mapSeatSelectionSections,
  type SelectionAvailabilityCounts,
  type SelectionSectionView,
} from "@/features/holds/inventory";
import {
  toOrganizerInventorySummary,
  type CustomerHoldView,
  type OrganizerInventorySummary,
} from "@/features/holds/view-models";
import {
  HoldAuthorizationError,
} from "@/server/holds/errors";
import { holdViewInclude, mapHoldToView } from "@/server/holds/hold-service";

export interface SeatSelectionView {
  event: { title: string; publicSlug: string };
  session: {
    id: string;
    startAt: string;
    salesEndAt: string;
    timeZone: string;
    venueName: string;
    spaceName: string;
    city: string;
    seatMapName: string;
    seatMapVersion: number;
  };
  sections: SelectionSectionView[];
  counts: SelectionAvailabilityCounts;
  eligibility: SessionSalesEligibility;
  currency: SupportedCurrency | null;
  maxSeatsPerHold: number;
  viewerAuthenticated: boolean;
  viewerActiveHold: { publicToken: string; expiresAt: string } | null;
}

const seatSelectionSessionInclude = {
  venue: { select: { name: true, city: true, timeZone: true } },
  space: { select: { name: true } },
  seatMap: {
    select: {
      name: true,
      version: true,
      sections: {
        orderBy: [{ displayOrder: "asc" }, { code: "asc" }],
        select: {
          id: true,
          name: true,
          code: true,
          rows: {
            orderBy: [{ displayOrder: "asc" }, { label: "asc" }],
            select: {
              id: true,
              label: true,
              seats: {
                orderBy: [{ displayOrder: "asc" }, { label: "asc" }],
                select: {
                  id: true,
                  label: true,
                  x: true,
                  y: true,
                  type: true,
                  state: true,
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.EventSessionInclude;

/**
 * Build the customer seat-selection view for a published session of a published
 * event. Returns null for anything a customer should not see (unknown or draft
 * event/session), so the route can render a true 404. Seats held by other
 * customers are surfaced only as unavailable.
 */
export async function getSeatSelectionView(
  database: PrismaClient,
  actor: { userId: string } | null,
  input: { publicSlug: string; sessionId: string },
  now = new Date(),
): Promise<SeatSelectionView | null> {
  const event = await database.event.findFirst({
    where: { publicSlug: input.publicSlug, status: "PUBLISHED" },
    select: { id: true, title: true, publicSlug: true, status: true },
  });
  if (!event) return null;

  const session = await database.eventSession.findFirst({
    where: { id: input.sessionId, eventId: event.id, publishedAt: { not: null } },
    include: seatSelectionSessionInclude,
  });
  if (!session) return null;

  const inventory = await database.sessionSeatInventory.findMany({
    where: { sessionId: session.id },
    select: {
      seatId: true,
      state: true,
      currentHoldId: true,
      priceMinor: true,
      currency: true,
    },
  });

  const viewerActiveHold = actor
    ? await database.seatHold.findFirst({
        where: { sessionId: session.id, userId: actor.userId, status: "ACTIVE" },
        select: { id: true, publicToken: true, expiresAt: true },
      })
    : null;

  const sections = mapSeatSelectionSections(
    session.seatMap.sections,
    inventory,
    viewerActiveHold?.id ?? null,
  );

  const eligibility = evaluateSessionSalesEligibility({
    eventStatus: event.status,
    sessionStatus: session.status,
    sessionStartAt: session.startAt,
    salesStartAt: session.salesStartAt,
    salesEndAt: session.salesEndAt,
    hasInventory: inventory.length > 0,
    now,
  });

  return {
    event: { title: event.title, publicSlug: event.publicSlug },
    session: {
      id: session.id,
      startAt: session.startAt.toISOString(),
      salesEndAt: session.salesEndAt.toISOString(),
      timeZone: session.venue.timeZone,
      venueName: session.venue.name,
      spaceName: session.space.name,
      city: session.venue.city,
      seatMapName: session.seatMap.name,
      seatMapVersion: session.seatMap.version,
    },
    sections,
    counts: countSelectionStates(sections),
    eligibility,
    currency: inventory[0]?.currency ?? null,
    maxSeatsPerHold: getHoldConfiguration().maxSeatsPerHold,
    viewerAuthenticated: actor !== null,
    viewerActiveHold: viewerActiveHold
      ? {
          publicToken: viewerActiveHold.publicToken,
          expiresAt: viewerActiveHold.expiresAt.toISOString(),
        }
      : null,
  };
}

/**
 * Load a hold's owner-facing view. Ownership is verified by user id; a guessed
 * token for another customer's hold yields the same not-found error.
 */
export async function getCustomerHoldByToken(
  database: PrismaClient,
  actor: { userId: string },
  publicToken: string,
  now = new Date(),
): Promise<CustomerHoldView> {
  const hold = await database.seatHold.findUnique({
    where: { publicToken },
    include: holdViewInclude,
  });
  if (!hold || hold.userId !== actor.userId) {
    throw new HoldAuthorizationError();
  }
  return mapHoldToView(hold, now);
}

export interface CustomerHoldsView {
  active: CustomerHoldView[];
  recent: CustomerHoldView[];
}

/**
 * The customer's own holds: all live/active holds plus a small window of recent
 * released or expired holds. History is deliberately limited so the dashboard
 * never becomes an unbounded ledger.
 */
export async function listCustomerHolds(
  database: PrismaClient,
  userId: string,
  now = new Date(),
  recentLimit = 5,
): Promise<CustomerHoldsView> {
  const [active, recent] = await Promise.all([
    database.seatHold.findMany({
      where: { userId, status: "ACTIVE" },
      orderBy: { expiresAt: "asc" },
      include: holdViewInclude,
    }),
    database.seatHold.findMany({
      where: { userId, status: { in: ["RELEASED", "EXPIRED", "CONVERTED"] } },
      orderBy: { updatedAt: "desc" },
      take: recentLimit,
      include: holdViewInclude,
    }),
  ]);

  return {
    active: active.map((hold) => mapHoldToView(hold, now)),
    recent: recent.map((hold) => mapHoldToView(hold, now)),
  };
}

/**
 * Aggregate, read-only inventory summary for organizers. Returns counts only —
 * never a customer email, id, or hold token — and never presents holds as sales.
 */
export async function getSessionInventorySummary(
  database: PrismaClient,
  sessionId: string,
): Promise<OrganizerInventorySummary> {
  const [total, available, held, activeHolds, earliest] = await Promise.all([
    database.sessionSeatInventory.count({ where: { sessionId } }),
    database.sessionSeatInventory.count({ where: { sessionId, state: "AVAILABLE" } }),
    database.sessionSeatInventory.count({ where: { sessionId, state: "HELD" } }),
    database.seatHold.count({ where: { sessionId, status: "ACTIVE" } }),
    database.seatHold.findFirst({
      where: { sessionId, status: "ACTIVE" },
      orderBy: { expiresAt: "asc" },
      select: { expiresAt: true },
    }),
  ]);

  return toOrganizerInventorySummary({
    total,
    available,
    held,
    activeHolds,
    earliestHoldExpiresAt: earliest?.expiresAt ?? null,
  });
}
