import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HoldActionState } from "@/app/customer/hold-actions";
import { InventoryConnectionStatus } from "@/components/holds/inventory-connection-status";
import { RealtimeOrganizerInventory } from "@/components/holds/realtime-organizer-inventory";
import { RealtimeSeatSelection } from "@/components/holds/realtime-seat-selection";
import { SelectableSeatMap } from "@/components/holds/selectable-seat-map";
import type { InventoryInvalidationEvent } from "@/features/inventory-events/event";
import type { SelectionSectionView } from "@/features/holds/inventory";

const socketHarness = vi.hoisted(() => ({ current: null as FakeSocket | null }));

vi.mock("socket.io-client", () => ({
  io: () => {
    if (!socketHarness.current) throw new Error("Socket test harness is unavailable.");
    return socketHarness.current;
  },
}));

type Handler = (...arguments_: unknown[]) => void;

interface FakeSocket {
  auth: Record<string, string>;
  on(name: string, handler: Handler): FakeSocket;
  removeAllListeners(): FakeSocket;
  disconnect(): FakeSocket;
  io: {
    on(name: string, handler: Handler): void;
    removeAllListeners(): void;
  };
  serverEmit(name: string, payload?: unknown): void;
}

function createFakeSocket(): FakeSocket {
  const handlers = new Map<string, Handler[]>();
  const managerHandlers = new Map<string, Handler[]>();
  const socket: FakeSocket = {
    auth: {},
    on(name, handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return socket;
    },
    removeAllListeners() {
      handlers.clear();
      return socket;
    },
    disconnect() {
      return socket;
    },
    io: {
      on(name, handler) {
        managerHandlers.set(name, [...(managerHandlers.get(name) ?? []), handler]);
      },
      removeAllListeners() {
        managerHandlers.clear();
      },
    },
    serverEmit(name, payload) {
      for (const handler of handlers.get(name) ?? []) handler(payload);
    },
  };
  return socket;
}

const availableSections: SelectionSectionView[] = [
  {
    id: "section-main",
    name: "Main floor",
    code: "MAIN",
    rows: [
      {
        id: "row-a",
        label: "A",
        seats: [
          { seatId: "seat-1", label: "1", x: 0, y: 0, type: "STANDARD", state: "AVAILABLE", priceMinor: 1_000, currency: "AZN" },
          { seatId: "seat-2", label: "2", x: 40, y: 0, type: "PREMIUM", state: "AVAILABLE", priceMinor: 2_000, currency: "AZN" },
        ],
      },
    ],
  },
];

const unavailableSections: SelectionSectionView[] = [
  {
    ...availableSections[0]!,
    rows: [
      {
        ...availableSections[0]!.rows[0]!,
        seats: [
          { ...availableSections[0]!.rows[0]!.seats[0]!, state: "UNAVAILABLE", priceMinor: null, currency: null },
          availableSections[0]!.rows[0]!.seats[1]!,
        ],
      },
    ],
  },
];

const event: InventoryInvalidationEvent = {
  eventId: "550e8400-e29b-41d4-a716-446655440000",
  sessionId: "session-1",
  eventType: "HOLD_CREATED",
  serverTimestamp: "2035-05-01T12:00:00.000Z",
};

const noOpAction = vi.fn(async (): Promise<HoldActionState> => ({}));

function response(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response);
}

beforeEach(() => {
  socketHarness.current = createFakeSocket();
  vi.stubGlobal("fetch", vi.fn(() => response({
    sections: availableSections,
    counts: { total: 2, available: 2, heldByYou: 0, unavailable: 0, blocked: 0 },
    currency: "AZN",
    realtimeTicket: "refreshed-ticket",
  })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  noOpAction.mockClear();
  socketHarness.current = null;
});

describe("Phase 4B connection states", () => {
  it("renders live, reconnecting, and fallback labels honestly", () => {
    const { rerender } = render(<InventoryConnectionStatus state="live" />);
    expect(screen.getByRole("status")).toHaveTextContent("Live");
    rerender(<InventoryConnectionStatus state="reconnecting" />);
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting");
    rerender(<InventoryConnectionStatus state="fallback" />);
    expect(screen.getByRole("status")).toHaveTextContent(/refresh fallback/i);
  });

  it("moves the realtime customer view through live and fallback transport state", async () => {
    render(
      <RealtimeSeatSelection
        sessionId="session-1"
        eventSlug="public-event"
        initialSections={availableSections}
        initialCounts={{ total: 2, available: 2, heldByYou: 0, unavailable: 0, blocked: 0 }}
        currency="AZN"
        maxSeats={8}
        initialTicket="initial-ticket"
        realtimeUrl="http://localhost:3001"
      />,
    );
    act(() => socketHarness.current!.serverEmit("connect"));
    expect(await screen.findByRole("status", { name: "" })).toHaveTextContent(/Live|reconnected/i);
    act(() => socketHarness.current!.serverEmit("inventory:transport-state", { state: "fallback" }));
    expect(screen.getByText(/temporarily using refresh fallback/i)).toBeInTheDocument();
  });
});

describe("Phase 4B authoritative invalidation UI", () => {
  it("refreshes from the server, removes a conflicted local selection, and ignores a duplicate event", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(() => response({
      sections: unavailableSections,
      counts: { total: 2, available: 1, heldByYou: 0, unavailable: 1, blocked: 0 },
      currency: "AZN",
      realtimeTicket: "updated-ticket",
    }));
    render(
      <RealtimeSeatSelection
        sessionId="session-1"
        eventSlug="public-event"
        initialSections={availableSections}
        initialCounts={{ total: 2, available: 2, heldByYou: 0, unavailable: 0, blocked: 0 }}
        currency="AZN"
        maxSeats={8}
        action={noOpAction}
        initialTicket="initial-ticket"
        realtimeUrl="http://localhost:3001"
      />,
    );
    await user.click(screen.getByRole("button", { name: /seat 1, standard: available/i }));

    act(() => socketHarness.current!.serverEmit("inventory:invalidated", event));
    expect(await screen.findByRole("alert")).toHaveTextContent(/no longer available.*removed/i);
    expect(screen.getByText("0 of 8 seats selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /seat 1.*unavailable/i })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => socketHarness.current!.serverEmit("inventory:invalidated", event));
    await act(async () => Promise.resolve());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes organizer aggregates without exposing customer details", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(() => response({
      summary: {
        total: 10,
        available: 9,
        held: 1,
        activeHolds: 1,
        earliestHoldExpiresAt: "2035-05-01T12:10:00.000Z",
      },
      realtimeTicket: "organizer-ticket",
    }));
    render(
      <RealtimeOrganizerInventory
        sessionId="session-1"
        organizationSlug="organizer"
        eventSlug="event"
        initialSummary={{ total: 10, available: 10, held: 0, activeHolds: 0, earliestHoldExpiresAt: null }}
        timeZone="Asia/Baku"
        initialTicket="initial-ticket"
        realtimeUrl="http://localhost:3001"
      />,
    );
    act(() => socketHarness.current!.serverEmit("inventory:invalidated", event));
    await waitFor(() =>
      expect(screen.getByText("Available").nextElementSibling).toHaveTextContent("9"),
    );
    expect(screen.queryByText(/@example\.com|public-token|userId/i)).not.toBeInTheDocument();
  });
});

describe("Phase 4B selection reconciliation component", () => {
  it("preserves still-available seats when a refreshed prop removes one selection", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <SelectableSeatMap sections={availableSections} maxSeats={8} currency="AZN" action={noOpAction} />,
    );
    await user.click(screen.getByRole("button", { name: /seat 1, standard: available/i }));
    await user.click(screen.getByRole("button", { name: /seat 2, premium: available/i }));
    rerender(
      <SelectableSeatMap sections={unavailableSections} maxSeats={8} currency="AZN" action={noOpAction} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/1 selected seat.*removed/i);
    expect(screen.getByText("1 of 8 seats selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /seat 2, premium: available/i })).toHaveAttribute("aria-pressed", "true");
  });
});
