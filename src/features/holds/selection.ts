import type { SupportedCurrency } from "@/config/site";
import type { SeatType } from "@/generated/prisma/enums";
import type {
  SeatSelectionState,
  SelectionSeatView,
  SelectionSectionView,
} from "@/features/holds/inventory";
import { reconcileSelectedSeatIds } from "@/features/inventory-events/delivery";
import { calculateHoldTotal } from "@/features/holds/totals";

// ---------------------------------------------------------------------------
// Local seat selection (client-side intent only)
// ---------------------------------------------------------------------------
//
// A local selection is never a reservation. PostgreSQL decides availability,
// price, and the seat ceiling when the hold is created; these helpers only keep
// the customer's intent consistent with the latest authoritative snapshot and
// the server-provided `maxSeats`.

export interface IndexedSelectionSeat {
  seat: SelectionSeatView;
  sectionId: string;
  sectionName: string;
  sectionCode: string;
  rowId: string;
  rowLabel: string;
}

export type SelectionSeatIndex = ReadonlyMap<string, IndexedSelectionSeat>;

/** Index every seat of a snapshot by id for constant-time lookups. */
export function buildSelectionSeatIndex(
  sections: readonly SelectionSectionView[],
): SelectionSeatIndex {
  const index = new Map<string, IndexedSelectionSeat>();
  for (const section of sections) {
    for (const row of section.rows) {
      for (const seat of row.seats) {
        index.set(seat.seatId, {
          seat,
          sectionId: section.id,
          sectionName: section.name,
          sectionCode: section.code,
          rowId: row.id,
          rowLabel: row.label,
        });
      }
    }
  }
  return index;
}

function letters(value: string) {
  return Array.from(value.toUpperCase().replace(/[^\p{L}\p{N}]/gu, ""));
}

/**
 * True when a section code only abbreviates its name ("VIP" for "VIP", "STD"
 * for "Standard"): its letters appear in order in the name, starting with the
 * name's first letter. Codes that add information ("B2", "A" for "Stalls")
 * are not redundant.
 */
export function isRedundantSectionCode(name: string, code: string): boolean {
  const nameLetters = letters(name);
  const codeLetters = letters(code);
  if (codeLetters.length === 0) return true;
  if (nameLetters[0] !== codeLetters[0]) return false;
  let matched = 0;
  for (const letter of nameLetters) {
    if (letter === codeLetters[matched]) matched += 1;
    if (matched === codeLetters.length) return true;
  }
  return false;
}

/**
 * Visible section names by id: the name alone when its code is redundant and
 * the name is unique in the snapshot, otherwise "Name (CODE)", so sections
 * stay distinguishable and no information is dropped.
 */
export function sectionDisplayNames(
  sections: readonly Pick<SelectionSectionView, "id" | "name" | "code">[],
): ReadonlyMap<string, string> {
  const nameCounts = new Map<string, number>();
  for (const section of sections) {
    const key = section.name.trim().toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  return new Map(
    sections.map((section) => {
      const unique = nameCounts.get(section.name.trim().toLowerCase()) === 1;
      const nameOnly = unique && isRedundantSectionCode(section.name, section.code);
      return [section.id, nameOnly ? section.name : `${section.name} (${section.code})`];
    }),
  );
}

/** The server's seat ceiling must be a positive integer; anything else is a bug. */
export function assertMaxSeats(maxSeats: number): number {
  if (!Number.isInteger(maxSeats) || maxSeats < 1) {
    throw new Error("The maximum seats per hold must be a positive integer.");
  }
  return maxSeats;
}

export function isSeatSelectable(seat: SelectionSeatView | undefined): boolean {
  return seat?.state === "AVAILABLE";
}

export type SelectionChange =
  | "added"
  | "removed"
  | "limit-reached"
  | "not-selectable"
  | "unknown-seat";

export interface SelectionToggleResult {
  selected: readonly string[];
  change: SelectionChange;
}

/**
 * Toggle one seat. Removing is always allowed (even if the seat has since
 * become unavailable); adding requires an AVAILABLE seat and room under
 * `maxSeats`. The input array is never mutated; an unchanged result returns the
 * same array so callers can skip re-rendering.
 */
export function toggleSeatSelection(
  selected: readonly string[],
  seatId: string,
  seatIndex: SelectionSeatIndex,
  maxSeats: number,
): SelectionToggleResult {
  assertMaxSeats(maxSeats);
  if (selected.includes(seatId)) {
    return { selected: selected.filter((id) => id !== seatId), change: "removed" };
  }
  const entry = seatIndex.get(seatId);
  if (!entry) return { selected, change: "unknown-seat" };
  if (!isSeatSelectable(entry.seat)) return { selected, change: "not-selectable" };
  if (selected.length >= maxSeats) return { selected, change: "limit-reached" };
  return { selected: [...selected, seatId], change: "added" };
}

export interface SelectionReconciliation {
  kept: string[];
  /** Seats that are no longer AVAILABLE in the latest snapshot. */
  removed: string[];
  /** Seats dropped because the server ceiling is now lower than the selection. */
  trimmed: string[];
}

/**
 * Reconcile a local selection with a fresh authoritative snapshot: unavailable
 * seats are removed (via the shared realtime reconciliation rule), and if the
 * server ceiling shrank, the most recently added seats are trimmed first.
 */
export function reconcileSelection(
  selected: readonly string[],
  sections: readonly SelectionSectionView[],
  maxSeats: number,
): SelectionReconciliation {
  assertMaxSeats(maxSeats);
  const { kept, removed } = reconcileSelectedSeatIds(selected, sections);
  return {
    kept: kept.slice(0, maxSeats),
    removed,
    trimmed: kept.slice(maxSeats),
  };
}

export interface SelectionLimitState {
  count: number;
  maxSeats: number;
  remaining: number;
  atLimit: boolean;
}

export function selectionLimitState(
  selected: readonly string[],
  maxSeats: number,
): SelectionLimitState {
  assertMaxSeats(maxSeats);
  const count = selected.length;
  return {
    count,
    maxSeats,
    remaining: Math.max(0, maxSeats - count),
    atLimit: count >= maxSeats,
  };
}

export interface SelectionEstimate {
  /** Integer minor units; an estimate only — the hold snapshot is official. */
  totalMinor: number;
  currency: SupportedCurrency | null;
  seatCount: number;
  /** Selected seats with no visible price (unknown or no longer selectable). */
  unpricedSeatIds: string[];
}

/**
 * Estimated total of the local selection in integer minor units. Seats without
 * a visible price are reported rather than guessed. Mixed currencies or
 * non-integer prices throw, exactly like the official hold total.
 */
export function estimateSelectionTotal(
  selected: readonly string[],
  seatIndex: SelectionSeatIndex,
): SelectionEstimate {
  const priced: Array<{ priceMinor: number; currency: SupportedCurrency }> = [];
  const unpricedSeatIds: string[] = [];
  for (const seatId of selected) {
    const seat = seatIndex.get(seatId)?.seat;
    if (seat && seat.priceMinor !== null && seat.currency !== null) {
      priced.push({ priceMinor: seat.priceMinor, currency: seat.currency });
    } else {
      unpricedSeatIds.push(seatId);
    }
  }
  if (priced.length === 0) {
    return { totalMinor: 0, currency: null, seatCount: selected.length, unpricedSeatIds };
  }
  const total = calculateHoldTotal(priced);
  if (!Number.isSafeInteger(total.totalMinor)) {
    throw new Error("The selection total exceeds the safe integer range.");
  }
  return {
    totalMinor: total.totalMinor,
    currency: total.currency,
    seatCount: selected.length,
    unpricedSeatIds,
  };
}

export interface SelectedSeatSummary {
  seatId: string;
  sectionName: string;
  sectionCode: string;
  rowLabel: string;
  seatLabel: string;
  seatType: SeatType;
  priceMinor: number | null;
  currency: SupportedCurrency | null;
}

/** Summary lines for the selection panel, in the order the customer chose. */
export function describeSelectedSeats(
  selected: readonly string[],
  seatIndex: SelectionSeatIndex,
): SelectedSeatSummary[] {
  const lines: SelectedSeatSummary[] = [];
  for (const seatId of selected) {
    const entry = seatIndex.get(seatId);
    if (!entry) continue;
    lines.push({
      seatId,
      sectionName: entry.sectionName,
      sectionCode: entry.sectionCode,
      rowLabel: entry.rowLabel,
      seatLabel: entry.seat.label,
      seatType: entry.seat.type,
      priceMinor: entry.seat.priceMinor,
      currency: entry.seat.currency,
    });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Seat visual state (legend semantics; colour is never the only signal)
// ---------------------------------------------------------------------------

export type SeatVisualState =
  | "selected"
  | "premium"
  | "available"
  | "held-by-you"
  | "unavailable"
  | "blocked";

/** Visible legend / accessible text for each visual state. */
export const SEAT_VISUAL_LABELS: Readonly<Record<SeatVisualState, string>> = {
  selected: "Selected",
  premium: "Premium",
  available: "Available",
  "held-by-you": "Held by you",
  unavailable: "Unavailable",
  blocked: "Unavailable",
};

/** CSS custom property (see globals.css, customer scope) for each state. */
export const SEAT_VISUAL_TOKENS: Readonly<Record<SeatVisualState, string>> = {
  selected: "--sf-seat-selected",
  premium: "--sf-seat-premium",
  available: "--sf-seat-available",
  "held-by-you": "--sf-seat-held-by-you",
  unavailable: "--sf-seat-unavailable",
  blocked: "--sf-seat-unavailable",
};

/**
 * Map a server seat state plus local selection to its visual state. The gold
 * "premium" treatment marks only AVAILABLE seats of the published PREMIUM seat
 * type; it is a physical seat type, not a price tier or a VIP product.
 */
export function seatVisualState(
  state: SeatSelectionState,
  seatType: SeatType,
  selected: boolean,
): SeatVisualState {
  if (state === "AVAILABLE") {
    if (selected) return "selected";
    return seatType === "PREMIUM" ? "premium" : "available";
  }
  if (state === "HELD_BY_YOU") return "held-by-you";
  if (state === "BLOCKED") return "blocked";
  return "unavailable";
}
