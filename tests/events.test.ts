import { describe, expect, it } from "vitest";

import { events } from "@/data/events";
import { filterEvents, getEventBySlug } from "@/lib/events";

describe("event lookup", () => {
  it("finds an event by its public slug", () => {
    expect(getEventBySlug("aurora-room-sessions", events)?.title).toBe(
      "Aurora Room Sessions",
    );
  });

  it("returns undefined for an invalid event slug", () => {
    expect(getEventBySlug("event-that-does-not-exist", events)).toBeUndefined();
  });
});

describe("event filtering", () => {
  it("searches across useful event and location fields", () => {
    const result = filterEvents(events, {
      query: "stone hall",
      category: "all",
      city: "all",
      sort: "date-asc",
    });

    expect(result.map((event) => event.slug)).toEqual(["aurora-room-sessions"]);
  });

  it("combines category and city filters", () => {
    const result = filterEvents(events, {
      query: "",
      category: "cinema",
      city: "Berlin",
      sort: "date-asc",
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.category).toBe("cinema");
    expect(result[0]?.city).toBe("Berlin");
  });

  it("sorts results by price without mutating the fixture order", () => {
    const originalFirstId = events[0]?.id;
    const result = filterEvents(events, {
      query: "",
      category: "all",
      city: "all",
      sort: "price-asc",
    });

    expect(result[0]?.minimumPrice).toBe(16);
    expect(events[0]?.id).toBe(originalFirstId);
  });

  it("returns an empty list when no event matches", () => {
    const result = filterEvents(events, {
      query: "deep sea opera",
      category: "all",
      city: "all",
      sort: "date-asc",
    });

    expect(result).toEqual([]);
  });
});
