"use client";

import { useCallback, useState } from "react";

import { InventoryConnectionStatus } from "@/components/holds/inventory-connection-status";
import { OrganizerInventorySummary } from "@/components/holds/organizer-inventory-summary";
import {
  type AuthoritativeRefreshReason,
  useInventoryInvalidation,
} from "@/components/holds/use-inventory-invalidation";
import type { OrganizerInventorySummary as OrganizerInventorySummaryView } from "@/features/holds/view-models";

const REFRESH_FAILED_NOTICE =
  "Inventory totals couldn't be refreshed just now. SeatFlow will keep trying automatically.";

export function RealtimeOrganizerInventory({
  sessionId,
  organizationSlug,
  eventSlug,
  initialSummary,
  timeZone,
  initialTicket,
  realtimeUrl,
}: {
  sessionId: string;
  organizationSlug: string;
  eventSlug: string;
  initialSummary: OrganizerInventorySummaryView;
  timeZone: string;
  initialTicket: string;
  realtimeUrl: string;
}) {
  const [summary, setSummary] = useState(initialSummary);
  const [notice, setNotice] = useState<string | null>(null);
  const refreshSnapshot = useCallback(
    async (reason: AuthoritativeRefreshReason) => {
      try {
        const query = new URLSearchParams({ organizationSlug, eventSlug });
        const response = await fetch(
          `/api/inventory/sessions/${encodeURIComponent(sessionId)}/organizer?${query}`,
          { cache: "no-store", credentials: "same-origin" },
        );
        if (!response.ok) throw new Error("Organizer inventory refresh failed.");
        const snapshot = (await response.json()) as {
          summary: OrganizerInventorySummaryView;
          realtimeTicket: string;
        };
        setSummary(snapshot.summary);
        if (reason === "event") setNotice("Aggregate inventory refreshed after an inventory change.");
        else setNotice((current) => (current === REFRESH_FAILED_NOTICE ? null : current));
        return snapshot.realtimeTicket;
      } catch {
        setNotice(REFRESH_FAILED_NOTICE);
        return null;
      }
    },
    [eventSlug, organizationSlug, sessionId],
  );
  const { connectionState } = useInventoryInvalidation({
    sessionId,
    initialTicket,
    realtimeUrl,
    onRefresh: refreshSnapshot,
  });

  return (
    <div className="space-y-3">
      <InventoryConnectionStatus state={connectionState} />
      {notice ? <p className="text-sm text-slate-600" role="status">{notice}</p> : null}
      <OrganizerInventorySummary summary={summary} timeZone={timeZone} />
    </div>
  );
}
