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
  previous: RealtimeConnectionState;
  next: RealtimeConnectionState;
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

/**
 * - `polling`: no realtime gateway is configured. Timed refresh is the normal,
 *   permanent mode, not a degradation.
 * - `connecting` / `reconnecting`: a gateway is configured and the socket is
 *   trying to (re)establish itself, within a short grace period.
 * - `fallback`: a configured gateway stayed unreachable past the grace period,
 *   or the gateway reported its event stream is down. Timed refresh covers the
 *   gap while the socket keeps retrying in the background.
 *
 * Every mode reads the same PostgreSQL snapshot; none of them decides inventory.
 */
export type RealtimeConnectionState =
  | "polling"
  | "connecting"
  | "live"
  | "reconnecting"
  | "fallback";

export type RealtimeConnectionSignal =
  | "connected"
  | "disconnected"
  | "connect_error"
  | "reconnect_attempt"
  | "grace_expired"
  | "transport_live"
  | "transport_fallback";

/** How long a configured socket may try before the UI reports fallback. */
export const REALTIME_RECONNECT_GRACE_MS = 8_000;

/**
 * Pure transition function for the connection indicator.
 *
 * Retry noise never moves the indicator: once in `fallback`, each failed
 * reconnect attempt keeps it there until a real connection succeeds, so the
 * badge cannot flap between fallback and reconnecting.
 */
export function nextConnectionState(
  current: RealtimeConnectionState,
  signal: RealtimeConnectionSignal,
): RealtimeConnectionState {
  if (current === "polling") return current;
  switch (signal) {
    case "connected":
    case "transport_live":
      return "live";
    case "transport_fallback":
      return "fallback";
    case "grace_expired":
      return current === "connecting" || current === "reconnecting" ? "fallback" : current;
    case "disconnected":
    case "connect_error":
    case "reconnect_attempt":
      return current === "live" ? "reconnecting" : current;
  }
}

export function initialConnectionState(realtimeUrl: string): RealtimeConnectionState {
  return realtimeUrl ? "connecting" : "polling";
}

/** Whether the timed authoritative refresh should run in this state. */
export function usesTimedRefresh(state: RealtimeConnectionState) {
  return state === "polling" || state === "fallback";
}

export function toConnectionStateView(
  state: RealtimeConnectionState,
  refreshIntervalSeconds = 30,
) {
  if (state === "live") {
    return {
      label: "Live updates on",
      description: "Seat availability updates as soon as it changes.",
      tone: "success" as const,
    };
  }
  if (state === "connecting") {
    return {
      label: "Connecting to live updates",
      description: "Seat availability is current as of page load.",
      tone: "neutral" as const,
    };
  }
  if (state === "reconnecting") {
    return {
      label: "Reconnecting live updates",
      description: "Seat availability will refresh as soon as the connection returns.",
      tone: "warning" as const,
    };
  }
  if (state === "polling") {
    return {
      label: "Auto-refresh on",
      description: `Seat availability refreshes automatically every ${refreshIntervalSeconds} seconds.`,
      tone: "neutral" as const,
    };
  }
  return {
    label: "Live updates paused",
    description: `Seat availability refreshes automatically every ${refreshIntervalSeconds} seconds until live updates return.`,
    tone: "warning" as const,
  };
}
