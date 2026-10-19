import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SeatListPicker } from "../src/components/seat-selection/seat-list-picker";
import { VenueSeatMap } from "../src/components/seat-selection/venue-seat-map";
import type { SelectionPriceTierView, SelectionSectionView } from "../src/features/holds/inventory";
import { isRedundantSectionCode, sectionDisplayNames } from "../src/features/holds/selection";
import { smallMap } from "./v1-1-m5-seat-map-fixtures";

describe("Post-M5 mobile polish: section labels", () => {
  it("treats a code that only abbreviates the name as redundant", () => {
    expect(isRedundantSectionCode("VIP", "VIP")).toBe(true);
    expect(isRedundantSectionCode("Standard", "STD")).toBe(true);
    expect(isRedundantSectionCode("Front Stalls", "FS")).toBe(true);
    expect(isRedundantSectionCode("Section 1", "S1")).toBe(true);
  });

  it("keeps codes that carry information", () => {
    expect(isRedundantSectionCode("Stalls", "A")).toBe(false);
    expect(isRedundantSectionCode("Balcony", "B2")).toBe(false);
    expect(isRedundantSectionCode("VIP", "VIPX")).toBe(false);
  });

  it("shows the code when names repeat, so sections stay distinguishable", () => {
    const names = sectionDisplayNames([
      { id: "a", name: "VIP", code: "VIP" },
      { id: "b", name: "Standard", code: "STD" },
      { id: "c", name: "Balcony", code: "B" },
      { id: "d", name: "Balcony", code: "BA" },
      { id: "e", name: "Stalls", code: "A" },
    ]);
    expect([...names.values()]).toEqual([
      "VIP",
      "Standard",
      "Balcony (B)",
      "Balcony (BA)",
      "Stalls (A)",
    ]);
  });

  it("does not repeat a redundant code in map headings or section pickers", () => {
    const sections = smallMap();
    const { container } = render(
      <>
        <VenueSeatMap sections={sections} selectedSeatIds={[]} maxSeats={4} onToggleSeat={() => {}} />
        <SeatListPicker sections={sections} selectedSeatIds={[]} maxSeats={4} onToggleSeat={() => {}} />
      </>,
    );
    expect(container.textContent).not.toMatch(/Stalls\s*\(?ST\b/);
    expect(screen.getByRole("option", { name: "Stalls" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^Stalls — \d+ available$/ })).toBeInTheDocument();
  });
});

describe("Post-M5 mobile polish: seat list labels", () => {
  it("wraps status, tier and price on their own lines instead of truncating", () => {
    const tiers: SelectionPriceTierView[] = [
      { id: "tier-long", name: "VIP Ticket With Lounge Access", code: "VIP", description: null, priceMinor: 8_000, currency: "AZN" },
    ];
    const sections: SelectionSectionView[] = smallMap().map((section) => ({
      ...section,
      rows: section.rows.map((row) => ({
        ...row,
        seats: row.seats.map((seat) => ({ ...seat, priceTierId: "tier-long", priceMinor: 8_000, currency: "AZN" as const })),
      })),
    }));
    const { container } = render(
      <SeatListPicker sections={sections} priceTiers={tiers} selectedSeatIds={[]} maxSeats={4} onToggleSeat={() => {}} />,
    );
    const button = container.querySelector<HTMLButtonElement>("button[data-list-seat-id]")!;
    expect(button.querySelector(".truncate")).toBeNull();
    expect(button.textContent).toContain("VIP Ticket With Lounge Access");
    expect(button.textContent?.replace(/ /g, " ")).toContain("AZN 80.00");
    // The accessible name still carries every detail.
    expect(button.getAttribute("aria-label")).toMatch(/VIP Ticket With Lounge Access, AZN.80\.00$/);
  });
});
