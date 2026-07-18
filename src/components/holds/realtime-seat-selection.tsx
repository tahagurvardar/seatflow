"use client";

import { useCallback, useState } from "react";

import type { HoldActionState } from "@/app/customer/hold-actions";
import { InventoryConnectionStatus } from "@/components/holds/inventory-connection-status";
import { SeatSelectionPreview } from "@/components/holds/seat-selection-preview";
import { SelectableSeatMap } from "@/components/holds/selectable-seat-map";
import {
  type AuthoritativeRefreshReason,
  useInventoryInvalidation,
} from "@/components/holds/use-inventory-invalidation";
import type { SupportedCurrency } from "@/config/site";
import type { SelectionAvailabilityCounts, SelectionSectionView } from "@/features/holds/inventory";

interface CustomerInventorySnapshot {
  sections: SelectionSectionView[];
  counts: SelectionAvailabilityCounts;
  currency: SupportedCurrency | null;
  realtimeTicket: string;
}

export function RealtimeSeatSelection({
  sessionId,
  eventSlug,
  initialSections,
  initialCounts,
  currency: initialCurrency,
  maxSeats,
  action,
  initialTicket,
  realtimeUrl,
}: {
  sessionId: string;
  eventSlug: string;
  initialSections: SelectionSectionView[];
  initialCounts: SelectionAvailabilityCounts;
  currency: SupportedCurrency | null;
  maxSeats: number;
  action?: (state: HoldActionState, formData: FormData) => Promise<HoldActionState>;
  initialTicket: string;
  realtimeUrl: string;
}) {
  const [sections, setSections] = useState(initialSections);
  const [counts, setCounts] = useState(initialCounts);
  const [currency, setCurrency] = useState(initialCurrency);
  const [notice, setNotice] = useState<string | null>(null);

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
        setCurrency(snapshot.currency);
        if (reason === "event") {
          setNotice("Availability changed. SeatFlow refreshed the authoritative inventory.");
        } else if (reason === "reconnect") {
          setNotice("Live updates reconnected and inventory was refreshed.");
        }
        return snapshot.realtimeTicket;
      } catch {
        setNotice(
          "Live refresh is temporarily unavailable. SeatFlow will keep retrying; PostgreSQL still confirms every hold.",
        );
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
    <div className="space-y-5">
      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
        <InventoryConnectionStatus state={connectionState} />
        <dl className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-600">
          <div><dt className="inline font-semibold">Available </dt><dd className="inline">{counts.available}</dd></div>
          <div><dt className="inline font-semibold">Held by you </dt><dd className="inline">{counts.heldByYou}</dd></div>
          <div><dt className="inline font-semibold">Unavailable </dt><dd className="inline">{counts.unavailable}</dd></div>
        </dl>
      </div>
      {notice ? (
        <p className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900" role="status">
          {notice}
        </p>
      ) : null}
      {action ? (
        <SelectableSeatMap
          sections={sections}
          maxSeats={maxSeats}
          currency={currency}
          action={action}
          onConflictRefresh={() => void refresh("conflict")}
        />
      ) : (
        <SeatSelectionPreview sections={sections} />
      )}
    </div>
  );
}
