"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

import {
  decideInventoryEvent,
  type InventoryEventCursor,
  type RealtimeConnectionState,
} from "@/features/inventory-events/delivery";
import { inventoryEventPayloadSchema } from "@/features/inventory-events/event";

export type AuthoritativeRefreshReason =
  | "event"
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
  const [connectionState, setConnectionState] =
    useState<RealtimeConnectionState>(input.realtimeUrl ? "connecting" : "fallback");
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
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    socket.on("connect", () => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      setConnectionState("live");
      void refresh("reconnect");
    });
    socket.on("disconnect", () => {
      setConnectionState("reconnecting");
      fallbackTimer = setTimeout(() => setConnectionState("fallback"), 5_000);
    });
    socket.on("connect_error", () => setConnectionState("fallback"));
    socket.io.on("reconnect_attempt", () => setConnectionState("reconnecting"));
    socket.on("inventory:transport-state", (rawState: unknown) => {
      if (
        typeof rawState !== "object" ||
        rawState === null ||
        !("state" in rawState)
      ) {
        return;
      }
      if (rawState.state === "fallback") setConnectionState("fallback");
      if (rawState.state === "live") {
        setConnectionState("live");
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
      if (fallbackTimer) clearTimeout(fallbackTimer);
      socket.removeAllListeners();
      socket.io.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [input.realtimeUrl, input.sessionId, refresh]);

  useEffect(() => {
    const onFocus = () => void refresh("focus");
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  useEffect(() => {
    if (connectionState !== "fallback") return;
    const interval = window.setInterval(() => void refresh("fallback"), 30_000);
    return () => window.clearInterval(interval);
  }, [connectionState, refresh]);

  return { connectionState, refresh };
}
