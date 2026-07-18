import { describe, expect, it } from "vitest";

import { evaluateSessionSalesEligibility } from "@/features/holds/eligibility";
import { seatSelectionsMatch } from "@/features/holds/idempotency";
import {
  computeSessionInventoryRows,
  countSelectionStates,
  mapSeatSelectionSections,
} from "@/features/holds/inventory";
import {
  canReleaseHold,
  holdSecondsRemaining,
  isHoldExpired,
  isHoldLive,
  isTerminalHoldStatus,
} from "@/features/holds/lifecycle";
import { holdCreateInputSchema } from "@/features/holds/schema";
import { calculateHoldTotal } from "@/features/holds/totals";
import {
  toCustomerHoldView,
  toOrganizerInventorySummary,
} from "@/features/holds/view-models";

const NOW = new Date("2035-05-01T12:00:00.000Z");

function eligibleSession() {
  return {
    eventStatus: "PUBLISHED" as const,
    sessionStatus: "ON_SALE" as const,
    sessionStartAt: new Date("2035-05-01T20:00:00.000Z"),
    salesStartAt: new Date("2035-05-01T10:00:00.000Z"),
    salesEndAt: new Date("2035-05-01T19:00:00.000Z"),
    hasInventory: true,
    now: NOW,
  };
}

describe("Phase 4A session sales eligibility", () => {
  it("allows an on-sale published session inside its sales window", () => {
    expect(evaluateSessionSalesEligibility(eligibleSession())).toEqual({
      sellable: true,
    });
  });

  it("uses half-open sales boundaries", () => {
    const base = eligibleSession();
    expect(
      evaluateSessionSalesEligibility({ ...base, now: base.salesStartAt }),
    ).toEqual({ sellable: true });
    expect(
      evaluateSessionSalesEligibility({
        ...base,
        now: new Date(base.salesStartAt.getTime() - 1),
      }),
    ).toMatchObject({ sellable: false, reason: "SALES_NOT_STARTED" });
    expect(
      evaluateSessionSalesEligibility({ ...base, now: base.salesEndAt }),
    ).toMatchObject({ sellable: false, reason: "SALES_ENDED" });
  });

  it("rejects the session-start boundary even if the sales window extends later", () => {
    const base = eligibleSession();
    expect(
      evaluateSessionSalesEligibility({
        ...base,
        salesEndAt: new Date("2035-05-01T21:00:00.000Z"),
        now: base.sessionStartAt,
      }),
    ).toMatchObject({ sellable: false, reason: "SESSION_STARTED" });
  });

  it.each([
    [{ eventStatus: "CANCELLED" as const }, "EVENT_UNAVAILABLE"],
    [{ sessionStatus: "CANCELLED" as const }, "SESSION_CANCELLED"],
    [{ sessionStatus: "COMPLETED" as const }, "SESSION_COMPLETED"],
    [{ sessionStatus: "SALES_PAUSED" as const }, "SALES_NOT_OPEN"],
    [{ hasInventory: false }, "NO_INVENTORY"],
  ])("returns a stable block reason for %o", (override, reason) => {
    expect(
      evaluateSessionSalesEligibility({ ...eligibleSession(), ...override }),
    ).toMatchObject({ sellable: false, reason });
  });
});

describe("Phase 4A hold lifecycle decisions", () => {
  const expiresAt = new Date("2035-05-01T12:10:00.000Z");

  it("treats expiry as a server-authoritative inclusive boundary", () => {
    expect(
      isHoldLive({
        status: "ACTIVE",
        expiresAt,
        now: new Date(expiresAt.getTime() - 1),
      }),
    ).toBe(true);
    expect(isHoldLive({ status: "ACTIVE", expiresAt, now: expiresAt })).toBe(false);
    expect(isHoldExpired({ status: "ACTIVE", expiresAt, now: expiresAt })).toBe(true);
  });

  it("never reclassifies terminal holds as newly expired", () => {
    expect(isHoldExpired({ status: "RELEASED", expiresAt, now: expiresAt })).toBe(false);
    expect(isHoldExpired({ status: "EXPIRED", expiresAt, now: expiresAt })).toBe(false);
    expect(canReleaseHold("ACTIVE")).toBe(true);
    expect(canReleaseHold("RELEASED")).toBe(false);
    expect(isTerminalHoldStatus("RELEASED")).toBe(true);
    expect(isTerminalHoldStatus("EXPIRED")).toBe(true);
    expect(isTerminalHoldStatus("ACTIVE")).toBe(false);
  });

  it("floors informational seconds and clamps them at zero", () => {
    expect(
      holdSecondsRemaining({
        status: "ACTIVE",
        expiresAt,
        now: new Date(expiresAt.getTime() - 1_999),
      }),
    ).toBe(1);
    expect(
      holdSecondsRemaining({
        status: "ACTIVE",
        expiresAt,
        now: new Date(expiresAt.getTime() + 1),
      }),
    ).toBe(0);
    expect(
      holdSecondsRemaining({ status: "RELEASED", expiresAt, now: NOW }),
    ).toBe(0);
  });
});

describe("Phase 4A hold validation, totals, and idempotency", () => {
  const input = {
    sessionId: "session-1",
    idempotencyKey: "idem-12345678",
  };

  it("accepts the configured maximum and rejects one seat beyond it", () => {
    const schema = holdCreateInputSchema(8);
    expect(
      schema.safeParse({
        ...input,
        seatIds: Array.from({ length: 8 }, (_, index) => `seat-${index}`),
      }).success,
    ).toBe(true);
    const tooMany = schema.safeParse({
      ...input,
      seatIds: Array.from({ length: 9 }, (_, index) => `seat-${index}`),
    });
    expect(tooMany.success).toBe(false);
    if (!tooMany.success) {
      expect(tooMany.error.issues[0]?.message).toMatch(/at most 8 seats/i);
    }
  });

  it("rejects duplicate selected seats", () => {
    const result = holdCreateInputSchema(8).safeParse({
      ...input,
      seatIds: ["seat-1", "seat-1"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => /duplicate/i.test(issue.message))).toBe(
        true,
      );
    }
  });

  it("calculates official totals with integer minor units", () => {
    expect(
      calculateHoldTotal([
        { priceMinor: 1_005, currency: "AZN" },
        { priceMinor: 2_500, currency: "AZN" },
        { priceMinor: 0, currency: "AZN" },
      ]),
    ).toEqual({ totalMinor: 3_505, currency: "AZN", seatCount: 3 });
  });

  it("rejects empty, mixed-currency, negative, and fractional totals", () => {
    expect(() => calculateHoldTotal([])).toThrow(/at least one seat/i);
    expect(() =>
      calculateHoldTotal([
        { priceMinor: 100, currency: "AZN" },
        { priceMinor: 100, currency: "EUR" },
      ]),
    ).toThrow(/mix currencies/i);
    expect(() =>
      calculateHoldTotal([{ priceMinor: -1, currency: "AZN" }]),
    ).toThrow(/non-negative integer/i);
    expect(() =>
      calculateHoldTotal([{ priceMinor: 1.5, currency: "AZN" }]),
    ).toThrow(/non-negative integer/i);
  });

  it("compares idempotency seat sets without depending on order", () => {
    expect(seatSelectionsMatch(["seat-1", "seat-2"], ["seat-2", "seat-1"])).toBe(
      true,
    );
    expect(seatSelectionsMatch(["seat-1", "seat-2"], ["seat-1"])).toBe(false);
  });

  it("detects an idempotency payload mismatch even at equal length", () => {
    expect(seatSelectionsMatch(["seat-1", "seat-2"], ["seat-1", "seat-3"])).toBe(
      false,
    );
  });
});

describe("Phase 4A inventory derivation and customer view state", () => {
  it("materializes exactly the priced active capacity with immutable snapshots", () => {
    const rows = computeSessionInventoryRows({
      sections: [
        {
          id: "main",
          rows: [
            {
              seats: [
                { id: "seat-1", state: "ACTIVE" },
                { id: "seat-2", state: "BLOCKED" },
                { id: "seat-3", state: "ACTIVE" },
              ],
            },
          ],
        },
        {
          id: "unpriced",
          rows: [{ seats: [{ id: "seat-4", state: "ACTIVE" }] }],
        },
      ],
      priceTiers: [
        { id: "tier-1", priceMinor: 2_500, currency: "AZN" },
      ],
      sectionPricing: [{ sectionId: "main", priceTierId: "tier-1" }],
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.seatId)).toEqual(["seat-1", "seat-3"]);
    expect(rows.every((row) => row.priceMinor === 2_500 && row.currency === "AZN"))
      .toBe(true);
  });

  it("maps availability without exposing another customer's hold or price", () => {
    const sections = mapSeatSelectionSections(
      [
        {
          id: "main",
          name: "Main",
          code: "MAIN",
          rows: [
            {
              id: "row-a",
              label: "A",
              seats: [
                { id: "available", label: "1", x: 0, y: 0, type: "STANDARD", state: "ACTIVE" },
                { id: "mine", label: "2", x: 40, y: 0, type: "PREMIUM", state: "ACTIVE" },
                { id: "blocked", label: "3", x: 80, y: 0, type: "ACCESSIBLE", state: "BLOCKED" },
                { id: "other", label: "4", x: 120, y: 0, type: "COMPANION", state: "ACTIVE" },
                { id: "missing", label: "5", x: 160, y: 0, type: "STANDARD", state: "ACTIVE" },
              ],
            },
          ],
        },
      ],
      [
        { seatId: "available", state: "AVAILABLE", currentHoldId: null, priceMinor: 1_000, currency: "AZN" },
        { seatId: "mine", state: "HELD", currentHoldId: "hold-mine", priceMinor: 2_000, currency: "AZN" },
        { seatId: "blocked", state: "AVAILABLE", currentHoldId: null, priceMinor: 3_000, currency: "AZN" },
        { seatId: "other", state: "HELD", currentHoldId: "hold-other", priceMinor: 4_000, currency: "AZN" },
      ],
      "hold-mine",
    );

    const seats = sections[0]!.rows[0]!.seats;
    expect(seats.map((seat) => seat.state)).toEqual([
      "AVAILABLE",
      "HELD_BY_YOU",
      "BLOCKED",
      "UNAVAILABLE",
      "UNAVAILABLE",
    ]);
    expect(seats[0]).toMatchObject({ priceMinor: 1_000, currency: "AZN" });
    expect(seats[1]).toMatchObject({ priceMinor: 2_000, currency: "AZN" });
    expect(seats[2]).toMatchObject({ priceMinor: null, currency: null });
    expect(seats[3]).toMatchObject({ priceMinor: null, currency: null });
    expect(seats[3]).not.toHaveProperty("currentHoldId");
    expect(countSelectionStates(sections)).toEqual({
      total: 5,
      available: 1,
      heldByYou: 1,
      blocked: 1,
      unavailable: 2,
    });
  });
});

describe("Phase 4A safe public view models", () => {
  it("builds an owner-facing hold view with sorted seats and no internal identity", () => {
    const view = toCustomerHoldView({
      publicToken: "public-token-with-enough-entropy",
      status: "ACTIVE",
      expiresAt: new Date("2035-05-01T12:10:00.000Z"),
      createdAt: new Date("2035-05-01T12:00:00.000Z"),
      releasedAt: null,
      expiredAt: null,
      event: { title: "Aurora", publicSlug: "aurora" },
      session: {
        id: "session-1",
        startAt: new Date("2035-05-01T20:00:00.000Z"),
        timeZone: "Asia/Baku",
        venueName: "North Hall",
        spaceName: "Main",
        city: "Baku",
      },
      items: [
        { sectionName: "Main", sectionCode: "MAIN", rowLabel: "B", seatLabel: "10", seatType: "STANDARD", priceMinor: 2_500, currency: "AZN" },
        { sectionName: "Main", sectionCode: "MAIN", rowLabel: "A", seatLabel: "2", seatType: "PREMIUM", priceMinor: 4_000, currency: "AZN" },
      ],
      now: NOW,
    });

    expect(view).toMatchObject({
      publicToken: "public-token-with-enough-entropy",
      live: true,
      expired: false,
      totalMinor: 6_500,
      currency: "AZN",
      seatCount: 2,
    });
    expect(view.seats.map((seat) => `${seat.rowLabel}-${seat.seatLabel}`)).toEqual([
      "A-2",
      "B-10",
    ]);
    expect(view).not.toHaveProperty("id");
    expect(view).not.toHaveProperty("userId");
    expect(view).not.toHaveProperty("idempotencyKey");
    expect(JSON.stringify(view)).not.toContain("hold-mine");
  });

  it("creates an aggregate-only organizer inventory summary", () => {
    const summary = toOrganizerInventorySummary({
      total: 20,
      available: 14,
      held: 6,
      activeHolds: 3,
      earliestHoldExpiresAt: new Date("2035-05-01T12:10:00.000Z"),
    });
    expect(summary).toEqual({
      total: 20,
      available: 14,
      held: 6,
      activeHolds: 3,
      earliestHoldExpiresAt: "2035-05-01T12:10:00.000Z",
    });
    expect(summary).not.toHaveProperty("userId");
    expect(summary).not.toHaveProperty("publicToken");
  });
});
