import type { Event, EventFilters } from "@/domain/event";

export function getEventBySlug(
  slug: string,
  eventList: readonly Event[] = [],
): Event | undefined {
  return eventList.find((event) => event.slug === slug);
}

export function filterEvents(
  eventList: readonly Event[],
  filters: EventFilters,
): Event[] {
  const query = filters.query.trim().toLocaleLowerCase();

  const filtered = eventList.filter((event) => {
    const searchableText = [
      event.title,
      event.shortDescription,
      event.venue,
      event.city,
      event.country,
      event.organizer,
    ]
      .join(" ")
      .toLocaleLowerCase();

    const matchesQuery = query.length === 0 || searchableText.includes(query);
    const matchesCategory =
      filters.category === "all" || event.category === filters.category;
    const matchesCity = filters.city === "all" || event.city === filters.city;

    return matchesQuery && matchesCategory && matchesCity;
  });

  return [...filtered].sort((first, second) => {
    if (filters.sort === "price-asc") {
      return first.minimumPriceMinor - second.minimumPriceMinor;
    }

    if (filters.sort === "price-desc") {
      return second.minimumPriceMinor - first.minimumPriceMinor;
    }

    return Date.parse(first.startDate) - Date.parse(second.startDate);
  });
}

export function getRelatedEvents(
  event: Event,
  eventList: readonly Event[],
  limit = 3,
): Event[] {
  return eventList
    .filter((candidate) => candidate.id !== event.id)
    .sort((first, second) => {
      const firstScore =
        Number(first.category === event.category) * 2 +
        Number(first.city === event.city);
      const secondScore =
        Number(second.category === event.category) * 2 +
        Number(second.city === event.city);

      return secondScore - firstScore;
    })
    .slice(0, limit);
}
