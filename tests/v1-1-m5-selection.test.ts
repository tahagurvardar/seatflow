import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  SelectionSeatView,
  SelectionSectionView,
} from "../src/features/holds/inventory";
import {
  assertMaxSeats,
  buildSelectionSeatIndex,
  describeSelectedSeats,
  estimateSelectionTotal,
  reconcileSelection,
  SEAT_VISUAL_LABELS,
  SEAT_VISUAL_TOKENS,
  seatVisualState,
  selectionLimitState,
  toggleSeatSelection,
} from "../src/features/holds/selection";

function seat(
  seatId: string,
  state: SelectionSeatView["state"] = "AVAILABLE",
  overrides: Partial<SelectionSeatView> = {},
): SelectionSeatView {
  const priced = state === "AVAILABLE" || state === "HELD_BY_YOU";
  return {
    seatId,
    label: seatId.split("-").at(-1)!,
    x: 0,
    y: 0,
    type: "STANDARD",
    state,
    priceMinor: priced ? 12_000 : null,
    currency: priced ? "AZN" : null,
    ...overrides,
  };
}

function sections(seats: SelectionSeatView[]): SelectionSectionView[] {
  return [{ id: "sec-a", name: "Stalls", code: "STALLS", rows: [{ id: "row-e", label: "E", seats }] }];
}

const snapshot = sections([
  seat("e-1"),
  seat("e-2"),
  seat("e-3", "AVAILABLE", { priceMinor: 9_050 }),
  seat("e-4", "UNAVAILABLE"),
  seat("e-5", "HELD_BY_YOU"),
  seat("e-6", "BLOCKED"),
]);
const index = buildSelectionSeatIndex(snapshot);

describe("M5.1 local seat selection", () => {
  it("indexes seats with their section and row context", () => {
    expect(index.size).toBe(6);
    expect(index.get("e-1")).toMatchObject({ sectionName: "Stalls", sectionCode: "STALLS", rowLabel: "E" });
  });

  it("adds available seats and removes selected ones without mutating input", () => {
    const empty: readonly string[] = Object.freeze([]);
    const added = toggleSeatSelection(empty, "e-1", index, 8);
    expect(added).toEqual({ selected: ["e-1"], change: "added" });
    expect(toggleSeatSelection(added.selected, "e-1", index, 8)).toEqual({ selected: [], change: "removed" });
  });

  it("refuses unavailable, held, blocked and unknown seats", () => {
    const current = ["e-1"];
    for (const id of ["e-4", "e-5", "e-6"]) {
      const result = toggleSeatSelection(current, id, index, 8);
      expect(result.change).toBe("not-selectable");
      expect(result.selected).toBe(current);
    }
    expect(toggleSeatSelection(current, "ghost", index, 8).change).toBe("unknown-seat");
  });

  it("enforces the server seat ceiling but always allows removal", () => {
    const full = ["e-1", "e-2"];
    const blocked = toggleSeatSelection(full, "e-3", index, 2);
    expect(blocked.change).toBe("limit-reached");
    expect(blocked.selected).toBe(full);
    expect(toggleSeatSelection(full, "e-2", index, 2).selected).toEqual(["e-1"]);
    expect(selectionLimitState(full, 2)).toEqual({ count: 2, maxSeats: 2, remaining: 0, atLimit: true });
    expect(selectionLimitState(["e-1"], 8)).toMatchObject({ remaining: 7, atLimit: false });
  });

  it("rejects invalid maxSeats values instead of guessing", () => {
    for (const value of [0, -1, 1.5, Number.NaN]) {
      expect(() => assertMaxSeats(value)).toThrow(/positive integer/);
    }
  });

  it("reconciles with a fresh snapshot and trims to a lower ceiling", () => {
    const fresh = sections([
      seat("e-1"),
      seat("e-2", "UNAVAILABLE"),
      seat("e-3"),
      seat("e-7"),
    ]);
    expect(reconcileSelection(["e-1", "e-2", "e-3", "e-7"], fresh, 2)).toEqual({
      kept: ["e-1", "e-3"],
      removed: ["e-2"],
      trimmed: ["e-7"],
    });
  });
});

describe("M5.1 selection estimate and summary", () => {
  it("sums integer minor units in the server currency", () => {
    expect(estimateSelectionTotal(["e-1", "e-3"], index)).toEqual({
      totalMinor: 21_050,
      currency: "AZN",
      seatCount: 2,
      unpricedSeatIds: [],
    });
  });

  it("reports seats without a visible price rather than guessing", () => {
    expect(estimateSelectionTotal(["e-1", "e-4", "ghost"], index)).toEqual({
      totalMinor: 12_000,
      currency: "AZN",
      seatCount: 3,
      unpricedSeatIds: ["e-4", "ghost"],
    });
    expect(estimateSelectionTotal([], index)).toEqual({
      totalMinor: 0,
      currency: null,
      seatCount: 0,
      unpricedSeatIds: [],
    });
  });

  it("refuses mixed currencies and fractional prices", () => {
    const mixed = buildSelectionSeatIndex(
      sections([seat("m-1"), seat("m-2", "AVAILABLE", { currency: "USD" })]),
    );
    expect(() => estimateSelectionTotal(["m-1", "m-2"], mixed)).toThrow(/mix currencies/);
    const fractional = buildSelectionSeatIndex(sections([seat("f-1", "AVAILABLE", { priceMinor: 10.5 })]));
    expect(() => estimateSelectionTotal(["f-1"], fractional)).toThrow(/integer minor units/);
  });

  it("describes selected seats in selection order", () => {
    const lines = describeSelectedSeats(["e-3", "e-1", "ghost"], index);
    expect(lines.map((line) => line.seatId)).toEqual(["e-3", "e-1"]);
    expect(lines[0]).toMatchObject({
      sectionName: "Stalls",
      rowLabel: "E",
      seatLabel: "3",
      seatType: "STANDARD",
      priceMinor: 9_050,
      currency: "AZN",
    });
  });
});

describe("M5.1 seat visual states and tokens", () => {
  it("uses the gold premium treatment only for available PREMIUM seats", () => {
    expect(seatVisualState("AVAILABLE", "PREMIUM", false)).toBe("premium");
    expect(seatVisualState("AVAILABLE", "PREMIUM", true)).toBe("selected");
    expect(seatVisualState("UNAVAILABLE", "PREMIUM", false)).toBe("unavailable");
    expect(seatVisualState("AVAILABLE", "ACCESSIBLE", false)).toBe("available");
    expect(seatVisualState("HELD_BY_YOU", "STANDARD", false)).toBe("held-by-you");
    expect(seatVisualState("BLOCKED", "STANDARD", false)).toBe("blocked");
    expect(SEAT_VISUAL_LABELS.premium).toBe("Premium");
  });

  it("gives every visual state a text label and a scoped token with the approved colour", () => {
    const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");
    const scope = css.match(/\[data-theme-scope="customer"\]\s*\{([^}]*)\}/);
    expect(scope).not.toBeNull();
    const approved: Record<string, string> = {
      "--sf-seat-available": "#60a5fa",
      "--sf-seat-selected": "#f97316",
      "--sf-seat-premium": "#d6a354",
      "--sf-seat-unavailable": "#64748b",
      "--sf-seat-held-by-you": "#a78bfa",
      "--sf-on-brand": "#0b1220",
    };
    for (const [token, colour] of Object.entries(approved)) {
      expect(scope![1]).toContain(`${token}: ${colour};`);
    }
    for (const [state, token] of Object.entries(SEAT_VISUAL_TOKENS)) {
      expect(scope![1]).toContain(`${token}:`);
      expect(SEAT_VISUAL_LABELS[state as keyof typeof SEAT_VISUAL_LABELS].length).toBeGreaterThan(0);
    }
    // Tokens must not leak into the global :root theme of existing pages.
    const root = css.match(/:root\s*\{([^}]*)\}/)![1];
    expect(root).not.toContain("--sf-");
  });
});

describe("M5.1 selection at 3,000 seats", () => {
  it("indexes, toggles, reconciles and estimates within a generous budget", () => {
    const big: SelectionSectionView[] = Array.from({ length: 6 }, (_, s) => ({
      id: `s${s}`,
      name: `Section ${s + 1}`,
      code: `S${s + 1}`,
      rows: Array.from({ length: 20 }, (_, r) => ({
        id: `s${s}-r${r}`,
        label: `R${r}`,
        seats: Array.from({ length: 25 }, (_, n) =>
          seat(`s${s}-r${r}-n${n}`, n % 7 === 0 ? "UNAVAILABLE" : "AVAILABLE", {
            type: r < 2 ? "PREMIUM" : "STANDARD",
          }),
        ),
      })),
    }));

    const started = performance.now();
    const bigIndex = buildSelectionSeatIndex(big);
    const indexMs = performance.now() - started;

    let selected: readonly string[] = [];
    const toggleStarted = performance.now();
    // Multiples of 7 are UNAVAILABLE in this fixture, so pick eight available seats.
    for (const n of [1, 2, 3, 4, 5, 6, 8, 9]) {
      selected = toggleSeatSelection(selected, `s3-r10-n${n}`, bigIndex, 8).selected;
    }
    const toggleMs = performance.now() - toggleStarted;

    const reconcileStarted = performance.now();
    const reconciliation = reconcileSelection(selected, big, 8);
    const reconcileMs = performance.now() - reconcileStarted;

    const estimate = estimateSelectionTotal(selected, bigIndex);

    expect(bigIndex.size).toBe(3_000);
    expect(selected).toHaveLength(8);
    expect(reconciliation.kept).toHaveLength(8);
    expect(estimate.totalMinor).toBe(8 * 12_000);

    console.info(
      `[M5.1 perf] 3000-seat selection: index ${indexMs.toFixed(2)} ms, ` +
        `8 toggles ${toggleMs.toFixed(3)} ms, reconcile ${reconcileMs.toFixed(2)} ms`,
    );
    expect(indexMs).toBeLessThan(250);
    expect(reconcileMs).toBeLessThan(250);
  });
});
