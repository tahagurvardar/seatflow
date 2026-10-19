import { describe, expect, it } from "vitest";

import {
  type InventorySnapshot,
  mapSeatSelectionSections,
  selectionPriceTiers,
} from "../src/features/holds/inventory";

const sections = [
  {
    id: "sec",
    name: "Stalls",
    code: "ST",
    rows: [
      {
        id: "row-a",
        label: "A",
        seats: [
          { id: "free", label: "1", x: 0, y: 0, type: "STANDARD" as const, state: "ACTIVE" as const },
          { id: "mine", label: "2", x: 40, y: 0, type: "STANDARD" as const, state: "ACTIVE" as const },
          { id: "other", label: "3", x: 80, y: 0, type: "PREMIUM" as const, state: "ACTIVE" as const },
          { id: "blocked", label: "4", x: 120, y: 0, type: "STANDARD" as const, state: "BLOCKED" as const },
        ],
      },
    ],
  },
];

function inventory(withTier: boolean): InventorySnapshot[] {
  const tier = (id: string) => (withTier ? { priceTierId: id } : {});
  return [
    { seatId: "free", state: "AVAILABLE", currentHoldId: null, priceMinor: 12_000, currency: "AZN", ...tier("tier-std") },
    { seatId: "mine", state: "HELD", currentHoldId: "hold-me", priceMinor: 12_000, currency: "AZN", ...tier("tier-std") },
    { seatId: "other", state: "HELD", currentHoldId: "hold-x", priceMinor: 20_000, currency: "AZN", ...tier("tier-vip") },
  ];
}

describe("M5.3 selection view: price tier per seat", () => {
  it("exposes the tier id under the same rule as the price", () => {
    const seats = mapSeatSelectionSections(sections, inventory(true), "hold-me")[0]!.rows[0]!.seats;
    expect(seats.map((seat) => [seat.seatId, seat.state, seat.priceTierId])).toEqual([
      ["free", "AVAILABLE", "tier-std"],
      ["mine", "HELD_BY_YOU", "tier-std"],
      // Another customer's hold reveals neither price nor tier.
      ["other", "UNAVAILABLE", null],
      ["blocked", "BLOCKED", undefined],
    ]);
    expect(seats[2]).toMatchObject({ priceMinor: null, currency: null });
  });

  it("keeps the previous seat shape exactly when tiers are not loaded", () => {
    const seats = mapSeatSelectionSections(sections, inventory(false), "hold-me")[0]!.rows[0]!.seats;
    for (const seat of seats) expect(seat).not.toHaveProperty("priceTierId");
    expect(seats[0]).toEqual({
      seatId: "free",
      label: "1",
      x: 0,
      y: 0,
      type: "STANDARD",
      state: "AVAILABLE",
      priceMinor: 12_000,
      currency: "AZN",
    });
  });
});

describe("M5.3 selection view: session price tiers", () => {
  const tiers = [
    { id: "tier-vip", name: "Front Stalls", code: "FRONT", description: "Rows A–C", priceMinor: 20_000, currency: "AZN" as const },
    { id: "tier-std", name: "Standard", code: "STD", description: null, priceMinor: 12_000, currency: "AZN" as const },
    { id: "tier-unused", name: "Unassigned", code: "NONE", description: null, priceMinor: 1, currency: "AZN" as const },
  ];

  it("keeps configured order and real names, and drops tiers that price no inventory", () => {
    expect(selectionPriceTiers(tiers, inventory(true))).toEqual([
      { id: "tier-vip", name: "Front Stalls", code: "FRONT", description: "Rows A–C", priceMinor: 20_000, currency: "AZN" },
      { id: "tier-std", name: "Standard", code: "STD", description: null, priceMinor: 12_000, currency: "AZN" },
    ]);
  });

  it("returns no tiers when the session has no inventory", () => {
    expect(selectionPriceTiers(tiers, [])).toEqual([]);
  });
});
