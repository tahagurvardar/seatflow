import type { SupportedCurrency } from "@/config/site";
import type {
  SeatInventoryState,
  SeatState,
  SeatType,
} from "@/generated/prisma/enums";

// ---------------------------------------------------------------------------
// Inventory materialization (pure derivation from a published session graph)
// ---------------------------------------------------------------------------

interface MaterializationSeat {
  id: string;
  state: SeatState;
}

interface MaterializationSection {
  id: string;
  rows: Array<{ seats: MaterializationSeat[] }>;
}

interface MaterializationTier {
  id: string;
  priceMinor: number;
  currency: SupportedCurrency;
}

interface MaterializationAssignment {
  sectionId: string;
  priceTierId: string;
}

export interface MaterializedInventoryRow {
  seatId: string;
  sectionId: string;
  priceTierId: string;
  priceMinor: number;
  currency: SupportedCurrency;
}

export interface MaterializationSource {
  sections: MaterializationSection[];
  priceTiers: MaterializationTier[];
  sectionPricing: MaterializationAssignment[];
}

/**
 * Derive the authoritative sellable inventory for a session from its immutable
 * published seat map and section pricing. Blocked physical seats are excluded,
 * and every row carries the price snapshot of its section's assigned tier. The
 * result contains exactly one row per active seat in a priced section — i.e. the
 * session's sellable capacity. Client input is never involved.
 */
export function computeSessionInventoryRows(
  source: MaterializationSource,
): MaterializedInventoryRow[] {
  const tierById = new Map(source.priceTiers.map((tier) => [tier.id, tier]));
  const tierBySection = new Map(
    source.sectionPricing.map((assignment) => [
      assignment.sectionId,
      assignment.priceTierId,
    ]),
  );

  const rows: MaterializedInventoryRow[] = [];
  for (const section of source.sections) {
    const tierId = tierBySection.get(section.id);
    const tier = tierId ? tierById.get(tierId) : undefined;
    if (!tier) continue; // Unpriced sections never produce inventory.

    for (const row of section.rows) {
      for (const seat of row.seats) {
        if (seat.state !== "ACTIVE") continue; // Blocked seats are never sellable.
        rows.push({
          seatId: seat.id,
          sectionId: section.id,
          priceTierId: tier.id,
          priceMinor: tier.priceMinor,
          currency: tier.currency,
        });
      }
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Seat-selection state mapping (what a specific customer may see and select)
// ---------------------------------------------------------------------------

export type SeatSelectionState =
  | "AVAILABLE"
  | "HELD_BY_YOU"
  | "UNAVAILABLE"
  | "BLOCKED";

export interface SelectionSeatView {
  seatId: string;
  label: string;
  x: number;
  y: number;
  type: SeatType;
  state: SeatSelectionState;
  /** Price is exposed only for seats the customer could select. */
  priceMinor: number | null;
  currency: SupportedCurrency | null;
}

export interface SelectionSectionView {
  id: string;
  name: string;
  code: string;
  rows: Array<{ id: string; label: string; seats: SelectionSeatView[] }>;
}

interface SeatMapSeat {
  id: string;
  label: string;
  x: number;
  y: number;
  type: SeatType;
  state: SeatState;
}

interface SeatMapSection {
  id: string;
  name: string;
  code: string;
  rows: Array<{ id: string; label: string; seats: SeatMapSeat[] }>;
}

export interface InventorySnapshot {
  seatId: string;
  state: SeatInventoryState;
  currentHoldId: string | null;
  priceMinor: number;
  currency: SupportedCurrency;
}

/**
 * Map every physical seat of the published map to the state a specific customer
 * may act on. Seats held by other customers are reported only as UNAVAILABLE —
 * never with another customer's identity or token. An active seat missing from
 * inventory is treated as UNAVAILABLE rather than silently sellable.
 */
export function mapSeatSelectionSections(
  sections: SeatMapSection[],
  inventory: InventorySnapshot[],
  viewerHoldId: string | null,
): SelectionSectionView[] {
  const inventoryBySeatId = new Map(
    inventory.map((entry) => [entry.seatId, entry]),
  );

  return sections.map((section) => ({
    id: section.id,
    name: section.name,
    code: section.code,
    rows: section.rows.map((row) => ({
      id: row.id,
      label: row.label,
      seats: row.seats.map((seat) =>
        mapSeat(seat, inventoryBySeatId.get(seat.id), viewerHoldId),
      ),
    })),
  }));
}

function mapSeat(
  seat: SeatMapSeat,
  snapshot: InventorySnapshot | undefined,
  viewerHoldId: string | null,
): SelectionSeatView {
  const base = {
    seatId: seat.id,
    label: seat.label,
    x: seat.x,
    y: seat.y,
    type: seat.type,
  };

  if (seat.state === "BLOCKED" || !snapshot) {
    return {
      ...base,
      state: seat.state === "BLOCKED" ? "BLOCKED" : "UNAVAILABLE",
      priceMinor: null,
      currency: null,
    };
  }

  let state: SeatSelectionState;
  if (snapshot.state === "AVAILABLE") {
    state = "AVAILABLE";
  } else if (viewerHoldId && snapshot.currentHoldId === viewerHoldId) {
    state = "HELD_BY_YOU";
  } else {
    state = "UNAVAILABLE";
  }

  const selectable = state === "AVAILABLE" || state === "HELD_BY_YOU";
  return {
    ...base,
    state,
    priceMinor: selectable ? snapshot.priceMinor : null,
    currency: selectable ? snapshot.currency : null,
  };
}

export interface SelectionAvailabilityCounts {
  total: number;
  available: number;
  heldByYou: number;
  unavailable: number;
  blocked: number;
}

export function countSelectionStates(
  sections: SelectionSectionView[],
): SelectionAvailabilityCounts {
  const counts: SelectionAvailabilityCounts = {
    total: 0,
    available: 0,
    heldByYou: 0,
    unavailable: 0,
    blocked: 0,
  };

  for (const section of sections) {
    for (const row of section.rows) {
      for (const seat of row.seats) {
        counts.total += 1;
        if (seat.state === "AVAILABLE") counts.available += 1;
        else if (seat.state === "HELD_BY_YOU") counts.heldByYou += 1;
        else if (seat.state === "BLOCKED") counts.blocked += 1;
        else counts.unavailable += 1;
      }
    }
  }

  return counts;
}
