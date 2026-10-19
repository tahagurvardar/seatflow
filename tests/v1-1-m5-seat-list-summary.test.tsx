import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { SeatListPicker } from "../src/components/seat-selection/seat-list-picker";
import {
  holdActionLabel,
  SelectionSummary,
} from "../src/components/seat-selection/selection-summary";
import { VenueSeatMap } from "../src/components/seat-selection/venue-seat-map";
import type {
  SelectionPriceTierView,
  SelectionSeatView,
  SelectionSectionView,
} from "../src/features/holds/inventory";
import { buildSelectionSeatIndex, toggleSeatSelection } from "../src/features/holds/selection";
import { smallMap } from "./v1-1-m5-seat-map-fixtures";

const TIERS: SelectionPriceTierView[] = [
  { id: "tier-std", name: "Standard", code: "STD", description: null, priceMinor: 12_000, currency: "AZN" },
  { id: "tier-front", name: "Front Stalls", code: "FRONT", description: "Closest to the stage", priceMinor: 15_000, currency: "AZN" },
];

/** smallMap with real tier ids on every seat whose price is visible. */
function tieredMap(overrides: Partial<Record<string, Partial<SelectionSeatView>>> = {}) {
  const tiered: Partial<Record<string, Partial<SelectionSeatView>>> = {};
  for (const section of smallMap()) {
    for (const row of section.rows) {
      for (const seat of row.seats) {
        tiered[seat.seatId] = {
          priceTierId: seat.priceMinor === null ? null : seat.type === "PREMIUM" ? "tier-front" : "tier-std",
          ...overrides[seat.seatId],
        };
      }
    }
  }
  return smallMap(tiered);
}

/** Map, list and summary sharing one controlled selection, as M5.4 will. */
function SharedSelection({
  sections,
  maxSeats = 8,
  initial = [],
}: {
  sections: SelectionSectionView[];
  maxSeats?: number;
  initial?: string[];
}) {
  const [selected, setSelected] = useState<readonly string[]>(initial);
  const toggle = (seatId: string) =>
    setSelected((current) =>
      toggleSeatSelection(current, seatId, buildSelectionSeatIndex(sections), maxSeats).selected,
    );
  return (
    <>
      <VenueSeatMap sections={sections} selectedSeatIds={selected} maxSeats={maxSeats} onToggleSeat={toggle} />
      <SeatListPicker
        sections={sections}
        priceTiers={TIERS}
        selectedSeatIds={selected}
        maxSeats={maxSeats}
        onToggleSeat={toggle}
      />
      <SelectionSummary
        variant="rail"
        sections={sections}
        priceTiers={TIERS}
        selectedSeatIds={selected}
        maxSeats={maxSeats}
        onRemoveSeat={toggle}
        onClearSelection={() => setSelected([])}
      />
    </>
  );
}

/** Intl separates currency and amount with a no-break space; compare plainly. */
function plain(text: string | null) {
  return (text ?? "").replace(/\u00a0/g, " ");
}

function mapSeat(seatId: string) {
  return document.querySelector<HTMLElement>(`[data-seat-id="${seatId}"]`)!;
}

function listSeat(seatId: string) {
  return document.querySelector<HTMLElement>(`[data-list-seat-id="${seatId}"]`)!;
}

describe("M5.3 seat list picker", () => {
  it("navigates section → row → seat with real labels, types, tiers and prices", () => {
    render(
      <SeatListPicker sections={tieredMap()} priceTiers={TIERS} selectedSeatIds={[]} maxSeats={8} onToggleSeat={() => {}} />,
    );
    const section = screen.getByLabelText("Section");
    expect(within(section).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Stalls — 4 available",
      "Balcony — 2 available",
    ]);
    const row = screen.getByLabelText("Row");
    expect(within(row).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Row A — 2 available",
      "Row B — 2 available",
    ]);

    const list = screen.getByRole("list", { name: "Stalls, row A seats" });
    expect(within(list).getAllByRole("button").map((button) => plain(button.getAttribute("aria-label")))).toEqual([
      "Stalls, row A, seat 1, Available, Standard, AZN 120.00",
      "Stalls, row A, seat 2, Available, Standard, AZN 120.00",
      "Stalls, row A, seat 3, Unavailable",
    ]);

    fireEvent.change(row, { target: { value: "stalls-b" } });
    expect(plain(listSeat("st-b-2").getAttribute("aria-label"))).toBe(
      "Stalls, row B, seat 2, Available, Premium seat, Front Stalls, AZN 150.00",
    );
    expect(plain(listSeat("st-b-3").getAttribute("aria-label"))).toMatch(/Held by you, Standard, AZN 120\.00$/);

    fireEvent.change(section, { target: { value: "balcony" } });
    expect(screen.getByRole("list", { name: "Balcony, row A seats" })).toBeInTheDocument();
  });

  it("starts on the first section and row that have available seats", () => {
    const sections = tieredMap({
      "st-a-1": { state: "UNAVAILABLE", priceMinor: null, currency: null, priceTierId: null },
      "st-a-2": { state: "UNAVAILABLE", priceMinor: null, currency: null, priceTierId: null },
      "st-b-1": { state: "UNAVAILABLE", priceMinor: null, currency: null, priceTierId: null },
      "st-b-2": { state: "UNAVAILABLE", priceMinor: null, currency: null, priceTierId: null },
    });
    render(<SeatListPicker sections={sections} selectedSeatIds={[]} maxSeats={8} onToggleSeat={() => {}} />);
    expect(screen.getByLabelText("Section")).toHaveValue("balcony");
    expect(screen.getByLabelText("Row")).toHaveValue("balcony-a");
  });

  it("offers 44px targets and a single roving tab stop operated by arrows, Home and End", () => {
    render(<SeatListPicker sections={tieredMap()} selectedSeatIds={[]} maxSeats={8} onToggleSeat={() => {}} />);
    const first = listSeat("st-a-1");
    expect(first.className).toContain("min-h-11");
    expect(first.className).toContain("min-w-11");
    expect(first).toHaveAttribute("tabindex", "0");
    expect(listSeat("st-a-2")).toHaveAttribute("tabindex", "-1");

    act(() => first.focus());
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(listSeat("st-a-2"));
    expect(listSeat("st-a-2")).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(listSeat("st-a-3"));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(first);
  });

  it("refuses unavailable seats and respects maxSeats while always allowing removal", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <SeatListPicker sections={tieredMap()} selectedSeatIds={[]} maxSeats={1} onToggleSeat={onToggle} />,
    );
    const unavailable = listSeat("st-a-3");
    expect(unavailable).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(unavailable);
    expect(onToggle).not.toHaveBeenCalled();

    rerender(<SeatListPicker sections={tieredMap()} selectedSeatIds={["st-a-1"]} maxSeats={1} onToggleSeat={onToggle} />);
    expect(listSeat("st-a-2")).toHaveAttribute("aria-disabled", "true");
    expect(listSeat("st-a-2")).toHaveAccessibleName(/Selection limit reached$/);
    fireEvent.click(listSeat("st-a-2"));
    expect(onToggle).not.toHaveBeenCalled();
    fireEvent.click(listSeat("st-a-1"));
    expect(onToggle).toHaveBeenCalledWith("st-a-1");
  });

  it("never claims that selecting reserves a seat", () => {
    render(<SeatListPicker sections={tieredMap()} selectedSeatIds={["st-a-1"]} maxSeats={8} onToggleSeat={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "1 of 8 seats selected. Seats are not reserved until your hold is confirmed.",
    );
    expect(document.body.textContent).not.toMatch(/\breserved\b(?! until)|secured|you own/i);
  });
});

describe("M5.3 map, list and summary stay in sync", () => {
  it("reflects one controlled selection everywhere", () => {
    render(<SharedSelection sections={tieredMap()} />);

    fireEvent.click(listSeat("st-a-1"));
    expect(mapSeat("st-a-1")).toHaveAttribute("aria-pressed", "true");
    expect(listSeat("st-a-1")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(mapSeat("st-a-2"));
    expect(listSeat("st-a-2")).toHaveAttribute("aria-pressed", "true");

    const summary = screen.getByRole("complementary", { name: "Your selection" });
    expect(within(summary).getAllByRole("listitem", { name: undefined }).length).toBeGreaterThan(0);
    expect(within(summary).getByTestId("selection-total")).toHaveTextContent("AZN 240.00");

    fireEvent.click(within(summary).getByRole("button", { name: "Remove Stalls, row A, seat 1" }));
    expect(mapSeat("st-a-1")).toHaveAttribute("aria-pressed", "false");
    expect(listSeat("st-a-1")).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(within(summary).getByRole("button", { name: "Clear selection" }));
    expect(mapSeat("st-a-2")).toHaveAttribute("aria-pressed", "false");
    expect(within(summary).getByRole("button", { name: "Hold 0 seats" })).toBeDisabled();
  });

  it("drops seats that a refresh makes unavailable from every view via the shared rule", () => {
    function Refreshing() {
      const [sections, setSections] = useState(tieredMap());
      const [selected, setSelected] = useState<readonly string[]>(["st-a-1"]);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              const next = tieredMap({ "st-a-1": { state: "UNAVAILABLE", priceMinor: null, currency: null, priceTierId: null } });
              setSections(next);
              setSelected((current) => current.filter((id) => buildSelectionSeatIndex(next).get(id)?.seat.state === "AVAILABLE"));
            }}
          >
            refresh
          </button>
          <SeatListPicker sections={sections} selectedSeatIds={selected} maxSeats={8} onToggleSeat={() => {}} />
          <SelectionSummary
            variant="rail"
            sections={sections}
            selectedSeatIds={selected}
            maxSeats={8}
            onRemoveSeat={() => {}}
            onClearSelection={() => {}}
          />
        </>
      );
    }
    render(<Refreshing />);
    expect(listSeat("st-a-1")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    expect(listSeat("st-a-1")).toHaveAttribute("aria-pressed", "false");
    expect(listSeat("st-a-1")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("selection-total")).toHaveTextContent("—");
  });
});

describe("M5.3 selection summary", () => {
  const base = {
    priceTiers: TIERS,
    maxSeats: 8,
    onRemoveSeat: () => {},
    onClearSelection: () => {},
  };

  it("lists seats with real tiers, sums integer minor units and shows no fees", () => {
    render(
      <SelectionSummary {...base} variant="rail" sections={tieredMap()} selectedSeatIds={["st-b-2", "st-a-1"]} />,
    );
    const summary = screen.getByRole("complementary", { name: "Your selection" });
    const seats = within(summary).getByRole("list", { name: "Selected seats" });
    expect(within(seats).getAllByRole("listitem").map((item) => plain(item.textContent))).toEqual([
      "StallsRow B · Seat 2Front StallsAZN 150.00✕",
      "StallsRow A · Seat 1StandardAZN 120.00✕",
    ]);
    expect(within(summary).getByTestId("selection-total")).toHaveTextContent("AZN 270.00");
    const categories = within(summary).getByRole("region", { name: "Seat categories and pricing" });
    expect(categories).toHaveTextContent("StandardAZN 120.00");
    expect(categories).toHaveTextContent("Front StallsClosest to the stageAZN 150.00");
    expect(summary.textContent).not.toMatch(/fee|discount|tax|service/i);
    expect(within(summary).getByRole("status")).toHaveTextContent(
      "Seats selected — not reserved yet. 2 of 8 seats selected.",
    );
    expect(within(summary).getByRole("button", { name: "Hold 2 seats" })).toHaveAttribute("type", "submit");
  });

  it("uses the server currency of the seats, never a default", () => {
    const eur = tieredMap({
      "st-a-1": { currency: "EUR", priceMinor: 9_050 },
      "st-a-2": { currency: "EUR", priceMinor: 1_000 },
    });
    render(<SelectionSummary {...base} priceTiers={[]} variant="rail" sections={eur} selectedSeatIds={["st-a-1", "st-a-2"]} />);
    expect(screen.getByTestId("selection-total")).toHaveTextContent("€100.50");
    expect(screen.queryByRole("region", { name: "Seat categories and pricing" })).toBeNull();
  });

  it("handles missing price and tier metadata honestly", () => {
    const unpriced = tieredMap({ "st-a-1": { priceMinor: null, currency: null, priceTierId: undefined } });
    render(<SelectionSummary {...base} variant="rail" sections={unpriced} selectedSeatIds={["st-a-1", "st-a-2"]} />);
    const seats = screen.getByRole("list", { name: "Selected seats" });
    const [first, second] = within(seats).getAllByRole("listitem");
    expect(first).toHaveTextContent("Price confirmed when held");
    expect(first).not.toHaveTextContent("Standard");
    expect(second).toHaveTextContent("Standard");
    expect(screen.getByTestId("selection-total")).toHaveTextContent("AZN 120.00");
    expect(screen.getByText(/Some selected seats have no visible price/)).toBeInTheDocument();
  });

  it("labels the hold action by count and disables it when holding is impossible", () => {
    expect(holdActionLabel(1)).toBe("Hold 1 seat");
    expect(holdActionLabel(3)).toBe("Hold 3 seats");
    const { rerender } = render(
      <SelectionSummary {...base} variant="rail" sections={tieredMap()} selectedSeatIds={["st-a-1"]} holdEnabled={false} />,
    );
    expect(screen.getByRole("button", { name: "Hold 1 seat" })).toBeDisabled();
    rerender(<SelectionSummary {...base} variant="rail" sections={tieredMap()} selectedSeatIds={["st-a-1"]} pending />);
    expect(screen.getByRole("button", { name: "Holding…" })).toBeDisabled();
    rerender(
      <SelectionSummary {...base} variant="rail" sections={tieredMap()} selectedSeatIds={["st-a-1"]} errorMessage="One or more selected seats are no longer available." />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("no longer available");
  });

  it("removes single seats and clears through callbacks", () => {
    const onRemoveSeat = vi.fn();
    const onClearSelection = vi.fn();
    render(
      <SelectionSummary
        {...base}
        onRemoveSeat={onRemoveSeat}
        onClearSelection={onClearSelection}
        variant="rail"
        sections={tieredMap()}
        selectedSeatIds={["st-a-1"]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove Stalls, row A, seat 1" }));
    expect(onRemoveSeat).toHaveBeenCalledWith("st-a-1");
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(onClearSelection).toHaveBeenCalledOnce();
  });

  it("renders the mobile sheet with safe-area padding and an expandable seat list", () => {
    render(<SelectionSummary {...base} variant="sheet" sections={tieredMap()} selectedSeatIds={["st-a-1"]} />);
    const sheet = screen.getByRole("complementary", { name: "Selected seats (1)" });
    expect(sheet).toHaveAttribute("data-summary-variant", "sheet");
    expect(sheet.className).toContain("env(safe-area-inset-bottom)");
    // Sticky (in flow) rather than fixed: it can never cover content after it.
    expect(sheet.className).toContain("sticky");
    expect(sheet.className).not.toContain("fixed");

    const toggle = within(sheet).getByRole("button", { name: "View details" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const details = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(details).not.toBeVisible();
    // Total and the hold action stay visible while collapsed.
    expect(within(sheet).getByTestId("selection-total")).toHaveTextContent("AZN 120.00");
    expect(within(sheet).getByRole("button", { name: "Hold 1 seat" })).toBeEnabled();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(details).toBeVisible();
    expect(within(details).getByRole("button", { name: "Remove Stalls, row A, seat 1" })).toBeInTheDocument();
  });

  it("uses a sticky desktop rail", () => {
    render(<SelectionSummary {...base} variant="rail" sections={tieredMap()} selectedSeatIds={[]} />);
    const rail = screen.getByRole("complementary", { name: "Your selection" });
    expect(rail.className).toContain("lg:sticky");
    expect(rail).toHaveTextContent("Select up to 8 seats on the map or from the seat list.");
  });
});
