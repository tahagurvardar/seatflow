import { describe, expect, it } from "vitest";

import { numberToRowLabel } from "../src/features/seat-maps/row-labels";
import {
  buildVenueLayout,
  DEFAULT_VENUE_LAYOUT_OPTIONS,
  firstSeatId,
  neighborSeatId,
  seatBounds,
  type LayoutSectionInput,
  type SeatNavigationDirection,
} from "../src/features/seat-maps/venue-layout";

const SEAT = DEFAULT_VENUE_LAYOUT_OPTIONS.seatSize;

function section(
  id: string,
  rows: Array<{ label: string; seats: Array<[label: string, x: number, y: number]> }>,
): LayoutSectionInput {
  return {
    id,
    name: `Section ${id}`,
    code: id.toUpperCase(),
    rows: rows.map((row) => ({
      id: `${id}-${row.label}`,
      label: row.label,
      seats: row.seats.map(([label, x, y]) => ({ seatId: `${id}-${row.label}-${label}`, label, x, y })),
    })),
  };
}

/** Synthetic 3,000-seat map: 6 sections x 20 rows x 25 seats, 40-unit spacing. */
function syntheticMap(): LayoutSectionInput[] {
  return Array.from({ length: 6 }, (_, s) => ({
    id: `s${s}`,
    name: `Section ${s + 1}`,
    code: `S${s + 1}`,
    rows: Array.from({ length: 20 }, (_, r) => ({
      id: `s${s}-r${r}`,
      label: numberToRowLabel(r + 1),
      seats: Array.from({ length: 25 }, (_, n) => ({
        seatId: `s${s}-r${r}-n${n}`,
        label: String(n + 1),
        x: n * 40,
        y: r * 40,
      })),
    })),
  }));
}

describe("M5.1 schematic venue layout", () => {
  const sections = [
    section("a", [
      { label: "A", seats: [["1", 0, 0], ["2", 40, 0], ["3", 80, 0]] },
      { label: "B", seats: [["1", 0, 40], ["2", 40, 40], ["3", 80, 40]] },
    ]),
    section("b", [{ label: "A", seats: [["1", 100, 200], ["2", 140, 200]] }]),
  ];

  it("declares itself schematic and stacks sections below the stage in the given order", () => {
    const layout = buildVenueLayout(sections);
    expect(layout.kind).toBe("schematic-stacked");
    expect(layout.sections.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(layout.sections[0]!.bounds.y).toBeGreaterThanOrEqual(layout.stage.y + layout.stage.height);
    expect(layout.sections[1]!.bounds.y).toBeGreaterThan(
      layout.sections[0]!.bounds.y + layout.sections[0]!.bounds.height,
    );
    expect(layout.stage.width).toBe(layout.sections[0]!.bounds.width);
  });

  it("centres narrower sections on the widest one", () => {
    const layout = buildVenueLayout(sections);
    const [wide, narrow] = layout.sections;
    const centre = (rect: { x: number; width: number }) => rect.x + rect.width / 2;
    expect(centre(narrow!.bounds)).toBeCloseTo(centre(wide!.bounds));
  });

  it("keeps real relative seat geometry inside a section (translation only)", () => {
    const layout = buildVenueLayout(sections);
    const seat = (id: string) => layout.seats[layout.seatIndexById.get(id)!]!;
    // Section B starts at (100, 200) in the published map; only the offset moves.
    expect(seat("b-A-2").x - seat("b-A-1").x).toBe(40);
    expect(seat("b-A-1").y).toBe(seat("b-A-2").y);
    expect(seat("a-B-1").y - seat("a-A-1").y).toBe(40);
    expect(seat("a-A-1").x - layout.sections[0]!.bounds.x).toBe(DEFAULT_VENUE_LAYOUT_OPTIONS.rowLabelGutter);
  });

  it("orders seats left to right regardless of input order and records row positions", () => {
    const layout = buildVenueLayout([
      section("c", [{ label: "A", seats: [["3", 80, 0], ["1", 0, 0], ["2", 40, 0]] }]),
    ]);
    expect(layout.seats.map((seat) => seat.label)).toEqual(["1", "2", "3"]);
    expect(layout.seats.map((seat) => seat.positionInRow)).toEqual([0, 1, 2]);
  });

  it("places row labels beside non-empty rows and leaves empty rows unlabelled", () => {
    const layout = buildVenueLayout([
      section("d", [
        { label: "A", seats: [["1", 0, 0]] },
        { label: "B", seats: [] },
        { label: "C", seats: [["1", 0, 80]] },
      ]),
    ]);
    const [rowA, rowB, rowC] = layout.sections[0]!.rows;
    expect(rowA!.labelPosition).not.toBeNull();
    expect(rowB!.labelPosition).toBeNull();
    expect(rowC!.labelPosition!.y - rowA!.labelPosition!.y).toBe(80);
    expect(rowA!.labelPosition!.x).toBeLessThan(layout.seats[0]!.x);
  });

  it("handles empty maps and sections without seats", () => {
    const empty = buildVenueLayout([]);
    expect(empty.seats).toHaveLength(0);
    expect(empty.height).toBeGreaterThan(empty.stage.height);
    expect(firstSeatId(empty)).toBeNull();

    const hollow = buildVenueLayout([section("e", [{ label: "A", seats: [] }])]);
    expect(hollow.sections[0]!.bounds.height).toBe(DEFAULT_VENUE_LAYOUT_OPTIONS.sectionHeadingHeight);
  });

  it("rejects duplicate seat ids and non-finite coordinates", () => {
    expect(() =>
      buildVenueLayout([
        section("f", [{ label: "A", seats: [["1", 0, 0]] }]),
        { ...section("g", []), rows: [{ id: "g-A", label: "A", seats: [{ seatId: "f-A-1", label: "1", x: 0, y: 0 }] }] },
      ]),
    ).toThrow(/more than once/);
    expect(() =>
      buildVenueLayout([section("h", [{ label: "A", seats: [["1", Number.NaN, 0]] }])]),
    ).toThrow(/non-finite/);
  });

  it("is deterministic for identical input", () => {
    expect(buildVenueLayout(sections)).toEqual(buildVenueLayout(sections));
  });

  it("computes bounds of a seat set and ignores unknown ids", () => {
    const layout = buildVenueLayout(sections);
    const bounds = seatBounds(layout, ["a-A-1", "a-B-3", "missing"])!;
    expect(bounds.width).toBe(80 + SEAT);
    expect(bounds.height).toBe(40 + SEAT);
    expect(seatBounds(layout, ["missing"])).toBeNull();
  });
});

describe("M5.1 directional seat navigation", () => {
  const layout = buildVenueLayout([
    section("a", [
      { label: "A", seats: [["1", 0, 0], ["2", 40, 0], ["3", 80, 0]] },
      { label: "B", seats: [] },
      { label: "C", seats: [["1", 20, 80], ["2", 60, 80]] },
    ]),
    section("b", [{ label: "A", seats: [["1", 0, 0], ["2", 40, 0], ["3", 80, 0], ["4", 120, 0]] }]),
  ]);

  it("moves within a row and stops at row edges", () => {
    expect(neighborSeatId(layout, "a-A-1", "right")).toBe("a-A-2");
    expect(neighborSeatId(layout, "a-A-2", "left")).toBe("a-A-1");
    expect(neighborSeatId(layout, "a-A-1", "left")).toBeNull();
    expect(neighborSeatId(layout, "a-A-3", "right")).toBeNull();
    expect(neighborSeatId(layout, "a-A-2", "rowStart")).toBe("a-A-1");
    expect(neighborSeatId(layout, "a-A-2", "rowEnd")).toBe("a-A-3");
    expect(neighborSeatId(layout, "a-A-3", "rowEnd")).toBeNull();
  });

  it("moves vertically to the nearest seat, skipping empty rows", () => {
    // Row A seat 3 (x=80) is nearest to row C seat 2 (x=60); row B is empty.
    expect(neighborSeatId(layout, "a-A-3", "down")).toBe("a-C-2");
    // Ties resolve to the leftmost seat: x=40 is 20 from both 20 and 60.
    expect(neighborSeatId(layout, "a-A-2", "down")).toBe("a-C-1");
    expect(neighborSeatId(layout, "a-C-1", "up")).toBe("a-A-1");
    expect(neighborSeatId(layout, "a-A-1", "up")).toBeNull();
  });

  it("crosses into the next and previous section", () => {
    expect(neighborSeatId(layout, "a-C-2", "down")).not.toBeNull();
    const below = neighborSeatId(layout, "a-C-2", "down")!;
    expect(below.startsWith("b-A-")).toBe(true);
    expect(neighborSeatId(layout, "b-A-1", "up")!.startsWith("a-C-")).toBe(true);
    expect(neighborSeatId(layout, "b-A-4", "down")).toBeNull();
  });

  it("returns null for unknown seats and exposes a first seat", () => {
    expect(neighborSeatId(layout, "nope", "right")).toBeNull();
    expect(firstSeatId(layout)).toBe("a-A-1");
  });
});

describe("M5.1 layout at 3,000 seats", () => {
  it("indexes every seat and keeps every seat reachable by keyboard", () => {
    const map = syntheticMap();
    const started = performance.now();
    const layout = buildVenueLayout(map);
    const buildMs = performance.now() - started;

    expect(layout.seats).toHaveLength(3_000);
    expect(layout.seatIndexById.size).toBe(3_000);

    const directions: SeatNavigationDirection[] = ["left", "right", "up", "down"];
    const traversalStarted = performance.now();
    const visited = new Set<string>([firstSeatId(layout)!]);
    const queue = [firstSeatId(layout)!];
    let lookups = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const direction of directions) {
        const next = neighborSeatId(layout, current, direction);
        lookups += 1;
        if (next && !visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    const traversalMs = performance.now() - traversalStarted;

    expect(visited.size).toBe(3_000);
    expect(lookups).toBe(12_000);
    console.info(
      `[M5.1 perf] buildVenueLayout(3000 seats): ${buildMs.toFixed(2)} ms; ` +
        `${lookups} neighbour lookups: ${traversalMs.toFixed(2)} ms ` +
        `(${((traversalMs / lookups) * 1000).toFixed(2)} µs/lookup)`,
    );
    // Generous ceilings that only catch algorithmic regressions, not machine noise.
    expect(buildMs).toBeLessThan(500);
    expect(traversalMs).toBeLessThan(1_000);
  });
});
