import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { TicketStatus } from "@/generated/prisma/enums";
import { findAuthorizedEventSession } from "@/server/authorization/event-resources";

const ticketViewInclude = {
  event: { select: { title: true, publicSlug: true } },
  session: {
    include: {
      venue: { select: { name: true, city: true, timeZone: true } },
      space: { select: { name: true } },
    },
  },
  booking: { select: { publicReference: true } },
  bookingSeat: {
    select: {
      seatLabel: true,
      rowLabel: true,
      sectionName: true,
      sectionCode: true,
      tierName: true,
    },
  },
  credentials: {
    orderBy: { version: "desc" },
    take: 1,
    select: { version: true, status: true },
  },
} satisfies Prisma.TicketInclude;

type TicketWithView = Prisma.TicketGetPayload<{ include: typeof ticketViewInclude }>;

export interface CustomerTicketView {
  publicReference: string;
  bookingReference: string;
  status: TicketStatus;
  issuedAt: string;
  revokedAt: string | null;
  revocationReason: string | null;
  credentialAvailable: boolean;
  event: { title: string; publicSlug: string };
  session: {
    id: string;
    startAt: string;
    endAt: string;
    timeZone: string;
    venueName: string;
    spaceName: string;
    city: string;
  };
  seat: {
    seatLabel: string;
    rowLabel: string;
    sectionName: string;
    sectionCode: string;
    tierName: string;
  };
}

export function mapTicketToView(ticket: TicketWithView): CustomerTicketView {
  return {
    publicReference: ticket.publicReference,
    bookingReference: ticket.booking.publicReference,
    status: ticket.status,
    issuedAt: ticket.issuedAt.toISOString(),
    revokedAt: ticket.revokedAt?.toISOString() ?? null,
    revocationReason: ticket.revocationReason,
    credentialAvailable: Boolean(ticket.credentials[0]),
    event: ticket.event,
    session: {
      id: ticket.session.id,
      startAt: ticket.session.startAt.toISOString(),
      endAt: ticket.session.endAt.toISOString(),
      timeZone: ticket.session.venue.timeZone,
      venueName: ticket.session.venue.name,
      spaceName: ticket.session.space.name,
      city: ticket.session.venue.city,
    },
    seat: ticket.bookingSeat,
  };
}

export async function listCustomerTickets(database: PrismaClient, userId: string, limit = 100) {
  const tickets = await database.ticket.findMany({
    where: { userId },
    orderBy: { issuedAt: "desc" },
    take: Math.min(Math.max(limit, 1), 100),
    include: ticketViewInclude,
  });
  return tickets.map(mapTicketToView);
}

export async function getCustomerTicketByReference(
  database: PrismaClient,
  input: { userId: string; publicReference: string },
) {
  const ticket = await database.ticket.findFirst({
    where: { publicReference: input.publicReference, userId: input.userId },
    include: ticketViewInclude,
  });
  return ticket ? mapTicketToView(ticket) : null;
}

export async function listCustomerBookingTickets(
  database: PrismaClient,
  input: { userId: string; bookingReference: string },
) {
  const tickets = await database.ticket.findMany({
    where: { userId: input.userId, booking: { publicReference: input.bookingReference } },
    orderBy: [{ bookingSeat: { sectionCode: "asc" } }, { bookingSeat: { rowLabel: "asc" } }, { bookingSeat: { seatLabel: "asc" } }],
    include: ticketViewInclude,
  });
  return tickets.map(mapTicketToView);
}

export async function getOrganizerTicketSummary(
  database: PrismaClient,
  scope: {
    userId: string;
    organizationSlug: string;
    eventSlug: string;
    sessionId: string;
  },
) {
  const access = await findAuthorizedEventSession(database, { ...scope, minimumRole: "MEMBER" });
  if (!access) return null;
  const [confirmed, active, used, revoked, issuanceBacklog, notificationBacklog, outcomes] =
    await Promise.all([
      database.ticket.count({ where: { sessionId: scope.sessionId } }),
      database.ticket.count({ where: { sessionId: scope.sessionId, status: "ACTIVE" } }),
      database.ticket.count({ where: { sessionId: scope.sessionId, status: "USED" } }),
      database.ticket.count({ where: { sessionId: scope.sessionId, status: "REVOKED" } }),
      database.ticketIssuanceRequest.count({
        where: { status: "PENDING", booking: { sessionId: scope.sessionId } },
      }),
      database.notificationOutbox.count({
        where: { status: "PENDING", booking: { sessionId: scope.sessionId } },
      }),
      database.ticketRedemptionEvent.groupBy({
        by: ["outcome"],
        where: { sessionId: scope.sessionId },
        _count: { _all: true },
        orderBy: { outcome: "asc" },
      }),
    ]);
  return {
    confirmed,
    active,
    used,
    revoked,
    issuanceBacklog,
    notificationBacklog,
    recentOutcomes: outcomes.map((entry) => ({ outcome: entry.outcome, count: entry._count._all })),
  };
}
