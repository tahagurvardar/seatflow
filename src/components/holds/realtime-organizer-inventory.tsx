"use client";

import { useCallback, useState } from "react";

import { InventoryConnectionStatus } from "@/components/holds/inventory-connection-status";
import { OrganizerInventorySummary } from "@/components/holds/organizer-inventory-summary";
import {
  type AuthoritativeRefreshReason,
  useInventoryInvalidation,
} from "@/components/holds/use-inventory-invalidation";
import type { OrganizerInventorySummary as OrganizerInventorySummaryView } from "@/features/holds/view-models";

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
        return snapshot.realtimeTicket;
      } catch {
        setNotice("Live aggregate refresh is temporarily unavailable. Refresh fallback remains active.");
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
