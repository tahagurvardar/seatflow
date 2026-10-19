import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SeatMapLegend } from "../src/components/seat-selection/seat-map-legend";
import {
  READABLE_SEAT_PX,
  readableViewport,
  revealViewport,
  showRectViewport,
} from "../src/components/seat-selection/seat-map-viewport";
import { SeatNode } from "../src/components/seat-selection/seat-node";
import {
  geometrySignature,
  SCHEMATIC_NOTICE,
  VenueSeatMap,
} from "../src/components/seat-selection/venue-seat-map";
import type { SelectionSectionView } from "../src/features/holds/inventory";
import { toggleSeatSelection, buildSelectionSeatIndex } from "../src/features/holds/selection";
import { resolveZoomLimits } from "../src/features/seat-maps/viewport";
import { smallMap, stubViewportSize, syntheticMap } from "./v1-1-m5-seat-map-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
});

function seatButton(name: RegExp) {
  return screen.getByRole("button", { name });
}

function control(label: string) {
  const element = document.querySelector<HTMLButtonElement>(`[role="toolbar"] [aria-label="${label}"]`);
  if (!element) throw new Error(`Control ${label} not rendered.`);
  return element;
}

/** Direct lookup for large maps: role queries over 3,000 buttons are slow in jsdom. */
function seatById(seatId: string) {
  const element = document.querySelector<HTMLElement>(`[data-seat-id="${seatId}"]`);
  if (!element) throw new Error(`Seat ${seatId} not rendered.`);
  return element;
}

function viewportScale() {
  return Number(screen.getByTestId("seat-map-viewport").getAttribute("data-viewport-scale"));
}

/** Controlled harness that uses the M5.1 selection rules, like a real parent. */
function Harness({
  sections,
  maxSeats = 8,
  initialSelected = [],
}: {
  sections: SelectionSectionView[];
  maxSeats?: number;
  initialSelected?: string[];
}) {
  const [selected, setSelected] = useState<readonly string[]>(initialSelected);
  return (
    <VenueSeatMap
      sections={sections}
      selectedSeatIds={selected}
      maxSeats={maxSeats}
      onToggleSeat={(seatId) =>
        setSelected((current) =>
          toggleSeatSelection(current, seatId, buildSelectionSeatIndex(sections), maxSeats).selected,
        )
      }
    />
  );
}

describe("M5.2 seat node and legend", () => {
  it("exposes name, pressed, disabled and roving tab state on a seat", () => {
    render(
      <SeatNode
        seatId="x"
        x={10}
        y={20}
        size={36}
        visualState="selected"
        accessibleName="Stalls, row A, seat 1, available, AZN 120.00"
        pressed
        inert={false}
        tabbable
      />,
    );
    const seat = seatButton(/Stalls, row A, seat 1/);
    expect(seat).toHaveAttribute("aria-pressed", "true");
    expect(seat).not.toHaveAttribute("aria-disabled");
    expect(seat).toHaveAttribute("tabindex", "0");
    expect(seat).toHaveAttribute("data-seat-state", "selected");
    expect(seat).toHaveTextContent("✓");
    expect(seat).toHaveStyle({ left: "10px", top: "20px", width: "36px" });
  });

  it("labels every legend state with text and a non-colour glyph", () => {
    render(<SeatMapLegend states={["available", "selected", "premium", "held-by-you", "unavailable"]} />);
    const legend = screen.getByRole("list", { name: "Seat legend" });
    const items = within(legend).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Available",
      "✓Selected",
      "★Premium",
      "●Held by you",
      "✕Unavailable",
    ]);
  });
});

describe("M5.2 venue seat map semantics", () => {
  it("marks the layout as schematic and shows only legend states present in the data", () => {
    render(<Harness sections={smallMap()} />);
    expect(screen.getByRole("note")).toHaveTextContent(SCHEMATIC_NOTICE);
    const legend = screen.getByRole("list", { name: "Seat legend" });
    expect(within(legend).getByText("Premium")).toBeInTheDocument();
    expect(within(legend).getByText("Held by you")).toBeInTheDocument();

    const noPremium = smallMap({ "st-b-2": { type: "STANDARD" }, "st-b-3": { state: "AVAILABLE" } });
    render(<VenueSeatMap sections={noPremium} selectedSeatIds={[]} maxSeats={8} />);
    const previewLegend = screen.getAllByRole("list", { name: "Seat legend" })[1]!;
    expect(within(previewLegend).queryByText("Premium")).toBeNull();
    expect(within(previewLegend).queryByText("Selected")).toBeNull();
  });

  it("names seats from real section, row, seat, availability, type and price", () => {
    render(<Harness sections={smallMap()} />);
    expect(seatButton(/^Stalls, row A, seat 1, available, AZN\s?120\.00$/)).toBeInTheDocument();
    expect(seatButton(/^Stalls, row B, seat 2, available, premium seat, AZN\s?150\.00$/)).toBeInTheDocument();
    // The server hides prices of seats the customer cannot act on.
    expect(seatButton(/^Stalls, row A, seat 3, unavailable$/)).toHaveAttribute("aria-disabled", "true");
    expect(seatButton(/^Stalls, row B, seat 3, held by you, AZN/)).toHaveAttribute("data-seat-state", "held-by-you");
  });

  it("creates exactly one tab stop for all seats", { timeout: 30_000 }, () => {
    render(<Harness sections={syntheticMap()} />);
    const seats = [...document.querySelectorAll<HTMLElement>("[data-seat-id]")];
    const tabbable = seats.filter((seat) => seat.getAttribute("tabindex") === "0");
    expect(seats).toHaveLength(3_000);
    expect(seats.every((seat) => seat.tagName === "BUTTON")).toBe(true);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toHaveAttribute("data-seat-id", "s0-r0-n0");
  });

  it("toggles available seats, ignores unavailable ones, and keeps removal possible at the limit", () => {
    render(<Harness sections={smallMap()} maxSeats={2} />);
    const a1 = seatButton(/Stalls, row A, seat 1,/);
    fireEvent.click(a1);
    expect(a1).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(seatButton(/Stalls, row A, seat 3,/));
    expect(seatButton(/Stalls, row A, seat 3,/)).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(seatButton(/Stalls, row A, seat 2,/));
    const b1 = seatButton(/Stalls, row B, seat 1,/);
    expect(b1).toHaveAttribute("aria-disabled", "true");
    expect(b1).toHaveAccessibleName(/selection limit reached$/);
    fireEvent.click(b1);
    expect(b1).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(a1);
    expect(a1).toHaveAttribute("aria-pressed", "false");
    expect(b1).not.toHaveAttribute("aria-disabled");
  });

  it("is read-only without onToggleSeat", () => {
    render(<VenueSeatMap sections={smallMap()} selectedSeatIds={[]} maxSeats={8} />);
    const a1 = seatButton(/Stalls, row A, seat 1,/);
    expect(a1).not.toHaveAttribute("aria-pressed");
    expect(a1).toHaveAttribute("aria-disabled", "true");
  });

  it("renders an honest empty state", () => {
    render(<VenueSeatMap sections={[]} selectedSeatIds={[]} maxSeats={8} />);
    expect(screen.getByRole("status")).toHaveTextContent("No seats are available for this session.");
  });
});

describe("M5.2 keyboard navigation", () => {
  it("moves the roving stop and focus with arrows, Home and End", () => {
    render(<Harness sections={smallMap()} />);
    const a1 = seatButton(/Stalls, row A, seat 1,/);
    act(() => a1.focus());

    expect(fireEvent.keyDown(a1, { key: "ArrowRight" })).toBe(false);
    const a2 = seatButton(/Stalls, row A, seat 2,/);
    expect(document.activeElement).toBe(a2);
    expect(a2).toHaveAttribute("tabindex", "0");
    expect(a1).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(a2, { key: "End" });
    expect(document.activeElement).toBe(seatButton(/Stalls, row A, seat 3,/));
    // Unavailable seats stay reachable so their state can be announced.
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(seatButton(/Stalls, row B, seat 3,/));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(seatButton(/Stalls, row B, seat 1,/));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(seatButton(/Balcony, row A, seat 1,/));
  });

  it("keeps focus at map edges and does not scroll the page", () => {
    render(<Harness sections={smallMap()} />);
    const a1 = seatButton(/Stalls, row A, seat 1,/);
    act(() => a1.focus());
    expect(fireEvent.keyDown(a1, { key: "ArrowUp" })).toBe(false);
    expect(document.activeElement).toBe(a1);
  });

  it("selects with Enter/Space through the native button", () => {
    render(<Harness sections={smallMap()} />);
    const a1 = seatButton(/Stalls, row A, seat 1,/);
    act(() => a1.focus());
    fireEvent.click(a1); // Enter/Space on a <button> dispatches click.
    expect(a1).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the focused seat and its DOM node across an inventory refresh", () => {
    const { rerender } = render(<VenueSeatMap sections={smallMap()} selectedSeatIds={[]} maxSeats={8} onToggleSeat={() => {}} />);
    const b1 = seatButton(/Stalls, row B, seat 1,/);
    act(() => b1.focus());

    // Fresh objects, same geometry; another seat changed availability.
    rerender(
      <VenueSeatMap
        sections={smallMap({ "st-a-2": { state: "UNAVAILABLE", priceMinor: null, currency: null } })}
        selectedSeatIds={[]}
        maxSeats={8}
        onToggleSeat={() => {}}
      />,
    );
    expect(seatButton(/Stalls, row B, seat 1,/)).toBe(b1);
    expect(document.activeElement).toBe(b1);
    expect(b1).toHaveAttribute("tabindex", "0");
    expect(seatButton(/Stalls, row A, seat 2, unavailable$/)).toHaveAttribute("aria-disabled", "true");

    // Even when the focused seat itself becomes unavailable it keeps the stop.
    rerender(
      <VenueSeatMap
        sections={smallMap({ "st-b-1": { state: "UNAVAILABLE", priceMinor: null, currency: null } })}
        selectedSeatIds={[]}
        maxSeats={8}
        onToggleSeat={() => {}}
      />,
    );
    expect(document.activeElement).toBe(b1);
    expect(b1).toHaveAttribute("tabindex", "0");
  });

  it("falls back deterministically to the first seat when the active seat leaves the geometry", () => {
    const { rerender } = render(<VenueSeatMap sections={smallMap()} selectedSeatIds={[]} maxSeats={8} />);
    act(() => seatButton(/Balcony, row A, seat 2,/).focus());
    const withoutBalcony = smallMap().slice(0, 1);
    rerender(<VenueSeatMap sections={withoutBalcony} selectedSeatIds={[]} maxSeats={8} />);
    expect(seatButton(/Stalls, row A, seat 1,/)).toHaveAttribute("tabindex", "0");
  });

  it("treats identical geometry as identical regardless of availability", () => {
    expect(geometrySignature(smallMap())).toBe(
      geometrySignature(smallMap({ "st-a-1": { state: "UNAVAILABLE" } })),
    );
    expect(geometrySignature(smallMap())).not.toBe(geometrySignature(smallMap({ "st-a-1": { x: 4 } })));
  });
});

// 3,000 jsdom buttons are slow to build under a parallel full-suite run.
describe("M5.2 viewport behaviour on a 3,000-seat map", { timeout: 30_000 }, () => {
  it("opens at a readable scale instead of fit-all, with zoom, reset and overview controls", () => {
    stubViewportSize(1_120, 640);
    render(<Harness sections={syntheticMap()} />);
    const readable = READABLE_SEAT_PX / 36;
    expect(viewportScale()).toBeCloseTo(readable, 3);

    fireEvent.click(control("Zoom in"));
    expect(viewportScale()).toBeCloseTo(readable * 1.25, 3);
    fireEvent.click(control("Zoom out"));
    expect(viewportScale()).toBeCloseTo(readable, 3);

    fireEvent.click(control("Show whole map"));
    const overview = viewportScale();
    expect(overview * 36).toBeLessThan(READABLE_SEAT_PX);
    expect(control("Zoom out")).toBeDisabled();

    fireEvent.click(control("Reset view"));
    expect(viewportScale()).toBeCloseTo(readable, 3);
  });

  it("supports +, − and 0 keys and Ctrl+wheel, but leaves a plain wheel to the page", () => {
    stubViewportSize(1_120, 640);
    render(<Harness sections={syntheticMap()} />);
    const viewport = screen.getByTestId("seat-map-viewport");
    const start = viewportScale();

    fireEvent.keyDown(viewport, { key: "+" });
    expect(viewportScale()).toBeGreaterThan(start);
    fireEvent.keyDown(viewport, { key: "0" });
    expect(viewportScale()).toBeCloseTo(start, 4);

    const plain = new WheelEvent("wheel", { deltaY: -200, bubbles: true, cancelable: true });
    act(() => {
      viewport.dispatchEvent(plain);
    });
    expect(plain.defaultPrevented).toBe(false);
    expect(viewportScale()).toBeCloseTo(start, 4);

    const zoom = new WheelEvent("wheel", { deltaY: -200, ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      viewport.dispatchEvent(zoom);
    });
    expect(zoom.defaultPrevented).toBe(true);
    expect(viewportScale()).toBeGreaterThan(start);
  });

  it("jumps to a section from real section data and moves the tab stop there", () => {
    stubViewportSize(1_120, 640);
    render(<Harness sections={syntheticMap()} />);
    const jump = document.querySelector("select")!;
    expect(jump.labels?.[0]).toHaveTextContent("Jump to section");
    expect(within(jump).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Choose a section",
      "Section 1",
      "Section 2",
      "Section 3",
      "Section 4",
      "Section 5",
      "Section 6",
    ]);
    const content = screen.getByTestId("seat-map-content");
    const before = content.style.transform;

    fireEvent.change(jump, { target: { value: "s4" } });
    expect(content.style.transform).not.toBe(before);
    expect(document.querySelector('[role="status"][aria-live="polite"]')).toHaveTextContent(
      "Showing Section 5. Press Tab to move to its first seat.",
    );
    expect(seatById("s4-r0-n0")).toHaveAttribute("tabindex", "0");
    expect(seatById("s4-r0-n0").getAttribute("aria-label")).toMatch(/^Section 5, row A, seat 1, unavailable/);
    expect(content.className).toContain("motion-safe:transition-transform");
  });

  it("zooms back to a readable scale when keyboard focus lands on a seat in the overview", () => {
    stubViewportSize(358, 420);
    render(<Harness sections={syntheticMap()} />);
    fireEvent.click(control("Show whole map"));
    expect(viewportScale() * 36).toBeLessThan(READABLE_SEAT_PX);

    const first = seatById("s0-r0-n0");
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(seatById("s0-r1-n0"));
    expect(viewportScale() * 36).toBeGreaterThanOrEqual(READABLE_SEAT_PX - 1e-6);
  });

  it("does not toggle a seat when a mouse drag ends on it", () => {
    stubViewportSize(1_120, 640);
    const onToggle = vi.fn();
    render(<VenueSeatMap sections={syntheticMap()} selectedSeatIds={[]} maxSeats={8} onToggleSeat={onToggle} />);
    const seat = seatById("s0-r0-n1");
    const start = screen.getByTestId("seat-map-content").style.transform;

    fireEvent.pointerDown(seat, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(seat, { pointerId: 1, pointerType: "mouse", clientX: 60, clientY: 60 });
    fireEvent.pointerUp(seat, { pointerId: 1, pointerType: "mouse", clientX: 60, clientY: 60 });
    fireEvent.click(seat);

    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.getByTestId("seat-map-content").style.transform).not.toBe(start);

    // A plain click without a drag still selects.
    fireEvent.click(seat);
    expect(onToggle).toHaveBeenCalledWith("s0-r0-n1");
  });
});

describe("M5.2 pure viewport policies", () => {
  const size = { contentWidth: 1_084, contentHeight: 5_416, viewportWidth: 358, viewportHeight: 420 };
  const limits = resolveZoomLimits(size);
  const focus = { x: 24, y: 24, width: 1_036, height: 900 };

  it("prefers fit-all only when fit-all is readable", () => {
    const small = { contentWidth: 400, contentHeight: 300, viewportWidth: 1_120, viewportHeight: 640 };
    expect(readableViewport(small, resolveZoomLimits(small), focus, 36).scale).toBe(1);
    const tall = readableViewport(size, limits, focus, 36);
    expect(tall.scale * 36).toBeCloseTo(READABLE_SEAT_PX);
    expect(tall.y).toBe(0); // stage at the top, clamped to the content edge
  });

  it("reveals by panning when readable and by zooming in when not", () => {
    const readable = readableViewport(size, limits, focus, 36);
    const target = { x: 900, y: 3_000, width: 36, height: 36 };
    const panned = revealViewport(readable, size, limits, target, 36);
    expect(panned.scale).toBe(readable.scale);
    const tiny = { scale: limits.minScale, x: 0, y: 0 };
    expect(revealViewport(tiny, size, limits, target, 36).scale * 36).toBeCloseTo(READABLE_SEAT_PX);
  });

  it("jumps to a rect without zooming out", () => {
    const zoomed = { scale: 2, x: 0, y: 0 };
    expect(showRectViewport(zoomed, size, limits, { x: 24, y: 2_000, width: 1_036, height: 900 }, 36).scale).toBe(2);
  });
});
