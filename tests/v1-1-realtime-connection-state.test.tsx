import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InventoryConnectionStatus } from "@/components/holds/inventory-connection-status";
import { useInventoryInvalidation } from "@/components/holds/use-inventory-invalidation";
import {
  initialConnectionState,
  nextConnectionState,
  REALTIME_RECONNECT_GRACE_MS,
  type RealtimeConnectionSignal,
  type RealtimeConnectionState,
  toConnectionStateView,
  usesTimedRefresh,
} from "@/features/inventory-events/delivery";
import { DEFAULT_POLL_INTERVAL_MS } from "@/features/inventory-events/realtime-endpoint";

type Handler = (...arguments_: unknown[]) => void;

const harness = vi.hoisted(() => ({
  handlers: new Map<string, Handler[]>(),
  managerHandlers: new Map<string, Handler[]>(),
  created: 0,
}));

vi.mock("socket.io-client", () => ({
  io: () => {
    harness.created += 1;
    const socket = {
      auth: {},
      on(name: string, handler: Handler) {
        harness.handlers.set(name, [...(harness.handlers.get(name) ?? []), handler]);
        return socket;
      },
      removeAllListeners() {
        harness.handlers.clear();
        return socket;
      },
      disconnect() {
        return socket;
      },
      io: {
        on(name: string, handler: Handler) {
          harness.managerHandlers.set(name, [...(harness.managerHandlers.get(name) ?? []), handler]);
        },
        removeAllListeners() {
          harness.managerHandlers.clear();
        },
      },
    };
    return socket;
  },
}));

function emit(name: string, payload?: unknown) {
  act(() => {
    for (const handler of harness.handlers.get(name) ?? []) handler(payload);
  });
}

function emitManager(name: string) {
  act(() => {
    for (const handler of harness.managerHandlers.get(name) ?? []) handler();
  });
}

function Probe({ realtimeUrl, onRefresh }: { realtimeUrl: string; onRefresh: () => Promise<string | null> }) {
  const { connectionState } = useInventoryInvalidation({
    sessionId: "session-1",
    initialTicket: "ticket",
    realtimeUrl,
    onRefresh,
  });
  return <InventoryConnectionStatus state={connectionState} />;
}

function currentState() {
  return screen.getByRole("status").getAttribute("data-connection-state");
}

describe("connection state transitions", () => {
  const cases: Array<[RealtimeConnectionState, RealtimeConnectionSignal, RealtimeConnectionState]> = [
    ["connecting", "connected", "live"],
    ["connecting", "connect_error", "connecting"],
    ["connecting", "reconnect_attempt", "connecting"],
    ["connecting", "grace_expired", "fallback"],
    ["live", "disconnected", "reconnecting"],
    ["live", "connect_error", "reconnecting"],
    ["live", "grace_expired", "live"],
    ["live", "transport_fallback", "fallback"],
    ["reconnecting", "reconnect_attempt", "reconnecting"],
    ["reconnecting", "grace_expired", "fallback"],
    ["reconnecting", "connected", "live"],
    ["fallback", "reconnect_attempt", "fallback"],
    ["fallback", "connect_error", "fallback"],
    ["fallback", "disconnected", "fallback"],
    ["fallback", "connected", "live"],
    ["fallback", "transport_live", "live"],
    ["polling", "connected", "polling"],
    ["polling", "transport_fallback", "polling"],
  ];

  it.each(cases)("%s + %s → %s", (current, signal, expected) => {
    expect(nextConnectionState(current, signal)).toBe(expected);
  });

  it("starts in permanent polling when no gateway is configured", () => {
    expect(initialConnectionState("")).toBe("polling");
    expect(initialConnectionState("http://localhost:3001")).toBe("connecting");
  });

  it("runs the timed refresh only while no socket is delivering events", () => {
    expect(usesTimedRefresh("polling")).toBe(true);
    expect(usesTimedRefresh("fallback")).toBe(true);
    expect(usesTimedRefresh("live")).toBe(false);
    expect(usesTimedRefresh("connecting")).toBe(false);
    expect(usesTimedRefresh("reconnecting")).toBe(false);
  });

  it("never describes a mode as a temporary failure or exposes infrastructure names", () => {
    for (const state of ["polling", "connecting", "live", "reconnecting", "fallback"] as const) {
      const view = toConnectionStateView(state);
      expect(`${view.label} ${view.description}`).not.toMatch(/temporarily|fallback|postgres|redis|socket|gateway/i);
    }
  });
});

describe("connection indicator over time", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    harness.handlers.clear();
    harness.managerHandlers.clear();
    harness.created = 0;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("does not flap while an unreachable gateway keeps failing", async () => {
    const onRefresh = vi.fn(async () => null);
    render(<Probe realtimeUrl="http://localhost:3001" onRefresh={onRefresh} />);
    expect(currentState()).toBe("connecting");

    const seen = new Set<string | null>();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      emit("connect_error");
      emitManager("reconnect_attempt");
      seen.add(currentState());
      await act(async () => vi.advanceTimersByTime(REALTIME_RECONNECT_GRACE_MS / 4));
    }
    expect([...seen]).toEqual(["connecting"]);

    await act(async () => vi.advanceTimersByTime(REALTIME_RECONNECT_GRACE_MS));
    expect(currentState()).toBe("fallback");
    expect(screen.getByRole("status")).toHaveTextContent("Live updates paused");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      emitManager("reconnect_attempt");
      emit("connect_error");
      expect(currentState()).toBe("fallback");
    }

    // Timed refresh covers the gap while the socket keeps retrying.
    onRefresh.mockClear();
    await act(async () => vi.advanceTimersByTime(DEFAULT_POLL_INTERVAL_MS));
    expect(onRefresh).toHaveBeenCalledWith("fallback");

    emit("connect");
    expect(currentState()).toBe("live");
    // The first successful connection is not a recovery.
    expect(onRefresh).toHaveBeenLastCalledWith("connect");
  });

  it("reports only a connection after a previous one as a reconnect", async () => {
    const onRefresh = vi.fn(async () => null);
    render(<Probe realtimeUrl="http://localhost:3001" onRefresh={onRefresh} />);
    emit("connect");
    expect(onRefresh).toHaveBeenLastCalledWith("connect");
    // Let the first refresh settle; overlapping refreshes are coalesced.
    await act(async () => Promise.resolve());
    emit("disconnect");
    emit("connect");
    expect(onRefresh).toHaveBeenLastCalledWith("reconnect");
  });

  it("reports a brief disconnect as reconnecting and recovers without showing fallback", async () => {
    render(<Probe realtimeUrl="http://localhost:3001" onRefresh={async () => null} />);
    emit("connect");
    expect(currentState()).toBe("live");
    emit("disconnect");
    emitManager("reconnect_attempt");
    expect(currentState()).toBe("reconnecting");
    await act(async () => vi.advanceTimersByTime(REALTIME_RECONNECT_GRACE_MS - 1));
    expect(currentState()).toBe("reconnecting");
    emit("connect");
    expect(currentState()).toBe("live");
    await act(async () => vi.advanceTimersByTime(REALTIME_RECONNECT_GRACE_MS * 2));
    expect(currentState()).toBe("live");
  });

  it("moves to fallback when the gateway reports its event stream is down", () => {
    render(<Probe realtimeUrl="http://localhost:3001" onRefresh={async () => null} />);
    emit("connect");
    emit("inventory:transport-state", { state: "fallback" });
    expect(currentState()).toBe("fallback");
    emit("inventory:transport-state", { state: "live" });
    expect(currentState()).toBe("live");
  });

  it("treats an unconfigured gateway as normal auto-refresh and never opens a socket", async () => {
    const onRefresh = vi.fn(async () => null);
    render(<Probe realtimeUrl="" onRefresh={onRefresh} />);
    expect(currentState()).toBe("polling");
    expect(screen.getByRole("status")).toHaveTextContent("Auto-refresh on");
    expect(screen.getByRole("status")).toHaveTextContent(/every 30 seconds/);
    expect(harness.created).toBe(0);
    await act(async () => vi.advanceTimersByTime(REALTIME_RECONNECT_GRACE_MS * 3));
    expect(currentState()).toBe("polling");
    await act(async () => vi.advanceTimersByTime(DEFAULT_POLL_INTERVAL_MS));
    expect(onRefresh).toHaveBeenCalled();
  });
});

describe("connection indicator accessibility", () => {
  afterEach(() => cleanup());

  it("announces a label and a plain-language description, with a decorative dot", () => {
    render(<InventoryConnectionStatus state="fallback" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent(/refreshes automatically every 30 seconds/);
    expect(status).toHaveTextContent(/until live updates return/);
    // No title attribute: it would give the live region a name and make screen
    // readers announce the description twice.
    expect(status).not.toHaveAttribute("title");
    expect(status.querySelector("[aria-hidden='true']")).not.toBeNull();
  });
});
