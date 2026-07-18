import type { Metadata } from "next";

import { EventCatalogue } from "@/components/events/event-catalogue";
import { Container } from "@/components/ui/container";
import {
  EVENT_CATEGORY_VALUES,
  type EventCategory,
} from "@/config/site";
import { getPublicEvents } from "@/server/events/public-event-service";

export const metadata: Metadata = {
  title: "Discover Events",
  description:
    "Browse SeatFlow's published events and validated upcoming sessions across music, cinema, theatre, and sport.",
};

interface EventsPageProps {
  searchParams: Promise<{
    q?: string | string[];
    category?: string | string[];
    city?: string | string[];
  }>;
}

function firstValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function EventsPage({ searchParams }: EventsPageProps) {
  const params = await searchParams;
  const events = await getPublicEvents();
  const query = firstValue(params.q);
  const categoryParam = firstValue(params.category);
  const category = EVENT_CATEGORY_VALUES.includes(
    categoryParam as EventCategory,
  )
    ? (categoryParam as EventCategory)
    : "all";
  const cityParam = firstValue(params.city);
  const initialCity =
    events.find(
      (event) => event.city.toLocaleLowerCase() === cityParam.toLocaleLowerCase(),
    )?.city ?? "all";

  return (
    <div className="pb-20 sm:pb-24">
      <section className="border-b border-slate-200 bg-white">
        <Container className="py-14 sm:py-18">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-orange-600">
            The programme
          </p>
          <h1 className="mt-3 max-w-3xl text-4xl font-black tracking-[-0.055em] text-slate-950 sm:text-5xl">
            Find something worth showing up for.
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-slate-600">
            Explore database-backed published events and their earliest validated
            upcoming sessions. Eligible sessions link to temporary seat holds;
            checkout and booking are not available yet.
          </p>
        </Container>
      </section>
      <Container className="pt-8 sm:pt-10">
        <EventCatalogue
          events={events}
          initialQuery={query}
          initialCategory={category}
          initialCity={initialCity}
        />
      </Container>
    </div>
  );
}
