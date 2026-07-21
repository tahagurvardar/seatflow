import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EventCard } from "@/components/events/event-card";
import { SeatMapRenderer } from "@/components/seat-maps/seat-map-renderer";
import { AvailabilityBadge, Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Container, Section } from "@/components/ui/container";
import { Icon } from "@/components/ui/icon";
import { ROUTES, SITE_CONFIG } from "@/config/site";
import { formatVenueDateTime } from "@/features/events/date-time";
import { formatMinorCurrency } from "@/features/events/money";
import type { PublicEventSession } from "@/domain/event";
import { getRelatedEvents } from "@/lib/events";
import {
  getPublicEventBySlug,
  getPublicEvents,
} from "@/server/events/public-event-service";

interface EventDetailPageProps {
  params: Promise<{ slug: string }>;
}

export const dynamic = "force-dynamic";

// A session is sellable when it is on sale and the current server time is within
// its sales window and before it starts. Seat availability itself is confirmed
// on the seat-selection page and when the hold is created.
function isSessionSellableNow(session: PublicEventSession, now: Date) {
  return (
    session.availability === "on-sale" &&
    new Date(session.salesStartDate) <= now &&
    now < new Date(session.salesEndDate) &&
    now < new Date(session.startDate)
  );
}

function sessionUnavailableReason(session: PublicEventSession, now: Date) {
  if (now >= new Date(session.startDate)) return "This session has started.";
  if (now >= new Date(session.salesEndDate)) return "Sales have closed.";
  if (session.availability === "sales-paused") return "Sales are paused.";
  return "Not on sale yet.";
}

export async function generateMetadata({
  params,
}: EventDetailPageProps): Promise<Metadata> {
  const { slug } = await params;
  const event = await getPublicEventBySlug(slug);

  if (!event) return { title: "Event not found" };

  return {
    title: event.title,
    description: event.shortDescription,
    openGraph: {
      title: `${event.title} | ${SITE_CONFIG.name}`,
      description: event.shortDescription,
      images: [{ url: event.image.src, alt: event.image.alt }],
    },
  };
}

export default async function EventDetailPage({ params }: EventDetailPageProps) {
  const { slug } = await params;
  const [event, allEvents] = await Promise.all([
    getPublicEventBySlug(slug),
    getPublicEvents(),
  ]);
  if (!event) notFound();

  const firstSession = event.sessions[0];
  if (!firstSession) notFound();
  const relatedEvents = getRelatedEvents(event, allEvents);
  const now = new Date();
  const primarySellableSession = event.sessions.find((session) =>
    isSessionSellableNow(session, now),
  );

  return (
    <>
      <section className="bg-slate-950 text-white">
        <Container className="grid gap-10 py-8 sm:py-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center lg:py-14">
          <div className="order-2 lg:order-1">
            <Link
              href={ROUTES.events}
              className="inline-flex items-center gap-2 rounded-lg text-sm font-semibold text-slate-400 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
            >
              <span aria-hidden="true">←</span> Back to all events
            </Link>
            <div className="mt-8 flex flex-wrap items-center gap-2">
              <Badge className="bg-white/10 text-white ring-white/15">
                {event.category}
              </Badge>
              <AvailabilityBadge status={event.availability} />
            </div>
            <h1 className="mt-5 max-w-3xl text-4xl font-black leading-[1.02] tracking-[-0.055em] sm:text-5xl lg:text-6xl">
              {event.title}
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-slate-300">
              {event.shortDescription}
            </p>
            <dl className="mt-8 grid gap-4 text-sm sm:grid-cols-2">
              <div className="flex gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
                <Icon name="calendar" className="mt-0.5 size-5 shrink-0 text-orange-400" />
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Next session
                  </dt>
                  <dd className="mt-1 font-semibold text-white">
                    {formatVenueDateTime(firstSession.startDate, firstSession.timeZone)}
                  </dd>
                </div>
              </div>
              <div className="flex gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
                <Icon name="map-pin" className="mt-0.5 size-5 shrink-0 text-orange-400" />
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Venue and space
                  </dt>
                  <dd className="mt-1 font-semibold text-white">
                    {event.venue} · {event.space}, {event.city}
                  </dd>
                </div>
              </div>
            </dl>
          </div>
          <div className="order-1 lg:order-2">
            <div className="relative aspect-[4/3] overflow-hidden rounded-[2rem] border border-white/10 bg-slate-900 shadow-2xl shadow-black/30">
              <Image
                src={event.image.src}
                alt={event.image.alt}
                fill
                priority
                sizes="(min-width: 1024px) 44vw, 100vw"
                className="object-cover"
              />
            </div>
          </div>
        </Container>
      </section>

      <Section>
        <Container className="grid gap-12 lg:grid-cols-[1fr_22rem] lg:items-start">
          <article>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-orange-600">
              About this event
            </p>
            <h2 className="mt-3 text-3xl font-black tracking-[-0.04em] text-slate-950">
              Published by {event.organizer}
            </h2>
            <p className="mt-6 max-w-3xl whitespace-pre-line text-base leading-8 text-slate-600">
              {event.description}
            </p>

            <section className="mt-12" aria-labelledby="sessions-heading">
              <h2 id="sessions-heading" className="text-2xl font-black text-slate-950">
                Upcoming sessions
              </h2>
              <div className="mt-5 space-y-4">
                {event.sessions.map((session) => {
                  const sellable = isSessionSellableNow(session, now);
                  return (
                    <article key={session.id} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <p className="font-bold text-slate-950">
                            {formatVenueDateTime(session.startDate, session.timeZone)}
                          </p>
                          <p className="mt-1 text-sm text-slate-600">
                            {session.venue} · {session.space} · {session.city}
                          </p>
                          <p className="mt-2 text-xs text-slate-500">
                            {session.sellableCapacity} configured sellable seats · exact map v{session.seatMap.version}
                          </p>
                        </div>
                        <div className="sm:text-right">
                          <AvailabilityBadge status={session.availability} />
                          <p className="mt-2 font-black text-slate-950">
                            From {formatMinorCurrency(session.minimumPriceMinor, session.currency)}
                          </p>
                        </div>
                      </div>
                      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
                        {sellable ? (
                          <>
                            <span className="text-xs font-semibold text-emerald-700">
                              Seats can be held now
                            </span>
                            <Link
                              href={ROUTES.eventSessionSeats(event.slug, session.id)}
                              className={buttonStyles({ size: "sm" })}
                            >
                              <Icon name="ticket" className="size-4" />
                              Select seats
                            </Link>
                          </>
                        ) : (
                          <span className="text-xs font-semibold text-slate-500">
                            {sessionUnavailableReason(session, now)}
                          </span>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          </article>

          <aside className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-950/5 lg:sticky lg:top-24">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
              Configured from
            </p>
            <p className="mt-2 text-3xl font-black tracking-tight text-slate-950">
              {formatMinorCurrency(event.minimumPriceMinor, event.currency)}
            </p>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Prices and section coverage are persisted. Choose seats to place a
              temporary hold, then complete a simulated checkout — no real
              payment is taken.
            </p>
            {primarySellableSession ? (
              <Link
                href={ROUTES.eventSessionSeats(event.slug, primarySellableSession.id)}
                aria-describedby="seat-selection-note"
                className={buttonStyles({ size: "lg", className: "mt-6 w-full" })}
              >
                <Icon name="ticket" className="size-4" />
                Select seats
              </Link>
            ) : (
              <button
                type="button"
                disabled
                aria-describedby="seat-selection-note"
                className={buttonStyles({ size: "lg", className: "mt-6 w-full" })}
              >
                <Icon name="ticket" className="size-4" />
                Not on sale right now
              </button>
            )}
            <div id="seat-selection-note" className="mt-4 rounded-2xl bg-amber-50 p-4 text-xs leading-5 text-amber-900">
              Holding seats reserves them for a short time. Checkout is simulated —
              no real payment is taken — and a confirmed booking issues secure
              digital tickets.
            </div>
          </aside>
        </Container>
      </Section>

      <Section className="border-t border-slate-200 bg-white">
        <Container>
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-orange-600">
              Read-only layout
            </p>
            <h2 className="mt-3 text-3xl font-black tracking-[-0.04em] text-slate-950">
              {firstSession.seatMap.name} · version {firstSession.seatMap.version}
            </h2>
            <p className="mt-3 text-sm text-slate-600">
              This is the immutable published map bound to the next session. It is a preview, not a seat picker.
            </p>
          </div>
          <div className="mt-8">
            <SeatMapRenderer sections={firstSession.seatMap.sections} />
          </div>
        </Container>
      </Section>

      {relatedEvents.length > 0 ? (
        <Section className="border-t border-slate-200">
          <Container>
            <h2 className="text-3xl font-black tracking-[-0.04em] text-slate-950">
              You might also like
            </h2>
            <div className="mt-9 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {relatedEvents.map((relatedEvent) => (
                <EventCard key={relatedEvent.id} event={relatedEvent} />
              ))}
            </div>
          </Container>
        </Section>
      ) : null}
    </>
  );
}
