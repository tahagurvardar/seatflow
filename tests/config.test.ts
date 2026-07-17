import { describe, expect, it } from "vitest";

import {
  CURRENCY_VALUES,
  EVENT_CATEGORIES,
  MEMBERSHIP_ROLE_VALUES,
  NAVIGATION,
  ORGANIZATION_KIND_VALUES,
  PLATFORM_ROLE_DEFINITIONS,
  PLATFORM_ROLE_VALUES,
  PROTECTED_ROUTES,
  PUBLIC_ROUTES,
  ROUTES,
} from "@/config/site";

describe("application configuration", () => {
  it("keeps each role and event category unique", () => {
    expect(new Set(PLATFORM_ROLE_VALUES).size).toBe(PLATFORM_ROLE_VALUES.length);
    expect(new Set(PLATFORM_ROLE_DEFINITIONS.map((role) => role.id))).toEqual(
      new Set(PLATFORM_ROLE_VALUES),
    );
    expect(new Set(ORGANIZATION_KIND_VALUES).size).toBe(
      ORGANIZATION_KIND_VALUES.length,
    );
    expect(new Set(MEMBERSHIP_ROLE_VALUES).size).toBe(
      MEMBERSHIP_ROLE_VALUES.length,
    );
    expect(new Set(EVENT_CATEGORIES.map((category) => category.id)).size).toBe(
      EVENT_CATEGORIES.length,
    );
  });

  it("keeps public and protected routes separate", () => {
    for (const route of PROTECTED_ROUTES) {
      expect(PUBLIC_ROUTES).not.toContain(route);
    }
    expect(ROUTES.eventDetail("test-event")).toBe("/events/test-event");
  });

  it("exposes required navigation and currency choices", () => {
    expect(NAVIGATION.map((item) => item.label)).toEqual([
      "Discover Events",
      "Categories",
      "For Organizers",
    ]);
    expect(CURRENCY_VALUES).toEqual(["AZN", "EUR", "GBP", "USD"]);
  });
});
