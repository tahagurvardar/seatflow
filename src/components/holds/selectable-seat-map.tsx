"use client";

import { useActionState, useCallback, useEffect, useId, useMemo, useState } from "react";

import type { HoldActionState } from "@/app/customer/hold-actions";
import { SeatListPicker } from "@/components/seat-selection/seat-list-picker";
import { SelectionSummary } from "@/components/seat-selection/selection-summary";
import { VenueSeatMap } from "@/components/seat-selection/venue-seat-map";
import type {
  SelectionPriceTierView,
  SelectionSectionView,
} from "@/features/holds/inventory";
import {
  buildSelectionSeatIndex,
  reconcileSelection,
  toggleSeatSelection,
} from "@/features/holds/selection";

interface SelectableSeatMapProps {
  sections: SelectionSectionView[];
  /** Real session price tiers (names only; prices come from each seat). */
  priceTiers?: readonly SelectionPriceTierView[];
  maxSeats: number;
  action: (state: HoldActionState, formData: FormData) => Promise<HoldActionState>;
  onConflictRefresh?: () => void;
  /**
   * The last authoritative refresh failed, so the shown availability may be
   * out of date. Holding pauses until a refresh succeeds; selection stays.
   */
  availabilityStale?: boolean;
  onRetryAvailability?: () => void;
}

function removalNotice(removed: number, trimmed: number) {
  const parts: string[] = [];
  if (removed > 0) {
    parts.push(
      `${removed} selected ${removed === 1 ? "seat is" : "seats are"} no longer available and ${removed === 1 ? "was" : "were"} removed.`,
    );
  }
  if (trimmed > 0) {
    parts.push(
      `${trimmed} ${trimmed === 1 ? "seat was" : "seats were"} removed to stay within the seat limit for one hold.`,
    );
  }
  return `${parts.join(" ")} Your remaining selection is unchanged.`;
}

/**
 * SF-04 seat selection: the venue map, the list alternative and the selection
 * summary share one controlled selection. Selecting is local intent only; the
 * hold form posts the selected seat ids and an idempotency key, and the server
 * decides atomically whether the seats can be held.
 */
export function SelectableSeatMap({
  sections,
  priceTiers = [],
  maxSeats,
  action,
  onConflictRefresh,
  availabilityStale = false,
  onRetryAvailability,
}: SelectableSeatMapProps) {
  const listHeadingId = useId();
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [previousSections, setPreviousSections] = useState(sections);
  const [state, formAction, pending] = useActionState<HoldActionState, FormData>(
    action,
    {},
  );

  const seatIndex = useMemo(() => buildSelectionSeatIndex(sections), [sections]);

  // One unguessable idempotency key per picker instance. A successful hold
  // redirects away, and a failed attempt leaves no hold, so reusing this key
  // across retries is safe; the server dedupes identical requests.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  let availableSeatCount = 0;
  for (const { seat } of seatIndex.values()) {
    if (seat.state === "AVAILABLE") availableSeatCount += 1;
  }

  // A fresh authoritative snapshot drops seats that are no longer available.
  if (previousSections !== sections) {
    const reconciliation = reconcileSelection(selected, sections, maxSeats);
    setPreviousSections(sections);
    if (reconciliation.removed.length > 0 || reconciliation.trimmed.length > 0) {
      setSelected(reconciliation.kept);
      setSelectionNotice(removalNotice(reconciliation.removed.length, reconciliation.trimmed.length));
    }
  }

  useEffect(() => {
    if (state.message && /no longer available|availability may have changed/i.test(state.message)) {
      onConflictRefresh?.();
    }
  }, [onConflictRefresh, state.message]);

  const toggleSeat = useCallback(
    (seatId: string) =>
      setSelected((current) => toggleSeatSelection(current, seatId, seatIndex, maxSeats).selected),
    [maxSeats, seatIndex],
  );
  const removeSeat = useCallback(
    (seatId: string) => setSelected((current) => current.filter((id) => id !== seatId)),
    [],
  );
  const clearSelection = useCallback(() => setSelected([]), []);

  if (seatIndex.size === 0) {
    return (
      <div
        className="rounded-[var(--sf-radius-card)] border border-[var(--sf-border)] bg-[var(--sf-surface)] p-6 text-center text-sm text-[var(--sf-text-secondary)]"
        role="status"
      >
        No seats are available for this session.
      </div>
    );
  }

  const summaryProps = {
    sections,
    priceTiers,
    selectedSeatIds: selected,
    maxSeats,
    onRemoveSeat: removeSeat,
    onClearSelection: clearSelection,
    pending,
    errorMessage: state.message,
    holdEnabled: !availabilityStale,
    holdNotice: availabilityStale ? (
      <div className="space-y-2 rounded-[var(--sf-radius-input)] border border-[var(--sf-warning)] p-3 text-sm text-[var(--sf-warning)]">
        <p>Holding is paused because seat availability couldn&apos;t be confirmed. Your selection is kept.</p>
        {onRetryAvailability ? (
          <button
            type="button"
            onClick={onRetryAvailability}
            className="min-h-11 rounded-[var(--sf-radius-button)] px-3 font-bold text-[var(--sf-link)] underline outline-none focus-visible:ring-4 focus-visible:ring-[var(--sf-focus)]"
          >
            Check availability again
          </button>
        ) : null}
      </div>
    ) : undefined,
  };

  return (
    <form action={formAction} className="space-y-6">
      {selectionNotice ? (
        <p
          className="rounded-[var(--sf-radius-input)] border border-[var(--sf-warning)] bg-[var(--sf-surface)] p-4 text-sm text-[var(--sf-warning)]"
          role="alert"
        >
          {selectionNotice}
        </p>
      ) : null}

      {availableSeatCount === 0 ? (
        <p
          className="rounded-[var(--sf-radius-input)] border border-[var(--sf-warning)] bg-[var(--sf-surface)] p-4 text-sm text-[var(--sf-warning)]"
          role="status"
        >
          No seats are currently available to hold. Refresh to check again.
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(20rem,3fr)] lg:items-start">
        <div className="min-w-0 space-y-6">
          <VenueSeatMap
            sections={sections}
            selectedSeatIds={selected}
            maxSeats={maxSeats}
            onToggleSeat={toggleSeat}
          />
          <section
            aria-labelledby={listHeadingId}
            data-theme-scope="customer"
            className="space-y-4 rounded-[var(--sf-radius-card)] border border-[var(--sf-border)] bg-[var(--sf-surface)] p-4 text-[var(--sf-text)] sm:p-5"
          >
            <div>
              <h2 id={listHeadingId} className="text-lg font-black">
                Choose seats from a list
              </h2>
              <p className="mt-1 text-sm text-[var(--sf-text-secondary)]">
                Pick a section and a row, then select seats. The list and the map always show the same selection.
              </p>
            </div>
            <SeatListPicker
              sections={sections}
              priceTiers={priceTiers}
              selectedSeatIds={selected}
              maxSeats={maxSeats}
              onToggleSeat={toggleSeat}
            />
          </section>
        </div>
        {/* Desktop rail; hidden below lg, where the bottom sheet takes over. */}
        <SelectionSummary {...summaryProps} variant="rail" className="hidden lg:block" />
      </div>

      {selected.map((seatId) => (
        <input key={seatId} type="hidden" name="seatIds" value={seatId} />
      ))}
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      {/* Mobile/tablet sheet: sticky at the end of the form, so it never covers what follows. */}
      <SelectionSummary {...summaryProps} variant="sheet" className="lg:hidden" />
    </form>
  );
}
