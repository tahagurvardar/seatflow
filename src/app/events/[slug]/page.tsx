import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EventCard } from "@/components/events/event-card";
import { AvailabilityBadge, Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Container, Section } from "@/components/ui/container";
import { Icon } from "@/components/ui/icon";
import { ROUTES, SITE_CONFIG } from "@/config/site";
import { events } from "@/data/events";
import {
  formatCurrency,
  formatEventDate,
  formatEventTime,
} from "@/lib/formatters";
import { getEventBySlug, getRelatedEvents } from "@/lib/events";

interface EventDetailPageProps {
  params: Promise<{ slug: string }>;
}

export const dynamicParams = false;

export function generateStaticParams() {
  return events.map((event) => ({ slug: event.slug }));
}

export async function generateMetadata({
  params,
}: EventDetailPageProps): Promise<Metadata> {
  const { slug } = await params;
  const event = getEventBySlug(slug, events);

  if (!event) {
    return { title: "Event not found" };
  }

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
  const event = getEventBySlug(slug, events);

  if (!event) {
    notFound();
  }

  const relatedEvents = getRelatedEvents(event, events);

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
                    Date & time
                  </dt>
                  <dd className="mt-1 font-semibold text-white">
                    {formatEventDate(event.startDate)} · {formatEventTime(event.startDate)}
                  </dd>
                </div>
              </div>
              <div className="flex gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
                <Icon name="map-pin" className="mt-0.5 size-5 shrink-0 text-orange-400" />
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Venue
                  </dt>
                  <dd className="mt-1 font-semibold text-white">
                    {event.venue}, {event.city}
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
              An evening built to stay with you.
            </h2>
            <p className="mt-6 max-w-3xl text-base leading-8 text-slate-600">
              {event.description}
            </p>

            <dl className="mt-10 grid gap-px overflow-hidden rounded-3xl border border-slate-200 bg-slate-200 sm:grid-cols-2">
              <div className="bg-white p-6">
                <dt className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  Presented by
                </dt>
                <dd className="mt-2 font-bold text-slate-950">{event.organizer}</dd>
              </div>
              <div className="bg-white p-6">
                <dt className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  Location
                </dt>
                <dd className="mt-2 font-bold text-slate-950">
                  {event.city}, {event.country}
                </dd>
              </div>
            </dl>
          </article>

          <aside className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-950/5 lg:sticky lg:top-24">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
              Tickets from
            </p>
            <p className="mt-2 text-3xl font-black tracking-tight text-slate-950">
              {formatCurrency(event.minimumPrice, event.currency)}
            </p>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Final pricing will depend on session, seat, and fees once booking is
              introduced.
            </p>
            <button
              type="button"
              disabled
              aria-describedby="seat-selection-note"
              className={buttonStyles({
                size: "lg",
                className: "mt-6 w-full",
              })}
            >
              <Icon name="ticket" className="size-4" />
              Seat selection — future phase
            </button>
            <div
              id="seat-selection-note"
              className="mt-4 rounded-2xl bg-amber-50 p-4 text-xs leading-5 text-amber-900"
            >
              Booking is intentionally unavailable in this foundation. No seats
              are being held and no payment will be taken.
            </div>
          </aside>
        </Container>
      </Section>

      <Section className="border-t border-slate-200 bg-white">
        <Container>
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-orange-600">
                Keep exploring
              </p>
              <h2 className="mt-3 text-3xl font-black tracking-[-0.04em] text-slate-950">
                You might also like
              </h2>
            </div>
            <Link
              href={ROUTES.events}
              className={buttonStyles({ variant: "ghost", size: "sm" })}
            >
              All events <Icon name="arrow-right" className="size-4" />
            </Link>
          </div>
          <div className="mt-9 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {relatedEvents.map((relatedEvent) => (
              <EventCard key={relatedEvent.id} event={relatedEvent} />
            ))}
          </div>
        </Container>
      </Section>
    </>
  );
}
