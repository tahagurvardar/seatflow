"use client";

import { type ReactNode, useCallback, useState } from "react";

import type { HoldActionState } from "@/app/customer/hold-actions";
import { InventoryConnectionStatus } from "@/components/holds/inventory-connection-status";
import { SelectableSeatMap } from "@/components/holds/selectable-seat-map";
import { PriceTierList } from "@/components/seat-selection/selection-summary";
import { VenueSeatMap } from "@/components/seat-selection/venue-seat-map";
import {
  type AuthoritativeRefreshReason,
  useInventoryInvalidation,
} from "@/components/holds/use-inventory-invalidation";
import type { SupportedCurrency } from "@/config/site";
import type {
  SelectionAvailabilityCounts,
  SelectionPriceTierView,
  SelectionSectionView,
} from "@/features/holds/inventory";

const REFRESH_FAILED_NOTICE =
  "We couldn't refresh seat availability just now. SeatFlow will keep trying, and every seat is checked again when you hold it.";

interface CustomerInventorySnapshot {
  sections: SelectionSectionView[];
  counts: SelectionAvailabilityCounts;
  currency: SupportedCurrency | null;
  realtimeTicket: string;
}

const NO_SELECTION: readonly string[] = [];

export function RealtimeSeatSelection({
  sessionId,
  eventSlug,
  initialSections,
  initialCounts,
  priceTiers = [],
  maxSeats,
  action,
  initialTicket,
  realtimeUrl,
  railNotice,
}: {
  sessionId: string;
  eventSlug: string;
  initialSections: SelectionSectionView[];
  initialCounts: SelectionAvailabilityCounts;
  /**
   * Session price tiers from the initial page load. Pricing is locked once a
   * session leaves draft, so they stay valid for every later snapshot; seat
   * prices themselves always come from the latest snapshot.
   */
  priceTiers?: readonly SelectionPriceTierView[];
  maxSeats: number;
  action?: (state: HoldActionState, formData: FormData) => Promise<HoldActionState>;
  initialTicket: string;
  realtimeUrl: string;
  /** Read-only mode only: shown at the top of the side column (e.g. active hold). */
  railNotice?: ReactNode;
}) {
  const [sections, setSections] = useState(initialSections);
  const [counts, setCounts] = useState(initialCounts);
  const [notice, setNotice] = useState<string | null>(null);
  // True only after an authoritative refresh failed and before the next one
  // succeeds. A disconnected socket alone never sets this: polling (and the
  // page-load snapshot) remain authoritative.
  const [snapshotStale, setSnapshotStale] = useState(false);

  const refreshSnapshot = useCallback(
    async (reason: AuthoritativeRefreshReason) => {
      try {
        const response = await fetch(
          `/api/inventory/sessions/${encodeURIComponent(sessionId)}?eventSlug=${encodeURIComponent(eventSlug)}`,
          { cache: "no-store", credentials: "same-origin" },
        );
        if (!response.ok) throw new Error("Inventory refresh failed.");
        const snapshot = (await response.json()) as CustomerInventorySnapshot;
        setSections(snapshot.sections);
        setCounts(snapshot.counts);
        setSnapshotStale(false);
        if (reason === "event") {
          setNotice("Availability changed. SeatFlow refreshed the authoritative inventory.");
        } else if (reason === "reconnect") {
          setNotice("Live updates reconnected and inventory was refreshed.");
        } else {
          // A successful refresh supersedes an earlier failure message.
          setNotice((current) => (current === REFRESH_FAILED_NOTICE ? null : current));
        }
        return snapshot.realtimeTicket;
      } catch {
        setNotice(REFRESH_FAILED_NOTICE);
        setSnapshotStale(true);
        return null;
      }
    },
    [eventSlug, sessionId],
  );

  const { connectionState, refresh } = useInventoryInvalidation({
    sessionId,
    initialTicket,
    realtimeUrl,
    onRefresh: refreshSnapshot,
  });

  return (
    <div data-theme-scope="customer" className="space-y-5 text-[var(--sf-text)]">
      <div className="flex flex-col gap-3 rounded-[var(--sf-radius-card)] border border-[var(--sf-border)] bg-[var(--sf-surface)] p-4 sm:flex-row sm:items-center sm:justify-between">
        <InventoryConnectionStatus state={connectionState} />
        <dl className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-[var(--sf-text-secondary)]">
          <div><dt className="inline font-semibold">Available </dt><dd className="inline">{counts.available}</dd></div>
          <div><dt className="inline font-semibold">Held by you </dt><dd className="inline">{counts.heldByYou}</dd></div>
          <div><dt className="inline font-semibold">Unavailable </dt><dd className="inline">{counts.unavailable}</dd></div>
        </dl>
      </div>
      {notice ? (
        <p
          className="rounded-[var(--sf-radius-input)] border border-[var(--sf-info)] bg-[var(--sf-surface)] p-4 text-sm text-[var(--sf-info)]"
          role="status"
        >
          {notice}
        </p>
      ) : null}
      {action ? (
        <SelectableSeatMap
          sections={sections}
          priceTiers={priceTiers}
          maxSeats={maxSeats}
          action={action}
          onConflictRefresh={() => void refresh("conflict")}
          availabilityStale={snapshotStale}
          onRetryAvailability={() => void refresh("focus")}
        />
      ) : (
        // Read-only preview: the same map without selection (signed out, not
        // on sale, or the customer already holds seats elsewhere).
        <div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(20rem,3fr)] lg:items-start">
          <VenueSeatMap
            sections={sections}
            selectedSeatIds={NO_SELECTION}
            maxSeats={maxSeats}
            label="Seat availability preview"
            className="min-w-0"
          />
          {railNotice || priceTiers.length > 0 ? (
            <div className="space-y-4 lg:sticky lg:top-24">
              {railNotice}
              {priceTiers.length > 0 ? (
                <div className="rounded-[var(--sf-radius-card)] border border-[var(--sf-border)] bg-[var(--sf-surface)] p-5">
                  <PriceTierList priceTiers={priceTiers} />
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
