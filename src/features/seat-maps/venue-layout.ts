// ---------------------------------------------------------------------------
// Customer venue layout (pure presentation geometry)
// ---------------------------------------------------------------------------
//
// Published seat maps store seat coordinates relative to their own section and
// carry no section placement or stage position. This module therefore builds a
// *schematic* layout: sections are stacked below a stage band in their published
// display order (the order the caller passes them in), each section keeps its
// real relative seat geometry, and nothing implies where sections physically sit
// in the venue. The `kind` field lets a future layout strategy based on real
// venue coordinates replace this one without changing consumers.
//
// Everything here is deterministic and free of inventory, price, or hold logic.

export type VenueLayoutKind = "schematic-stacked";

export type SeatNavigationDirection =
  | "left"
  | "right"
  | "up"
  | "down"
  | "rowStart"
  | "rowEnd";

export interface LayoutSeatInput {
  seatId: string;
  label: string;
  x: number;
  y: number;
}

export interface LayoutRowInput<TSeat extends LayoutSeatInput = LayoutSeatInput> {
  id: string;
  label: string;
  seats: readonly TSeat[];
}

export interface LayoutSectionInput<TSeat extends LayoutSeatInput = LayoutSeatInput> {
  id: string;
  name: string;
  code: string;
  rows: readonly LayoutRowInput<TSeat>[];
}

export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutSeat {
  seatId: string;
  label: string;
  sectionId: string;
  sectionIndex: number;
  rowId: string;
  rowLabel: string;
  rowIndex: number;
  /** Position of this seat within its row, ordered left to right. */
  positionInRow: number;
  /** Top-left corner of the seat in layout units. */
  x: number;
  y: number;
}

export interface LayoutRow {
  id: string;
  label: string;
  /** Indices into `VenueLayout.seats`, ordered left to right. */
  seatIndices: number[];
  /** Where the row label sits, or null for a row without seats. */
  labelPosition: { x: number; y: number } | null;
}

export interface LayoutSection {
  id: string;
  name: string;
  code: string;
  index: number;
  /** Outer bounds of the section block, including its heading and row labels. */
  bounds: LayoutRect;
  /** Anchor for the section heading, centred above its seats. */
  headingPosition: { x: number; y: number };
  rows: LayoutRow[];
}

export interface VenueLayout {
  kind: VenueLayoutKind;
  width: number;
  height: number;
  seatSize: number;
  stage: LayoutRect;
  sections: LayoutSection[];
  seats: LayoutSeat[];
  seatIndexById: ReadonlyMap<string, number>;
}

export interface VenueLayoutOptions {
  /** Rendered seat edge length in layout units. */
  seatSize?: number;
  /** Horizontal space reserved left of each section for row labels. */
  rowLabelGutter?: number;
  /** Vertical space reserved above each section for its heading. */
  sectionHeadingHeight?: number;
  /** Vertical gap between stacked sections. */
  sectionGap?: number;
  /** Height of the stage band. */
  stageHeight?: number;
  /** Gap between the stage band and the first section. */
  stageGap?: number;
  /** Outer padding around the whole layout. */
  padding?: number;
}

export const DEFAULT_VENUE_LAYOUT_OPTIONS: Required<VenueLayoutOptions> = {
  seatSize: 36,
  rowLabelGutter: 40,
  sectionHeadingHeight: 48,
  sectionGap: 40,
  stageHeight: 56,
  stageGap: 48,
  padding: 24,
};

function compareSeatsLeftToRight(first: LayoutSeatInput, second: LayoutSeatInput) {
  return (
    first.x - second.x ||
    first.y - second.y ||
    first.label.localeCompare(second.label, undefined, { numeric: true }) ||
    (first.seatId < second.seatId ? -1 : first.seatId > second.seatId ? 1 : 0)
  );
}

function assertFiniteCoordinate(seat: LayoutSeatInput) {
  if (!Number.isFinite(seat.x) || !Number.isFinite(seat.y)) {
    throw new Error(`Seat ${seat.seatId} has a non-finite coordinate.`);
  }
}

/**
 * Build the schematic stacked layout for a customer seat map. Sections must be
 * passed in their published display order; rows and seats keep the order and
 * relative coordinates of the published map. Each section is translated so its
 * top-left seat starts at the section origin, then centred horizontally on the
 * widest section. Seat geometry inside a section is never altered.
 */
export function buildVenueLayout<TSeat extends LayoutSeatInput>(
  sections: readonly LayoutSectionInput<TSeat>[],
  options: VenueLayoutOptions = {},
): VenueLayout {
  const config = { ...DEFAULT_VENUE_LAYOUT_OPTIONS, ...options };
  const seatIndexById = new Map<string, number>();
  const seats: LayoutSeat[] = [];

  // First pass: per-section extents in section-local units.
  const extents = sections.map((section) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const row of section.rows) {
      for (const seat of row.seats) {
        assertFiniteCoordinate(seat);
        if (seat.x < minX) minX = seat.x;
        if (seat.y < minY) minY = seat.y;
        if (seat.x > maxX) maxX = seat.x;
        if (seat.y > maxY) maxY = seat.y;
      }
    }
    const hasSeats = Number.isFinite(minX);
    const seatsWidth = hasSeats ? maxX - minX + config.seatSize : 0;
    const seatsHeight = hasSeats ? maxY - minY + config.seatSize : 0;
    return {
      minX: hasSeats ? minX : 0,
      minY: hasSeats ? minY : 0,
      width: config.rowLabelGutter + seatsWidth,
      height: config.sectionHeadingHeight + seatsHeight,
      seatsWidth,
    };
  });

  const contentWidth = Math.max(0, ...extents.map((extent) => extent.width));
  const width = contentWidth + config.padding * 2;
  const stage: LayoutRect = {
    x: config.padding,
    y: config.padding,
    width: contentWidth,
    height: config.stageHeight,
  };

  let cursorY = stage.y + stage.height + config.stageGap;
  const layoutSections: LayoutSection[] = sections.map((section, sectionIndex) => {
    const extent = extents[sectionIndex]!;
    const originX = config.padding + (contentWidth - extent.width) / 2;
    const seatsOriginX = originX + config.rowLabelGutter;
    const seatsOriginY = cursorY + config.sectionHeadingHeight;

    const rows: LayoutRow[] = section.rows.map((row, rowIndex) => {
      const ordered = [...row.seats].sort(compareSeatsLeftToRight);
      const seatIndices = ordered.map((seat, positionInRow) => {
        if (seatIndexById.has(seat.seatId)) {
          throw new Error(`Seat ${seat.seatId} appears more than once in the seat map.`);
        }
        const index = seats.length;
        seats.push({
          seatId: seat.seatId,
          label: seat.label,
          sectionId: section.id,
          sectionIndex,
          rowId: row.id,
          rowLabel: row.label,
          rowIndex,
          positionInRow,
          x: seatsOriginX + seat.x - extent.minX,
          y: seatsOriginY + seat.y - extent.minY,
        });
        seatIndexById.set(seat.seatId, index);
        return index;
      });

      const first = seatIndices.length > 0 ? seats[seatIndices[0]!]! : null;
      const rowTop =
        first === null
          ? 0
          : Math.min(...seatIndices.map((index) => seats[index]!.y));
      return {
        id: row.id,
        label: row.label,
        seatIndices,
        labelPosition:
          first === null
            ? null
            : { x: originX + config.rowLabelGutter / 2, y: rowTop + config.seatSize / 2 },
      };
    });

    const bounds: LayoutRect = {
      x: originX,
      y: cursorY,
      width: extent.width,
      height: extent.height,
    };
    cursorY += extent.height + config.sectionGap;

    return {
      id: section.id,
      name: section.name,
      code: section.code,
      index: sectionIndex,
      bounds,
      headingPosition: {
        x: seatsOriginX + extent.seatsWidth / 2,
        y: bounds.y + config.sectionHeadingHeight / 2,
      },
      rows,
    };
  });

  const lastSectionBottom =
    layoutSections.length > 0
      ? cursorY - config.sectionGap
      : stage.y + stage.height;

  return {
    kind: "schematic-stacked",
    width,
    height: lastSectionBottom + config.padding,
    seatSize: config.seatSize,
    stage,
    sections: layoutSections,
    seats,
    seatIndexById,
  };
}

/** Union of the given seats' rectangles, or null when no seat matches. */
export function seatBounds(
  layout: VenueLayout,
  seatIds: Iterable<string>,
): LayoutRect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const seatId of seatIds) {
    const index = layout.seatIndexById.get(seatId);
    if (index === undefined) continue;
    const seat = layout.seats[index]!;
    minX = Math.min(minX, seat.x);
    minY = Math.min(minY, seat.y);
    maxX = Math.max(maxX, seat.x + layout.seatSize);
    maxY = Math.max(maxY, seat.y + layout.seatSize);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function rowAt(layout: VenueLayout, sectionIndex: number, rowIndex: number) {
  return layout.sections[sectionIndex]?.rows[rowIndex];
}

/**
 * Find the nearest non-empty row above or below, crossing into the previous or
 * next section when the current section has no further rows in that direction.
 */
function adjacentRow(
  layout: VenueLayout,
  seat: LayoutSeat,
  step: -1 | 1,
): LayoutRow | null {
  let sectionIndex = seat.sectionIndex;
  let rowIndex = seat.rowIndex + step;
  while (sectionIndex >= 0 && sectionIndex < layout.sections.length) {
    const section = layout.sections[sectionIndex]!;
    while (rowIndex >= 0 && rowIndex < section.rows.length) {
      const row = rowAt(layout, sectionIndex, rowIndex)!;
      if (row.seatIndices.length > 0) return row;
      rowIndex += step;
    }
    sectionIndex += step;
    const next = layout.sections[sectionIndex];
    if (!next) break;
    rowIndex = step === 1 ? 0 : next.rows.length - 1;
  }
  return null;
}

function nearestByCentre(layout: VenueLayout, row: LayoutRow, centreX: number) {
  let best = row.seatIndices[0]!;
  let bestDistance = Infinity;
  for (const index of row.seatIndices) {
    const distance = Math.abs(layout.seats[index]!.x - centreX);
    // Strictly smaller keeps the leftmost seat on ties, so results are stable.
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Directional keyboard navigation over the layout. Left/right move within the
 * row, up/down move to the visually nearest seat in the adjacent non-empty row
 * (crossing sections), and rowStart/rowEnd jump to the row's ends. Returns the
 * target seat id, or null at an edge or for an unknown seat. All seats are
 * reachable, including unavailable ones, so their state can still be announced.
 */
export function neighborSeatId(
  layout: VenueLayout,
  seatId: string,
  direction: SeatNavigationDirection,
): string | null {
  const index = layout.seatIndexById.get(seatId);
  if (index === undefined) return null;
  const seat = layout.seats[index]!;
  const row = rowAt(layout, seat.sectionIndex, seat.rowIndex)!;

  let targetIndex: number | undefined;
  switch (direction) {
    case "left":
      targetIndex = row.seatIndices[seat.positionInRow - 1];
      break;
    case "right":
      targetIndex = row.seatIndices[seat.positionInRow + 1];
      break;
    case "rowStart":
      targetIndex = row.seatIndices[0];
      break;
    case "rowEnd":
      targetIndex = row.seatIndices[row.seatIndices.length - 1];
      break;
    case "up":
    case "down": {
      const target = adjacentRow(layout, seat, direction === "up" ? -1 : 1);
      targetIndex = target ? nearestByCentre(layout, target, seat.x) : undefined;
      break;
    }
  }

  if (targetIndex === undefined || targetIndex === index) return null;
  return layout.seats[targetIndex]!.seatId;
}

/** First seat in reading order (first non-empty row, leftmost seat), or null. */
export function firstSeatId(layout: VenueLayout): string | null {
  return layout.seats[0]?.seatId ?? null;
}
