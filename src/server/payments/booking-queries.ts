import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { SupportedCurrency } from "@/config/site";
import { findAuthorizedEventSession } from "@/server/authorization/event-resources";
import { CheckoutAuthorizationError } from "@/server/payments/errors";

const bookingViewInclude = {
  event: { select: { title: true, publicSlug: true } },
  session: {
    include: {
      venue: { select: { name: true, city: true, timeZone: true } },
      space: { select: { name: true } },
    },
  },
  seats: { orderBy: [{ sectionCode: "asc" }, { rowLabel: "asc" }, { seatLabel: "asc" }] },
  order: {
    select: {
      publicReference: true,
      status: true,
      paymentAttempts: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true } },
    },
  },
} satisfies Prisma.BookingInclude;

type BookingWithView = Prisma.BookingGetPayload<{ include: typeof bookingViewInclude }>;

export interface CustomerBookingView {
  publicReference: string;
  status: BookingWithView["status"];
  currency: SupportedCurrency;
  totalMinor: number;
  confirmedAt: string;
  paymentStatus: string;
  event: { title: string; publicSlug: string };
  session: {
    id: string;
    startAt: string;
    timeZone: string;
    venueName: string;
    spaceName: string;
    city: string;
  };
  seats: Array<{
    seatLabel: string;
    rowLabel: string;
    sectionName: string;
    sectionCode: string;
    tierName: string;
    tierCode: string;
    priceMinor: number;
    currency: SupportedCurrency;
  }>;
}

export function mapBookingToView(booking: BookingWithView): CustomerBookingView {
  return {
    publicReference: booking.publicReference,
    status: booking.status,
    currency: booking.currency,
    totalMinor: booking.totalMinor,
    confirmedAt: booking.confirmedAt.toISOString(),
    paymentStatus: booking.order.paymentAttempts[0]?.status ?? "SUCCEEDED",
    event: booking.event,
    session: {
      id: booking.session.id,
      startAt: booking.session.startAt.toISOString(),
      timeZone: booking.session.venue.timeZone,
      venueName: booking.session.venue.name,
      spaceName: booking.session.space.name,
      city: booking.session.venue.city,
    },
    seats: booking.seats.map((seat) => ({
      seatLabel: seat.seatLabel,
      rowLabel: seat.rowLabel,
      sectionName: seat.sectionName,
      sectionCode: seat.sectionCode,
      tierName: seat.tierName,
      tierCode: seat.tierCode,
      priceMinor: seat.priceMinor,
      currency: seat.currency,
    })),
  };
}

export async function listCustomerBookings(
  database: PrismaClient,
  userId: string,
  limit = 50,
) {
  const bookings = await database.booking.findMany({
    where: { userId },
    orderBy: { confirmedAt: "desc" },
    take: Math.min(Math.max(limit, 1), 100),
    include: bookingViewInclude,
  });
  return bookings.map(mapBookingToView);
}

export async function getCustomerBookingByReference(
  database: PrismaClient,
  actor: { userId: string },
  publicReference: string,
) {
  const booking = await database.booking.findUnique({
    where: { publicReference },
    include: bookingViewInclude,
  });
  if (!booking || booking.userId !== actor.userId) {
    throw new CheckoutAuthorizationError("That booking was not found or is not yours.");
  }
  return mapBookingToView(booking);
}

export interface OrganizerBookingSummary {
  confirmedBookingCount: number;
  bookedSeatCount: number;
  grossByCurrency: Array<{ currency: SupportedCurrency; totalMinor: number }>;
  paidUnfulfilledReviewCount: number;
}

export async function getOrganizerBookingSummary(
  database: PrismaClient,
  scope: {
    userId: string;
    organizationSlug: string;
    eventSlug: string;
    sessionId: string;
  },
): Promise<OrganizerBookingSummary> {
  const access = await findAuthorizedEventSession(database, {
    ...scope,
    minimumRole: "MEMBER",
  });
  if (!access) throw new CheckoutAuthorizationError("Booking summary is not available.");
  const sessionId = access.eventSession.id;
  const [confirmedBookingCount, bookedSeatCount, gross, paidUnfulfilledReviewCount] =
    await Promise.all([
      database.booking.count({ where: { sessionId, status: "CONFIRMED" } }),
      database.bookingSeat.count({ where: { sessionId } }),
      database.booking.groupBy({
        by: ["currency"],
        where: { sessionId, status: "CONFIRMED" },
        _sum: { totalMinor: true },
        orderBy: { currency: "asc" },
      }),
      database.checkoutOrder.count({
        where: {
          sessionId,
          paidAt: { not: null },
          status: { in: ["PAID_UNFULFILLED", "REQUIRES_REVIEW"] },
        },
      }),
    ]);
  return {
    confirmedBookingCount,
    bookedSeatCount,
    grossByCurrency: gross.map((entry) => ({
      currency: entry.currency,
      totalMinor: entry._sum.totalMinor ?? 0,
    })),
    paidUnfulfilledReviewCount,
  };
}

