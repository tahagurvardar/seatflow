import { describe, expect, it } from "vitest";

import {
  formatVenueDateTime,
  toVenueLocalInputValue,
  zonedLocalDateTimeToUtc,
} from "@/features/events/date-time";
import { sessionRangesOverlap } from "@/features/events/conflicts";
import {
  canEditEvent,
  canEditSessionPricing,
  canRestoreEvent,
} from "@/features/events/lifecycle";
import {
  formatMinorCurrency,
  parsePriceToMinorUnits,
} from "@/features/events/money";
import { calculatePricingCoverage } from "@/features/events/pricing";
import { isPubliclyEligibleSession } from "@/features/events/public-visibility";
import {
  createEventSlug,
  createPublicEventSlug,
  eventInputSchema,
  lifecycleConfirmationSchema,
  sessionDateRangeSchema,
} from "@/features/events/schema";

describe("Phase 3 event validation", () => {
  it("normalizes organizer-scoped and public event slugs", () => {
    expect(createEventSlug("  Şəhər Gecəsi: Live! ")).toBe("s-h-r-gec-si-live");
    expect(createPublicEventSlug("northstar-live", "summer-night")).toBe(
      "northstar-live--summer-night",
    );
  });

  it("normalizes valid event content and rejects unsafe image references", () => {
    const parsed = eventInputSchema.parse({
      title: "  Aurora   Room  ",
      slug: "",
      shortDescription: "  A carefully produced live performance. ",
      description:
        "A complete event description with enough useful detail for publication.",
      category: "CONCERT",
      imagePath: "/events/aurora-room.svg",
    });
    expect(parsed.title).toBe("Aurora Room");
    expect(parsed.slug).toBeUndefined();
    expect(
      eventInputSchema.safeParse({ ...parsed, imagePath: "/events/../secret.png" })
        .success,
    ).toBe(false);
  });

  it("validates session and sales windows", () => {
    const startAt = new Date("2035-05-01T18:00:00Z");
    expect(
      sessionDateRangeSchema.safeParse({
        startAt,
        endAt: new Date("2035-05-01T17:00:00Z"),
        salesStartAt: new Date("2035-04-01T00:00:00Z"),
        salesEndAt: new Date("2035-05-01T18:01:00Z"),
      }).success,
    ).toBe(false);
    expect(
      sessionDateRangeSchema.safeParse({
        startAt,
        endAt: new Date("2035-05-01T20:00:00Z"),
        salesStartAt: new Date("2035-04-01T00:00:00Z"),
        salesEndAt: startAt,
      }).success,
    ).toBe(true);
  });

  it("requires lifecycle intent and confirmation to match", () => {
    expect(
      lifecycleConfirmationSchema.safeParse({
        intent: "cancel",
        confirmation: "publish",
      }).success,
    ).toBe(false);
    expect(
      lifecycleConfirmationSchema.safeParse({
        intent: "archive",
        confirmation: "archive",
      }).success,
    ).toBe(true);
  });
});

describe("venue-local instants", () => {
  it("converts venue-local input to UTC and formats it back", () => {
    const instant = zonedLocalDateTimeToUtc("2035-05-01T20:30", "Asia/Baku");
    expect(instant.toISOString()).toBe("2035-05-01T16:30:00.000Z");
    expect(toVenueLocalInputValue(instant, "Asia/Baku")).toBe(
      "2035-05-01T20:30",
    );
    expect(formatVenueDateTime(instant, "Asia/Baku")).toMatch(/20:30/);
  });

  it("rejects a nonexistent daylight-saving local time", () => {
    expect(() =>
      zonedLocalDateTimeToUtc("2035-03-25T02:30", "Europe/Berlin"),
    ).toThrow(/does not exist/i);
  });
});

describe("minor-unit pricing and coverage", () => {
  it("converts decimal input without floating-point arithmetic", () => {
    expect(parsePriceToMinorUnits("38.05", "AZN")).toBe(3_805);
    expect(parsePriceToMinorUnits("0", "EUR")).toBe(0);
    expect(formatMinorCurrency(1_600, "EUR")).toMatch(/16\.00/);
    expect(() => parsePriceToMinorUnits("1.999", "EUR")).toThrow();
    expect(() => parsePriceToMinorUnits("-1", "EUR")).toThrow();
  });

  it("calculates priced, unpriced, blocked, tier capacity, and minimum price", () => {
    const coverage = calculatePricingCoverage(
      [
        {
          id: "main",
          name: "Main",
          code: "MAIN",
          rows: [
            {
              seats: [
                { state: "ACTIVE" as const },
                { state: "ACTIVE" as const },
                { state: "BLOCKED" as const },
              ],
            },
          ],
        },
        {
          id: "balcony",
          name: "Balcony",
          code: "BALC",
          rows: [{ seats: [{ state: "ACTIVE" as const }] }],
        },
      ],
      [
        {
          id: "standard",
          name: "Standard",
          code: "STD",
          priceMinor: 2_000,
          currency: "AZN",
        },
        {
          id: "premium",
          name: "Premium",
          code: "PREM",
          priceMinor: 4_000,
          currency: "AZN",
        },
      ],
      [{ sectionId: "main", priceTierId: "premium" }],
    );

    expect(coverage).toMatchObject({
      totalSellable: 3,
      pricedSellable: 2,
      unpricedSellable: 1,
      minimumPriceMinor: 2_000,
    });
    expect(coverage.tiers.find((tier) => tier.id === "premium")?.sellableCapacity).toBe(2);
    expect(coverage.issues).toContain(
      "Section BALC has sellable seats without a price tier.",
    );
  });
});

describe("conflicts, lifecycle, and public visibility", () => {
  it("uses half-open ranges so adjacent sessions do not overlap", () => {
    const first = {
      startAt: new Date("2035-05-01T10:00:00Z"),
      endAt: new Date("2035-05-01T12:00:00Z"),
    };
    expect(
      sessionRangesOverlap(first, {
        startAt: first.endAt,
        endAt: new Date("2035-05-01T14:00:00Z"),
      }),
    ).toBe(false);
    expect(
      sessionRangesOverlap(first, {
        startAt: new Date("2035-05-01T11:59:00Z"),
        endAt: new Date("2035-05-01T13:00:00Z"),
      }),
    ).toBe(true);
  });

  it("keeps draft editing, archive restore, and pricing immutability explicit", () => {
    expect(canEditEvent("DRAFT")).toBe(true);
    expect(canEditEvent("PUBLISHED")).toBe(false);
    expect(canRestoreEvent("ARCHIVED", "PUBLISHED")).toBe(true);
    expect(canRestoreEvent("ARCHIVED", "CANCELLED")).toBe(false);
    expect(canEditSessionPricing("DRAFT")).toBe(true);
    expect(canEditSessionPricing("ON_SALE")).toBe(false);
  });

  it("requires a published event, eligible future session, and valid pricing", () => {
    const base = {
      eventStatus: "PUBLISHED" as const,
      sessionStatus: "SCHEDULED" as const,
      sessionStartAt: new Date("2035-05-01T18:00:00Z"),
      hasValidPricing: true,
      now: new Date("2035-05-01T10:00:00Z"),
    };
    expect(isPubliclyEligibleSession(base)).toBe(true);
    expect(isPubliclyEligibleSession({ ...base, eventStatus: "DRAFT" })).toBe(false);
    expect(isPubliclyEligibleSession({ ...base, hasValidPricing: false })).toBe(false);
  });
});
