"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

import {
  decideInventoryEvent,
  initialConnectionState,
  type InventoryEventCursor,
  nextConnectionState,
  REALTIME_RECONNECT_GRACE_MS,
  type RealtimeConnectionSignal,
  type RealtimeConnectionState,
  usesTimedRefresh,
} from "@/features/inventory-events/delivery";
import { inventoryEventPayloadSchema } from "@/features/inventory-events/event";
import { DEFAULT_POLL_INTERVAL_MS } from "@/features/inventory-events/realtime-endpoint";

export type AuthoritativeRefreshReason =
  | "event"
  | "connect"
  | "reconnect"
  | "focus"
  | "fallback"
  | "conflict";

interface InventoryInvalidationInput {
  sessionId: string;
  initialTicket: string;
  realtimeUrl: string;
  onRefresh: (reason: AuthoritativeRefreshReason) => Promise<string | null>;
}

export function useInventoryInvalidation(input: InventoryInvalidationInput) {
  const [connectionState, setConnectionState] = useState<RealtimeConnectionState>(
    () => initialConnectionState(input.realtimeUrl),
  );
  const signal = useCallback((next: RealtimeConnectionSignal) => {
    setConnectionState((current) => nextConnectionState(current, next));
  }, []);
  const socketRef = useRef<Socket | null>(null);
  const ticketRef = useRef(input.initialTicket);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const cursorRef = useRef<InventoryEventCursor>({
    lastServerTimestamp: null,
    seenEventIds: [],
  });
  const onRefreshRef = useRef(input.onRefresh);
  useEffect(() => {
    onRefreshRef.current = input.onRefresh;
  }, [input.onRefresh]);

  const refresh = useCallback((reason: AuthoritativeRefreshReason) => {
    if (refreshPromiseRef.current) return refreshPromiseRef.current;
    const operation = (async () => {
      try {
        const ticket = await onRefreshRef.current(reason);
        if (ticket) {
          ticketRef.current = ticket;
          if (socketRef.current) socketRef.current.auth = { ticket };
        }
      } finally {
        refreshPromiseRef.current = null;
      }
    })();
    refreshPromiseRef.current = operation;
    return operation;
  }, []);

  useEffect(() => {
    if (!input.realtimeUrl) {
      return;
    }

    const socket = io(input.realtimeUrl, {
      auth: { ticket: ticketRef.current },
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 10_000,
      timeout: 5_000,
    });
    socketRef.current = socket;
    // The first successful connection is not a recovery; only later ones are.
    let hasConnected = false;

    socket.on("connect", () => {
      signal("connected");
      void refresh(hasConnected ? "reconnect" : "connect");
      hasConnected = true;
    });
    socket.on("disconnect", () => signal("disconnected"));
    socket.on("connect_error", () => signal("connect_error"));
    socket.io.on("reconnect_attempt", () => signal("reconnect_attempt"));
    socket.on("inventory:transport-state", (rawState: unknown) => {
      if (
        typeof rawState !== "object" ||
        rawState === null ||
        !("state" in rawState)
      ) {
        return;
      }
      if (rawState.state === "fallback") signal("transport_fallback");
      if (rawState.state === "live") {
        signal("transport_live");
        void refresh("reconnect");
      }
    });
    socket.on("inventory:invalidated", (rawEvent: unknown) => {
      const parsed = inventoryEventPayloadSchema.safeParse(rawEvent);
      if (!parsed.success || parsed.data.sessionId !== input.sessionId) return;
      const decision = decideInventoryEvent(cursorRef.current, parsed.data);
      cursorRef.current = decision.cursor;
      if (decision.apply) void refresh("event");
    });

    return () => {
      socket.removeAllListeners();
      socket.io.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [input.realtimeUrl, input.sessionId, refresh, signal]);

  // The grace timer starts when the socket enters a (re)connecting state and is
  // cancelled by any transition out of it. Repeated retry signals do not change
  // the state, so they cannot restart or shorten the grace period.
  useEffect(() => {
    if (connectionState !== "connecting" && connectionState !== "reconnecting") return;
    const timer = window.setTimeout(() => signal("grace_expired"), REALTIME_RECONNECT_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [connectionState, signal]);

  useEffect(() => {
    const onFocus = () => void refresh("focus");
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  useEffect(() => {
    if (!usesTimedRefresh(connectionState)) return;
    const interval = window.setInterval(() => void refresh("fallback"), DEFAULT_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [connectionState, refresh]);

  return { connectionState, refresh };
}
