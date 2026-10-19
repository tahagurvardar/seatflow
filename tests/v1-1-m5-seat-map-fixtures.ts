import { vi } from "vitest";

import type {
  SelectionSeatView,
  SelectionSectionView,
} from "../src/features/holds/inventory";
import { numberToRowLabel } from "../src/features/seat-maps/row-labels";

/** Seat with a visible server price only when the customer could act on it. */
export function fixtureSeat(
  seatId: string,
  label: string,
  x: number,
  y: number,
  state: SelectionSeatView["state"] = "AVAILABLE",
  type: SelectionSeatView["type"] = "STANDARD",
  priceMinor = 12_000,
): SelectionSeatView {
  const priced = state === "AVAILABLE" || state === "HELD_BY_YOU";
  return {
    seatId,
    label,
    x,
    y,
    type,
    state,
    priceMinor: priced ? priceMinor : null,
    currency: priced ? "AZN" : null,
  };
}

/**
 * Small two-section map:
 *   Stalls row A: A1 A2 A3(unavailable)   row B: B1 B2(premium) B3(held by you)
 *   Balcony row A: A1 A2
 */
export function smallMap(
  overrides: Partial<Record<string, Partial<SelectionSeatView>>> = {},
): SelectionSectionView[] {
  const seat = (...args: Parameters<typeof fixtureSeat>): SelectionSeatView => ({
    ...fixtureSeat(...args),
    ...overrides[args[0]],
  });
  return [
    {
      id: "stalls",
      name: "Stalls",
      code: "ST",
      rows: [
        {
          id: "stalls-a",
          label: "A",
          seats: [
            seat("st-a-1", "1", 0, 0),
            seat("st-a-2", "2", 40, 0),
            seat("st-a-3", "3", 80, 0, "UNAVAILABLE"),
          ],
        },
        {
          id: "stalls-b",
          label: "B",
          seats: [
            seat("st-b-1", "1", 0, 40),
            seat("st-b-2", "2", 40, 40, "AVAILABLE", "PREMIUM", 15_000),
            seat("st-b-3", "3", 80, 40, "HELD_BY_YOU"),
          ],
        },
      ],
    },
    {
      id: "balcony",
      name: "Balcony",
      code: "BA",
      rows: [
        {
          id: "balcony-a",
          label: "A",
          seats: [seat("ba-a-1", "1", 0, 0), seat("ba-a-2", "2", 40, 0)],
        },
      ],
    },
  ];
}

/** Synthetic 3,000-seat map: 6 sections x 20 rows x 25 seats, 40-unit spacing. */
export function syntheticMap(
  stateFor: (s: number, r: number, n: number) => SelectionSeatView["state"] = (_s, _r, n) =>
    n % 7 === 0 ? "UNAVAILABLE" : "AVAILABLE",
): SelectionSectionView[] {
  return Array.from({ length: 6 }, (_, s) => ({
    id: `s${s}`,
    name: `Section ${s + 1}`,
    code: `S${s + 1}`,
    rows: Array.from({ length: 20 }, (_, r) => ({
      id: `s${s}-r${r}`,
      label: numberToRowLabel(r + 1),
      seats: Array.from({ length: 25 }, (_, n) =>
        fixtureSeat(
          `s${s}-r${r}-n${n}`,
          String(n + 1),
          n * 40,
          r * 40,
          stateFor(s, r, n),
          r < 2 ? "PREMIUM" : "STANDARD",
          r < 2 ? 15_000 : 12_000,
        ),
      ),
    })),
  }));
}

/** Give the viewport a measurable size in jsdom (which has no layout). */
export function stubViewportSize(width: number, height: number) {
  const original = HTMLElement.prototype.getBoundingClientRect;
  return vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === "seat-map-viewport") {
        return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON() {} } as DOMRect;
      }
      return original.call(this);
    });
}
