"use client";

import { useMemo, useState } from "react";

import { EventCard } from "@/components/events/event-card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { fieldControlStyles } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import {
  EVENT_CATEGORIES,
  type EventCategory,
} from "@/config/site";
import type { Event, EventFilters, EventSort } from "@/domain/event";
import { filterEvents } from "@/lib/events";

interface EventCatalogueProps {
  events: readonly Event[];
  initialQuery?: string;
  initialCategory?: EventCategory | "all";
  initialCity?: string;
}

export function EventCatalogue({
  events,
  initialQuery = "",
  initialCategory = "all",
  initialCity = "all",
}: EventCatalogueProps) {
  const [filters, setFilters] = useState<EventFilters>({
    query: initialQuery,
    category: initialCategory,
    city: initialCity,
    sort: "date-asc",
  });

  const cities = useMemo(
    () => [...new Set(events.map((event) => event.city))].sort(),
    [events],
  );
  const filteredEvents = useMemo(
    () => filterEvents(events, filters),
    [events, filters],
  );

  const updateFilter = <Key extends keyof EventFilters,>(
    key: Key,
    value: EventFilters[Key],
  ) => setFilters((current) => ({ ...current, [key]: value }));

  const resetFilters = () =>
    setFilters({ query: "", category: "all", city: "all", sort: "date-asc" });

  return (
    <div>
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_1fr_1fr_1fr]">
          <label>
            <span className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-500">
              Search events
            </span>
            <span className="relative block">
              <Icon
                name="search"
                className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-slate-400"
              />
              <input
                type="search"
                value={filters.query}
                onChange={(event) => updateFilter("query", event.target.value)}
                className={`${fieldControlStyles} pl-10`}
                placeholder="Artist, venue, city…"
              />
            </span>
          </label>
          <label>
            <span className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-500">
              Category
            </span>
            <select
              className={fieldControlStyles}
              value={filters.category}
              onChange={(event) =>
                updateFilter(
                  "category",
                  event.target.value as EventCategory | "all",
                )
              }
            >
              <option value="all">All categories</option>
              {EVENT_CATEGORIES.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-500">
              City
            </span>
            <select
              className={fieldControlStyles}
              value={filters.city}
              onChange={(event) => updateFilter("city", event.target.value)}
            >
              <option value="all">All cities</option>
              {cities.map((city) => (
                <option key={city} value={city}>
                  {city}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-500">
              Sort by
            </span>
            <select
              className={fieldControlStyles}
              value={filters.sort}
              onChange={(event) =>
                updateFilter("sort", event.target.value as EventSort)
              }
            >
              <option value="date-asc">Soonest first</option>
              <option value="price-asc">Price: low to high</option>
              <option value="price-desc">Price: high to low</option>
            </select>
          </label>
        </div>
      </div>

      <div className="mt-8 flex items-center justify-between gap-4">
        <p className="text-sm text-slate-600" aria-live="polite">
          <strong className="font-bold text-slate-950">{filteredEvents.length}</strong>{" "}
          {filteredEvents.length === 1 ? "event" : "events"} found
        </p>
        {(filters.query ||
          filters.category !== "all" ||
          filters.city !== "all") && (
          <Button variant="ghost" size="sm" onClick={resetFilters}>
            Clear filters
          </Button>
        )}
      </div>

      {filteredEvents.length > 0 ? (
        <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {filteredEvents.map((event, index) => (
            <EventCard key={event.id} event={event} priority={index < 3} />
          ))}
        </div>
      ) : (
        <div className="mt-6">
          <EmptyState
            title="No events match those filters"
            description="Try a different city or category, or clear the search to see the full programme."
            action={
              <Button variant="outline" onClick={resetFilters}>
                Reset all filters
              </Button>
            }
          />
        </div>
      )}
    </div>
  );
}
