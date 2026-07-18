import type { Prisma } from "@/generated/prisma/client";
import type {
  Event,
  PublicEventDetail,
  PublicEventSession,
} from "@/domain/event";
import { calculatePricingCoverage } from "@/features/events/pricing";
import type { EventCategory, Currency } from "@/generated/prisma/enums";
import { getDatabase } from "@/lib/database";

const publicSessionInclude = {
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

const eventWithPublicSessionsInclude = {
  organizerOrganization: { select: { name: true } },
  sessions: {
    where: {
      status: { in: ["SCHEDULED", "ON_SALE", "SALES_PAUSED"] },
      publishedAt: { not: null },
    },
    orderBy: { startAt: "asc" },
    include: publicSessionInclude,
  },
} satisfies Prisma.EventInclude;

type PublicSessionRecord = Prisma.EventSessionGetPayload<{
  include: typeof publicSessionInclude;
}>;
type PublicEventRecord = Prisma.EventGetPayload<{
  include: typeof eventWithPublicSessionsInclude;
}>;

const categoryMap: Record<EventCategory, Event["category"]> = {
  CONCERT: "concert",
  CINEMA: "cinema",
  THEATRE: "theatre",
  SPORT: "sport",
  OTHER: "other",
};

function currencyValue(currency: Currency): Event["currency"] {
  return currency;
}

function availability(
  status: PublicSessionRecord["status"],
): Event["availability"] {
  if (status === "ON_SALE") return "on-sale";
  if (status === "SALES_PAUSED") return "sales-paused";
  return "scheduled";
}

function mapPublicSession(session: PublicSessionRecord): PublicEventSession | null {
  const coverage = calculatePricingCoverage(
    session.seatMap.sections,
    session.priceTiers,
    session.sectionPricing,
  );
  const firstTier = session.priceTiers[0];

  if (
    coverage.issues.length > 0 ||
    coverage.totalSellable <= 0 ||
    coverage.minimumPriceMinor === null ||
    !firstTier ||
    !coverage.currency
  ) {
    return null;
  }

  return {
    id: session.id,
    startDate: session.startAt.toISOString(),
    endDate: session.endAt.toISOString(),
    salesStartDate: session.salesStartAt.toISOString(),
    salesEndDate: session.salesEndAt.toISOString(),
    venue: session.venue.name,
    space: session.space.name,
    city: session.venue.city,
    country: session.venue.countryCode,
    timeZone: session.venue.timeZone,
    minimumPriceMinor: coverage.minimumPriceMinor,
    currency: currencyValue(firstTier.currency),
    availability: availability(session.status),
    sellableCapacity: coverage.totalSellable,
    seatMap: {
      id: session.seatMap.id,
      name: session.seatMap.name,
      version: session.seatMap.version,
      sections: session.seatMap.sections,
    },
  };
}

function mapPublicEvent(
  event: PublicEventRecord,
  now: Date,
): PublicEventDetail | null {
  const sessions = event.sessions
    .filter((session) => session.startAt > now)
    .map(mapPublicSession)
    .filter((session): session is PublicEventSession => session !== null);
  const firstSession = sessions[0];
  if (!firstSession) return null;

  return {
    id: event.id,
    slug: event.publicSlug,
    title: event.title,
    shortDescription: event.shortDescription,
    description: event.description,
    category: categoryMap[event.category],
    venue: firstSession.venue,
    space: firstSession.space,
    city: firstSession.city,
    country: firstSession.country,
    timeZone: firstSession.timeZone,
    startDate: firstSession.startDate,
    image: {
      src: event.imagePath ?? "/events/aurora-room.svg",
      alt: `${event.title} event artwork`,
    },
    minimumPriceMinor: firstSession.minimumPriceMinor,
    currency: firstSession.currency,
    organizer: event.organizerOrganization.name,
    availability: firstSession.availability,
    sellableCapacity: firstSession.sellableCapacity,
    sessions,
  };
}

export async function getPublicEvents(now = new Date()): Promise<Event[]> {
  const events = await getDatabase().event.findMany({
    where: {
      status: "PUBLISHED",
      sessions: {
        some: {
          status: { in: ["SCHEDULED", "ON_SALE", "SALES_PAUSED"] },
          publishedAt: { not: null },
          startAt: { gt: now },
        },
      },
    },
    include: eventWithPublicSessionsInclude,
    orderBy: { publishedAt: "desc" },
  });

  return events
    .map((event) => mapPublicEvent(event, now))
    .filter((event): event is PublicEventDetail => event !== null)
    .sort((first, second) =>
      first.startDate.localeCompare(second.startDate),
    );
}

export async function getPublicEventBySlug(
  publicSlug: string,
  now = new Date(),
) {
  const event = await getDatabase().event.findFirst({
    where: { publicSlug, status: "PUBLISHED" },
    include: eventWithPublicSessionsInclude,
  });

  return event ? mapPublicEvent(event, now) : null;
}
