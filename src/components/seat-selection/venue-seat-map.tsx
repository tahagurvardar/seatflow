"use client";

import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { SeatMapLegend } from "@/components/seat-selection/seat-map-legend";
import {
  type SeatMapViewportHandle,
  SeatMapViewport,
} from "@/components/seat-selection/seat-map-viewport";
import { SeatNode } from "@/components/seat-selection/seat-node";
import type { SupportedCurrency } from "@/config/site";
import { formatMinorCurrency } from "@/features/events/money";
import type {
  SelectionSeatView,
  SelectionSectionView,
} from "@/features/holds/inventory";
import {
  buildSelectionSeatIndex,
  type IndexedSelectionSeat,
  sectionDisplayNames,
  selectionLimitState,
  seatVisualState,
  type SeatVisualState,
} from "@/features/holds/selection";
import {
  buildVenueLayout,
  firstSeatId,
  neighborSeatId,
  type SeatNavigationDirection,
} from "@/features/seat-maps/venue-layout";
import { cn } from "@/lib/utils";

const KEY_DIRECTIONS: Readonly<Record<string, SeatNavigationDirection>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  Home: "rowStart",
  End: "rowEnd",
};

const STATE_TEXT: Readonly<Record<SelectionSeatView["state"], string>> = {
  AVAILABLE: "available",
  HELD_BY_YOU: "held by you",
  UNAVAILABLE: "unavailable",
  BLOCKED: "unavailable",
};

const TYPE_TEXT: Readonly<Record<SelectionSeatView["type"], string>> = {
  STANDARD: "",
  PREMIUM: ", premium seat",
  ACCESSIBLE: ", wheelchair accessible seat",
  COMPANION: ", companion seat",
};

export const SCHEMATIC_NOTICE =
  "Schematic layout: sections are shown in their published order and do not represent their physical position in the venue.";

/**
 * Identity of the static geometry (sections, rows, seat ids, labels and
 * coordinates). Inventory refreshes deliver new objects with the same geometry;
 * comparing this key lets the layout keep a stable identity across them.
 */
export function geometrySignature(sections: readonly SelectionSectionView[]): string {
  const parts: string[] = [];
  for (const section of sections) {
    parts.push(`§${section.id}|${section.name}|${section.code}`);
    for (const row of section.rows) {
      parts.push(`¶${row.id}|${row.label}`);
      for (const seat of row.seats) parts.push(`${seat.seatId}|${seat.label}|${seat.x}|${seat.y}`);
    }
  }
  return parts.join("\n");
}

/**
 * Accessible seat name from real data only: section, row, seat, availability,
 * physical seat type and — when the server exposes it — the price.
 */
export function seatAccessibleName(
  entry: IndexedSelectionSeat,
  formatPrice: (priceMinor: number, currency: SupportedCurrency) => string,
): string {
  const { seat } = entry;
  const price =
    seat.priceMinor !== null && seat.currency !== null
      ? `, ${formatPrice(seat.priceMinor, seat.currency)}`
      : "";
  return `${entry.sectionName}, row ${entry.rowLabel}, seat ${seat.label}, ${STATE_TEXT[seat.state]}${TYPE_TEXT[seat.type]}${price}`;
}

const subscribeNever = () => () => undefined;

/** Focus this soon after a pointer press on a seat came from that press. */
const POINTER_FOCUS_WINDOW_MS = 800;

/**
 * False during server rendering and hydration, true afterwards. The seat layer
 * is invisible until the viewport has measured itself on the client, so
 * server-rendering thousands of seat buttons only cost HTML, parsing and
 * hydration time (≈1.8 MB for 3,000 seats) without showing anything sooner.
 */
function useIsClient() {
  return useSyncExternalStore(subscribeNever, () => true, () => false);
}

/** Seat ids are opaque database ids; a newline never occurs inside one. */
const SELECTED_KEY_SEPARATOR = "\n";

interface RowSeat {
  seatId: string;
  x: number;
  y: number;
  state: SelectionSeatView["state"];
  type: SelectionSeatView["type"];
  name: string;
}

interface SeatRowGroupProps {
  seats: readonly RowSeat[];
  seatSize: number;
  /** Selected seat ids of this row, joined; "" when none. */
  selectedKey: string;
  /** The roving tab stop when it is in this row, otherwise null. */
  tabbableSeatId: string | null;
  atLimit: boolean;
  interactive: boolean;
}

/**
 * One row of seats. Rows receive stable seat arrays plus small primitive keys,
 * so moving keyboard focus or selecting a seat re-renders only the affected
 * rows (and, inside them, only the seats whose props changed).
 */
const SeatRowGroup = memo(function SeatRowGroup({
  seats,
  seatSize,
  selectedKey,
  tabbableSeatId,
  atLimit,
  interactive,
}: SeatRowGroupProps) {
  const selected = new Set(selectedKey === "" ? [] : selectedKey.split(SELECTED_KEY_SEPARATOR));
  return seats.map((seat) => {
    const isSelected = selected.has(seat.seatId);
    const available = seat.state === "AVAILABLE";
    const limitReached = interactive && atLimit && available && !isSelected;
    return (
      <SeatNode
        key={seat.seatId}
        seatId={seat.seatId}
        x={seat.x}
        y={seat.y}
        size={seatSize}
        visualState={seatVisualState(seat.state, seat.type, isSelected)}
        accessibleName={limitReached ? `${seat.name}, selection limit reached` : seat.name}
        pressed={interactive ? isSelected : undefined}
        inert={!interactive || (!isSelected && (!available || atLimit))}
        tabbable={seat.seatId === tabbableSeatId}
      />
    );
  });
});

interface VenueSeatMapProps {
  /** Latest authoritative snapshot, sections in published display order. */
  sections: readonly SelectionSectionView[];
  selectedSeatIds: readonly string[];
  /** Server-provided seat ceiling for one hold. */
  maxSeats: number;
  /** Omit for a read-only availability preview. */
  onToggleSeat?: (seatId: string) => void;
  label?: string;
  className?: string;
}

/**
 * Customer seat map on the schematic venue layout. Selection is controlled by
 * the parent and is local intent only — holds are created and confirmed by the
 * server elsewhere. One roving tab stop covers every seat; arrow keys, Home and
 * End move between seats using the layout's neighbour rules.
 */
export function VenueSeatMap({
  sections,
  selectedSeatIds,
  maxSeats,
  onToggleSeat,
  label = "Seat map",
  className,
}: VenueSeatMapProps) {
  const jumpId = useId();
  const viewportRef = useRef<SeatMapViewportHandle>(null);
  const seatLayerRef = useRef<HTMLDivElement>(null);
  const pendingFocusRef = useRef(false);
  const pointerPressRef = useRef(Number.NEGATIVE_INFINITY);
  const [activeSeatId, setActiveSeatId] = useState<string | null>(null);
  const [jumpValue, setJumpValue] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const isClient = useIsClient();

  const interactive = onToggleSeat !== undefined;
  const geometryKey = useMemo(() => geometrySignature(sections), [sections]);
  // Rebuild geometry only when the geometry itself changes, never on a plain
  // availability refresh, so seat positions and DOM identity stay stable.
  const layout = useMemo(
    () => buildVenueLayout(sections),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [geometryKey],
  );
  const seatIndex = useMemo(() => buildSelectionSeatIndex(sections), [sections]);
  const sectionNames = useMemo(() => sectionDisplayNames(layout.sections), [layout]);

  const accessibleNames = useMemo(() => {
    // Few distinct prices exist, so cache formatted strings instead of building
    // an Intl.NumberFormat for every seat.
    const priceCache = new Map<string, string>();
    const formatPrice = (priceMinor: number, currency: SupportedCurrency) => {
      const key = `${currency}:${priceMinor}`;
      let formatted = priceCache.get(key);
      if (formatted === undefined) {
        formatted = formatMinorCurrency(priceMinor, currency);
        priceCache.set(key, formatted);
      }
      return formatted;
    };
    const names = new Map<string, string>();
    for (const [seatId, entry] of seatIndex) names.set(seatId, seatAccessibleName(entry, formatPrice));
    return names;
  }, [seatIndex]);

  // Static per-row render data; rebuilt only for new geometry or a new snapshot.
  const rows = useMemo(
    () =>
      layout.sections.flatMap((section) =>
        section.rows
          .filter((row) => row.seatIndices.length > 0)
          .map((row) => ({
            key: `${section.id}/${row.id}`,
            seats: row.seatIndices.flatMap((index): RowSeat[] => {
              const placed = layout.seats[index]!;
              const entry = seatIndex.get(placed.seatId);
              if (!entry) return [];
              return [
                {
                  seatId: placed.seatId,
                  x: placed.x,
                  y: placed.y,
                  state: entry.seat.state,
                  type: entry.seat.type,
                  name: accessibleNames.get(placed.seatId)!,
                },
              ];
            }),
          })),
      ),
    [layout, seatIndex, accessibleNames],
  );

  const rowKeyOf = (seatId: string) => {
    const index = layout.seatIndexById.get(seatId);
    if (index === undefined) return null;
    const placed = layout.seats[index]!;
    return `${placed.sectionId}/${placed.rowId}`;
  };

  const selectedByRow = useMemo(() => {
    const byRow = new Map<string, string[]>();
    for (const seatId of selectedSeatIds) {
      const index = layout.seatIndexById.get(seatId);
      if (index === undefined) continue;
      const placed = layout.seats[index]!;
      const key = `${placed.sectionId}/${placed.rowId}`;
      byRow.set(key, [...(byRow.get(key) ?? []), seatId]);
    }
    return new Map([...byRow].map(([key, ids]) => [key, ids.join(SELECTED_KEY_SEPARATOR)]));
  }, [layout, selectedSeatIds]);
  const { atLimit } = selectionLimitState(selectedSeatIds, maxSeats);

  // The roving stop survives refreshes while its seat exists in the geometry;
  // otherwise it falls back deterministically to the first seat.
  const rovingSeatId =
    activeSeatId !== null && layout.seatIndexById.has(activeSeatId)
      ? activeSeatId
      : firstSeatId(layout);
  const rovingRowKey = rovingSeatId === null ? null : rowKeyOf(rovingSeatId);

  useEffect(() => {
    if (!pendingFocusRef.current || rovingSeatId === null) return;
    pendingFocusRef.current = false;
    const element = seatLayerRef.current?.querySelector<HTMLElement>(
      `[data-seat-id="${rovingSeatId.replace(/["\\]/g, "\\$&")}"]`,
    );
    // The viewport pans via transform; native focus scrolling would fight it.
    element?.focus({ preventScroll: true });
  }, [rovingSeatId]);

  const legendStates = useMemo(() => {
    const present = new Set<SeatVisualState>();
    for (const { seat } of seatIndex.values()) present.add(seatVisualState(seat.state, seat.type, false));
    const states: SeatVisualState[] = ["available"];
    if (interactive) states.push("selected");
    if (present.has("premium")) states.push("premium");
    if (present.has("held-by-you")) states.push("held-by-you");
    if (present.has("unavailable") || present.has("blocked")) states.push("unavailable");
    return states;
  }, [interactive, seatIndex]);

  if (layout.seats.length === 0) {
    return (
      <div
        data-theme-scope="customer"
        className={cn("rounded-[var(--sf-radius-card)] bg-[var(--sf-surface)] p-6 text-center text-sm text-[var(--sf-text-secondary)]", className)}
        role="status"
      >
        No seats are available for this session.
      </div>
    );
  }

  function seatRect(seatId: string) {
    const seat = layout.seats[layout.seatIndexById.get(seatId)!]!;
    return { x: seat.x, y: seat.y, width: layout.seatSize, height: layout.seatSize };
  }

  function seatIdFromEvent(event: { target: EventTarget }) {
    return (event.target as HTMLElement).closest<HTMLElement>("[data-seat-id]")?.dataset.seatId ?? null;
  }

  function onSeatKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const seatId = seatIdFromEvent(event);
    const direction = KEY_DIRECTIONS[event.key];
    if (!seatId || !direction || event.altKey || event.ctrlKey || event.metaKey) return;
    // Arrow keys never scroll the page while a seat has focus.
    event.preventDefault();
    const next = neighborSeatId(layout, seatId, direction);
    if (next === null) return;
    pendingFocusRef.current = true;
    setActiveSeatId(next);
  }

  function onSeatFocus(event: FocusEvent<HTMLDivElement>) {
    const seatId = seatIdFromEvent(event);
    if (!seatId) return;
    setActiveSeatId(seatId);
    // Keyboard focus follows the seat into view. A tap or click already
    // targets a visible seat; panning under the finger would move the map
    // mid-press (and, on a slow device, make the click miss the seat).
    // (Touch browsers focus on the compatibility mousedown after touchend,
    // hence a short time window rather than a pressed flag.)
    const sincePress = event.timeStamp - pointerPressRef.current;
    pointerPressRef.current = Number.NEGATIVE_INFINITY;
    if (sincePress >= 0 && sincePress < POINTER_FOCUS_WINDOW_MS) return;
    viewportRef.current?.reveal(seatRect(seatId));
  }

  function onSeatClick(event: MouseEvent<HTMLDivElement>) {
    const seatId = seatIdFromEvent(event);
    if (!seatId) return;
    setActiveSeatId(seatId);
    const button = (event.target as HTMLElement).closest("[data-seat-id]");
    if (!interactive || button?.getAttribute("aria-disabled") === "true") return;
    onToggleSeat?.(seatId);
  }

  function jumpToSection(sectionId: string) {
    setJumpValue(sectionId);
    const section = layout.sections.find((entry) => entry.id === sectionId);
    if (!section) return;
    viewportRef.current?.showRect(section.bounds);
    const firstRow = section.rows.find((row) => row.seatIndices.length > 0);
    if (firstRow) setActiveSeatId(layout.seats[firstRow.seatIndices[0]!]!.seatId);
    setAnnouncement(`Showing ${section.name}. Press Tab to move to its first seat.`);
  }

  const firstSection = layout.sections[0]!;
  const initialFocus = {
    x: firstSection.bounds.x,
    y: layout.stage.y,
    width: firstSection.bounds.width,
    height: firstSection.bounds.y + firstSection.bounds.height - layout.stage.y,
  };

  return (
    <div
      data-theme-scope="customer"
      className={cn("space-y-4 rounded-[var(--sf-radius-card)] bg-[var(--sf-canvas)] p-4 text-[var(--sf-text)] sm:p-5", className)}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SeatMapLegend states={legendStates} />
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
          <label htmlFor={jumpId} className="text-sm font-semibold text-[var(--sf-text-secondary)]">
            Jump to section
          </label>
          <select
            id={jumpId}
            value={jumpValue}
            onChange={(event) => jumpToSection(event.target.value)}
            className="min-h-11 w-full rounded-[var(--sf-radius-input)] border border-[var(--sf-border)] bg-[var(--sf-surface)] px-3 text-sm text-[var(--sf-text)] outline-none focus-visible:ring-4 focus-visible:ring-[var(--sf-focus)] sm:w-auto"
          >
            <option value="" disabled>
              Choose a section
            </option>
            {layout.sections
              .filter((section) => section.rows.some((row) => row.seatIndices.length > 0))
              .map((section) => (
                <option key={section.id} value={section.id}>
                  {sectionNames.get(section.id) ?? section.name}
                </option>
              ))}
          </select>
        </div>
      </div>

      <p role="note" className="text-xs text-[var(--sf-text-muted)]">
        {SCHEMATIC_NOTICE}
      </p>

      <SeatMapViewport
        ref={viewportRef}
        contentWidth={layout.width}
        contentHeight={layout.height}
        seatSize={layout.seatSize}
        initialFocus={initialFocus}
        label={label}
        className="h-[min(70vh,640px)] min-h-[360px]"
      >
        <div
          aria-hidden="true"
          className="absolute flex items-center justify-center rounded-b-[var(--sf-radius-hero)] bg-[var(--sf-surface-raised)] text-sm font-black uppercase tracking-[0.24em] text-[var(--sf-text-secondary)]"
          style={{ left: layout.stage.x, top: layout.stage.y, width: layout.stage.width, height: layout.stage.height }}
        >
          Stage / screen
        </div>
        {layout.sections.map((section) => (
          <div key={section.id} aria-hidden="true">
            <div
              className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap text-base font-black text-[var(--sf-text)]"
              style={{ left: section.headingPosition.x, top: section.headingPosition.y }}
            >
              {section.name}
              {/* A code that only abbreviates the name ("VIP VIP") is not repeated. */}
              {sectionNames.get(section.id) !== section.name ? (
                <span className="ml-1.5 font-mono text-xs text-[var(--sf-text-muted)]">{section.code}</span>
              ) : null}
            </div>
            {section.rows.map((row) =>
              row.labelPosition ? (
                <div
                  key={row.id}
                  className="absolute -translate-x-1/2 -translate-y-1/2 font-mono text-xs font-bold text-[var(--sf-text-muted)]"
                  style={{ left: row.labelPosition.x, top: row.labelPosition.y }}
                >
                  {row.label}
                </div>
              ) : null,
            )}
          </div>
        ))}
        <div
          ref={seatLayerRef}
          role="group"
          aria-label={`${label}: use arrow keys to move between seats${interactive ? ", Enter or Space to select" : ""}`}
          onKeyDown={(event) => {
            pointerPressRef.current = Number.NEGATIVE_INFINITY;
            onSeatKeyDown(event);
          }}
          onPointerDown={(event) => {
            pointerPressRef.current = event.timeStamp;
          }}
          onFocus={onSeatFocus}
          onClick={onSeatClick}
        >
          {isClient && rows.map((row) => (
            <SeatRowGroup
              key={row.key}
              seats={row.seats}
              seatSize={layout.seatSize}
              selectedKey={selectedByRow.get(row.key) ?? ""}
              tabbableSeatId={row.key === rovingRowKey ? rovingSeatId : null}
              atLimit={atLimit}
              interactive={interactive}
            />
          ))}
        </div>
      </SeatMapViewport>

      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
