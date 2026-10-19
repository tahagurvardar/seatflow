"use client";

import {
  type KeyboardEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { SEAT_STATE_CLASSES, SEAT_STATE_GLYPHS } from "@/components/seat-selection/seat-node";
import { formatMinorCurrency } from "@/features/events/money";
import type {
  SelectionPriceTierView,
  SelectionSeatView,
  SelectionSectionView,
} from "@/features/holds/inventory";
import {
  SEAT_VISUAL_LABELS,
  sectionDisplayNames,
  seatVisualState,
  selectionLimitState,
} from "@/features/holds/selection";
import { cn } from "@/lib/utils";

const TYPE_LABELS: Readonly<Record<SelectionSeatView["type"], string | null>> = {
  STANDARD: null,
  PREMIUM: "Premium seat",
  ACCESSIBLE: "Wheelchair accessible",
  COMPANION: "Companion seat",
};

const STATE_LABELS: Readonly<Record<SelectionSeatView["state"], string>> = {
  AVAILABLE: "Available",
  HELD_BY_YOU: "Held by you",
  UNAVAILABLE: "Unavailable",
  BLOCKED: "Unavailable",
};

const SEAT_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

function availableCount(seats: readonly SelectionSeatView[]) {
  return seats.reduce((total, seat) => total + (seat.state === "AVAILABLE" ? 1 : 0), 0);
}

function sortedSeats(seats: readonly SelectionSeatView[]) {
  return [...seats].sort(
    (first, second) =>
      first.x - second.x ||
      first.label.localeCompare(second.label, undefined, { numeric: true }) ||
      (first.seatId < second.seatId ? -1 : first.seatId > second.seatId ? 1 : 0),
  );
}

/** Section with available seats first, otherwise the first section. */
function defaultSection(sections: readonly SelectionSectionView[]) {
  return (
    sections.find((section) => section.rows.some((row) => availableCount(row.seats) > 0)) ??
    sections[0]
  );
}

function defaultRow(section: SelectionSectionView | undefined) {
  if (!section) return undefined;
  return section.rows.find((row) => availableCount(row.seats) > 0) ?? section.rows[0];
}

interface SeatListPickerProps {
  /** Latest authoritative snapshot, sections in published display order. */
  sections: readonly SelectionSectionView[];
  /** Real session tiers, used to name each seat's price tier. */
  priceTiers?: readonly SelectionPriceTierView[];
  selectedSeatIds: readonly string[];
  /** Server-provided seat ceiling for one hold. */
  maxSeats: number;
  onToggleSeat: (seatId: string) => void;
  className?: string;
}

/**
 * Accessible list alternative to the seat map: choose a section, then a row,
 * then seats as large toggle buttons. It shares the same controlled selection
 * as the map, so both always show the same seats. Selecting a seat here is
 * local intent only; nothing is reserved until the server confirms a hold.
 */
export function SeatListPicker({
  sections,
  priceTiers = [],
  selectedSeatIds,
  maxSeats,
  onToggleSeat,
  className,
}: SeatListPickerProps) {
  const sectionSelectId = useId();
  const rowSelectId = useId();
  const statusId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [rowId, setRowId] = useState<string | null>(null);
  const [activeSeatId, setActiveSeatId] = useState<string | null>(null);

  // Choices survive refreshes while they still exist; otherwise fall back
  // deterministically to the first section/row with available seats.
  const section =
    sections.find((entry) => entry.id === sectionId) ?? defaultSection(sections);
  const row = section?.rows.find((entry) => entry.id === rowId) ?? defaultRow(section);
  // A row holds at most 80 seats, so sorting per render is cheap.
  const seats = row ? sortedSeats(row.seats) : [];
  const tierNames = useMemo(
    () => new Map(priceTiers.map((tier) => [tier.id, tier.name])),
    [priceTiers],
  );
  const selected = useMemo(() => new Set(selectedSeatIds), [selectedSeatIds]);
  const sectionNames = useMemo(() => sectionDisplayNames(sections), [sections]);
  const limit = selectionLimitState(selectedSeatIds, maxSeats);
  const rovingSeatId =
    seats.find((seat) => seat.seatId === activeSeatId)?.seatId ?? seats[0]?.seatId ?? null;

  if (sections.length === 0 || !section) {
    return (
      <p role="status" className={cn("text-sm text-[var(--sf-text-secondary)]", className)}>
        No seats are available for this session.
      </p>
    );
  }

  function chooseSection(nextId: string) {
    const next = sections.find((entry) => entry.id === nextId);
    setSectionId(nextId);
    setRowId(defaultRow(next)?.id ?? null);
    setActiveSeatId(null);
  }

  function chooseRow(nextId: string) {
    setRowId(nextId);
    setActiveSeatId(null);
  }

  function onSeatKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!SEAT_KEYS.has(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const last = seats.length - 1;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? last
          : event.key === "ArrowLeft" || event.key === "ArrowUp"
            ? Math.max(0, index - 1)
            : Math.min(last, index + 1);
    const next = seats[nextIndex];
    if (!next) return;
    setActiveSeatId(next.seatId);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-list-seat-id="${next.seatId.replace(/["\\]/g, "\\$&")}"]`)
      ?.focus();
  }

  const selectClass =
    "min-h-11 w-full rounded-[var(--sf-radius-input)] border border-[var(--sf-border)] bg-[var(--sf-surface)] px-3 text-base text-[var(--sf-text)] outline-none focus-visible:ring-4 focus-visible:ring-[var(--sf-focus)]";

  return (
    <div
      data-theme-scope="customer"
      className={cn("space-y-4 text-[var(--sf-text)]", className)}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor={sectionSelectId} className="text-sm font-semibold text-[var(--sf-text-secondary)]">
            Section
          </label>
          <select
            id={sectionSelectId}
            value={section.id}
            onChange={(event) => chooseSection(event.target.value)}
            className={selectClass}
          >
            {sections.map((entry) => {
              const available = entry.rows.reduce((total, sectionRow) => total + availableCount(sectionRow.seats), 0);
              return (
                <option key={entry.id} value={entry.id}>
                  {sectionNames.get(entry.id) ?? entry.name} — {available} available
                </option>
              );
            })}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor={rowSelectId} className="text-sm font-semibold text-[var(--sf-text-secondary)]">
            Row
          </label>
          <select
            id={rowSelectId}
            value={row?.id ?? ""}
            onChange={(event) => chooseRow(event.target.value)}
            disabled={section.rows.length === 0}
            className={selectClass}
          >
            {section.rows.map((entry) => (
              <option key={entry.id} value={entry.id}>
                Row {entry.label} — {availableCount(entry.seats)} available
              </option>
            ))}
          </select>
        </div>
      </div>

      <p id={statusId} role="status" aria-live="polite" className="text-sm text-[var(--sf-text-secondary)]">
        {limit.count} of {limit.maxSeats} seats selected. Seats are not reserved until your hold is confirmed.
      </p>

      {row && seats.length > 0 ? (
        <ul
          ref={listRef}
          aria-label={`${section.name}, row ${row.label} seats`}
          aria-describedby={statusId}
          className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2"
        >
          {seats.map((seat, index) => {
            const isSelected = selected.has(seat.seatId);
            const available = seat.state === "AVAILABLE";
            const limitReached = available && !isSelected && limit.atLimit;
            const inert = !isSelected && (!available || limit.atLimit);
            const visual = seatVisualState(seat.state, seat.type, isSelected);
            const tierName = seat.priceTierId ? tierNames.get(seat.priceTierId) : undefined;
            const price =
              seat.priceMinor !== null && seat.currency !== null
                ? formatMinorCurrency(seat.priceMinor, seat.currency)
                : null;
            const statusText = [
              isSelected ? SEAT_VISUAL_LABELS.selected : STATE_LABELS[seat.state],
              TYPE_LABELS[seat.type],
            ].filter((part): part is string => Boolean(part));
            const priceText = [tierName, price].filter((part): part is string => Boolean(part));
            const details = [
              ...statusText,
              ...priceText,
              ...(limitReached ? ["Selection limit reached"] : []),
            ];
            return (
              <li key={seat.seatId}>
                <button
                  type="button"
                  data-list-seat-id={seat.seatId}
                  aria-pressed={isSelected}
                  aria-disabled={inert || undefined}
                  aria-label={`${section.name}, row ${row.label}, seat ${seat.label}, ${details.join(", ")}`}
                  tabIndex={seat.seatId === rovingSeatId ? 0 : -1}
                  onClick={() => {
                    setActiveSeatId(seat.seatId);
                    if (!inert) onToggleSeat(seat.seatId);
                  }}
                  onKeyDown={(event) => onSeatKeyDown(event, index)}
                  className={cn(
                    "flex h-full min-h-11 w-full min-w-11 items-start gap-2 rounded-[var(--sf-radius-input)] border px-3 py-2 text-left outline-none focus-visible:ring-4 focus-visible:ring-[var(--sf-focus)]",
                    isSelected
                      ? "border-[var(--sf-seat-selected)] bg-[var(--sf-surface-raised)]"
                      : "border-[var(--sf-border)] bg-[var(--sf-surface)]",
                    inert ? "cursor-not-allowed opacity-70" : "cursor-pointer hover:bg-[var(--sf-surface-hover)]",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-px flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-black",
                      SEAT_STATE_CLASSES[visual],
                    )}
                  >
                    {SEAT_STATE_GLYPHS[visual]}
                  </span>
                  {/* Status and price get their own lines and wrap instead of
                      truncating, so narrow phones never cut off a tier name. */}
                  <span aria-hidden="true" className="min-w-0 flex-1 space-y-0.5 break-words text-xs leading-snug text-[var(--sf-text-secondary)]">
                    <span className="block text-sm font-bold text-[var(--sf-text)]">Seat {seat.label}</span>
                    <span className="block">{statusText.join(" · ")}</span>
                    {priceText.length > 0 ? (
                      <span className="block">
                        {tierName ? <span>{tierName}</span> : null}
                        {tierName && price ? " · " : null}
                        {price ? (
                          <span className="whitespace-nowrap font-mono font-bold tabular-nums text-[var(--sf-text)]">{price}</span>
                        ) : null}
                      </span>
                    ) : null}
                    {limitReached ? (
                      <span className="block text-[var(--sf-warning)]">Selection limit reached</span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p role="status" className="text-sm text-[var(--sf-text-secondary)]">
          This row has no seats.
        </p>
      )}
    </div>
  );
}
