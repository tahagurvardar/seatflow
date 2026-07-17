import { describe, expect, it } from "vitest";

import {
  canCloneSeatMap,
  canEditSeatMap,
  canPublishSeatMap,
} from "@/features/seat-maps/lifecycle";
import {
  generateRowLabels,
  generateSeatLabels,
} from "@/features/seat-maps/row-labels";
import { bulkSeatGenerationSchema } from "@/features/seat-maps/schema";
import {
  createResourceSlug,
  spaceInputSchema,
  venueInputSchema,
} from "@/features/venues/schema";

const validGeneration = {
  startRowLabel: "A",
  rowCount: 2,
  seatsPerRow: 10,
  startSeatNumber: 1,
  horizontalSpacing: 40,
  verticalSpacing: 40,
};

describe("venue and space validation", () => {
  it("normalizes venue identity, address, country, and optional values", () => {
    expect(createResourceSlug("  Théâtre & Hall  ")).toBe("theatre-hall");
    expect(
      venueInputSchema.parse({
        name: "  Main   Hall ",
        slug: "",
        description: "",
        addressLine1: "  1   Promenade Avenue ",
        addressLine2: "",
        city: " Baku ",
        countryCode: "az",
        postalCode: "",
        timeZone: "Asia/Baku",
        status: "ACTIVE",
      }),
    ).toEqual({
      name: "Main Hall",
      description: undefined,
      addressLine1: "1 Promenade Avenue",
      addressLine2: undefined,
      city: "Baku",
      countryCode: "AZ",
      postalCode: undefined,
      timeZone: "Asia/Baku",
      status: "ACTIVE",
    });
  });

  it("rejects malformed country codes, time zones, and archived form input", () => {
    const baseVenue = {
      name: "Main Hall",
      addressLine1: "1 Promenade Avenue",
      city: "Baku",
      countryCode: "AZ",
      timeZone: "Asia/Baku",
      status: "ACTIVE",
    };

    expect(
      venueInputSchema.safeParse({ ...baseVenue, countryCode: "AZE" }).success,
    ).toBe(false);
    expect(
      venueInputSchema.safeParse({ ...baseVenue, timeZone: "Baku/Local" })
        .success,
    ).toBe(false);
    expect(
      venueInputSchema.safeParse({ ...baseVenue, status: "ARCHIVED" }).success,
    ).toBe(false);
    expect(
      spaceInputSchema.safeParse({
        name: "Main",
        type: "BALLROOM",
        status: "ACTIVE",
      }).success,
    ).toBe(false);
  });
});

describe("seat-map generation validation", () => {
  it("generates stable row and numeric seat labels", () => {
    expect(generateRowLabels("Z", 3)).toEqual(["Z", "AA", "AB"]);
    expect(generateSeatLabels(98, 3)).toEqual(["98", "99", "100"]);
  });

  it("rejects label overflow and coordinate overflow before persistence", () => {
    expect(
      bulkSeatGenerationSchema.safeParse({
        ...validGeneration,
        startRowLabel: "ZZZ",
        rowCount: 2,
      }).success,
    ).toBe(false);
    expect(
      bulkSeatGenerationSchema.safeParse({
        ...validGeneration,
        startSeatNumber: 9_995,
      }).success,
    ).toBe(false);
    expect(
      bulkSeatGenerationSchema.safeParse({
        ...validGeneration,
        seatsPerRow: 80,
        horizontalSpacing: 200,
      }).success,
    ).toBe(false);
  });
});

describe("seat-map lifecycle decisions", () => {
  it("allows only operational drafts to be edited or published", () => {
    const draft = {
      seatMapStatus: "DRAFT" as const,
      spaceStatus: "ACTIVE" as const,
      venueStatus: "ACTIVE" as const,
    };

    expect(canEditSeatMap(draft)).toBe(true);
    expect(canPublishSeatMap(draft)).toBe(true);
    expect(canEditSeatMap({ ...draft, venueStatus: "ARCHIVED" })).toBe(false);
    expect(canPublishSeatMap({ ...draft, spaceStatus: "ARCHIVED" })).toBe(false);
  });

  it("clones only a current published map with operational parents", () => {
    const published = {
      seatMapStatus: "PUBLISHED" as const,
      spaceStatus: "ACTIVE" as const,
      venueStatus: "ACTIVE" as const,
    };

    expect(canCloneSeatMap(published)).toBe(true);
    expect(canCloneSeatMap({ ...published, seatMapStatus: "ARCHIVED" })).toBe(
      false,
    );
    expect(canCloneSeatMap({ ...published, spaceStatus: "ARCHIVED" })).toBe(
      false,
    );
  });
});
