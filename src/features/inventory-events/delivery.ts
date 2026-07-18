import type { InventoryInvalidationEvent } from "@/features/inventory-events/event";
import type { SelectionSectionView } from "@/features/holds/inventory";

export interface InventoryEventCursor {
  lastServerTimestamp: string | null;
  seenEventIds: readonly string[];
}

export type InventoryEventDecision =
  | { apply: true; cursor: InventoryEventCursor }
  | { apply: false; reason: "duplicate" | "stale"; cursor: InventoryEventCursor };

export function decideInventoryEvent(
  cursor: InventoryEventCursor,
  event: InventoryInvalidationEvent,
  maximumSeenEvents = 100,
): InventoryEventDecision {
  if (cursor.seenEventIds.includes(event.eventId)) {
    return { apply: false, reason: "duplicate", cursor };
  }
  if (
    cursor.lastServerTimestamp &&
    event.serverTimestamp < cursor.lastServerTimestamp
  ) {
    return { apply: false, reason: "stale", cursor };
  }

  return {
    apply: true,
    cursor: {
      lastServerTimestamp:
        !cursor.lastServerTimestamp || event.serverTimestamp > cursor.lastServerTimestamp
          ? event.serverTimestamp
          : cursor.lastServerTimestamp,
      seenEventIds: [...cursor.seenEventIds, event.eventId].slice(-maximumSeenEvents),
    },
  };
}

export function shouldRefreshAfterRealtimeTransition(input: {
  previous: "connecting" | "live" | "reconnecting" | "fallback";
  next: "connecting" | "live" | "reconnecting" | "fallback";
}) {
  return input.next === "live" && input.previous !== "live";
}

export function reconcileSelectedSeatIds(
  selectedSeatIds: readonly string[],
  sections: readonly SelectionSectionView[],
) {
  const available = new Set(
    sections.flatMap((section) =>
      section.rows.flatMap((row) =>
        row.seats
          .filter((seat) => seat.state === "AVAILABLE")
          .map((seat) => seat.seatId),
      ),
    ),
  );
  const kept = selectedSeatIds.filter((seatId) => available.has(seatId));
  const removed = selectedSeatIds.filter((seatId) => !available.has(seatId));
  return { kept, removed };
}

export type RealtimeConnectionState =
  | "connecting"
  | "live"
  | "reconnecting"
  | "fallback";

export function toConnectionStateView(state: RealtimeConnectionState) {
  if (state === "live") {
    return { label: "Live", tone: "success" as const };
  }
  if (state === "connecting" || state === "reconnecting") {
    return { label: "Reconnecting", tone: "warning" as const };
  }
  return {
    label: "Temporarily using refresh fallback",
    tone: "neutral" as const,
  };
}
