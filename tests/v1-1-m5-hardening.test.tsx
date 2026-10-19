import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HoldActionState } from "../src/app/customer/hold-actions";
import { RealtimeSeatSelection } from "../src/components/holds/realtime-seat-selection";
import { SelectionSummary } from "../src/components/seat-selection/selection-summary";
import { VenueSeatMap } from "../src/components/seat-selection/venue-seat-map";
import { READABLE_SEAT_PX } from "../src/components/seat-selection/seat-map-viewport";
import { smallMap, stubViewportSize, syntheticMap } from "./v1-1-m5-seat-map-fixtures";

// M5.5 scoped hardening: hold gating on a stale authoritative snapshot (never
// on socket state alone), the compact mobile sheet and the zoom toolbar that
// no longer floats over the seats on narrow screens.

const socketHarness = vi.hoisted(() => ({
  handlers: new Map<string, Array<(...args: unknown[]) => void>>(),
}));

vi.mock("socket.io-client", () => ({
  io: () => {
    const socket = {
      auth: {},
      on(name: string, handler: (...args: unknown[]) => void) {
        socketHarness.handlers.set(name, [...(socketHarness.handlers.get(name) ?? []), handler]);
        return socket;
      },
      removeAllListeners: () => socket,
      disconnect: () => socket,
      io: { on: () => undefined, removeAllListeners: () => undefined },
    };
    return socket;
  },
}));

function emit(name: string, payload?: unknown) {
  for (const handler of socketHarness.handlers.get(name) ?? []) handler(payload);
}

const counts = { total: 8, available: 6, heldByYou: 1, unavailable: 1, blocked: 0 };
const noOpAction = vi.fn(async (): Promise<HoldActionState> => ({}));

function snapshotResponse() {
  return Promise.resolve({
    ok: true,
    json: async () => ({ sections: smallMap(), counts, currency: "AZN", realtimeTicket: "ticket" }),
  } as Response);
}

function renderSelection(realtimeUrl: string) {
  return render(
    <RealtimeSeatSelection
      sessionId="session-1"
      eventSlug="public-event"
      initialSections={smallMap()}
      initialCounts={counts}
      maxSeats={8}
      action={noOpAction}
      initialTicket="initial-ticket"
      realtimeUrl={realtimeUrl}
    />,
  );
}

function mapSeat(seatId: string) {
  return document.querySelector<HTMLElement>(`[data-seat-id="${seatId}"]`)!;
}

function rail() {
  return screen.getByRole("complementary", { name: "Your selection" });
}

beforeEach(() => {
  socketHarness.handlers.clear();
  vi.stubGlobal("fetch", vi.fn(snapshotResponse));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  noOpAction.mockClear();
});

describe("M5.5 hold gating on authoritative freshness", () => {
  it("pauses holding after a failed refresh and resumes after a successful retry", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")));
    renderSelection("");
    await user.click(mapSeat("st-a-1"));
    expect(within(rail()).getByRole("button", { name: "Hold 1 seat" })).toBeEnabled();

    act(() => window.dispatchEvent(new Event("focus")));
    await screen.findByText(/couldn't refresh seat availability/i);
    const hold = within(rail()).getByRole("button", { name: "Hold 1 seat" });
    expect(hold).toBeDisabled();
    expect(within(rail()).getByText(/Holding is paused/)).toBeInTheDocument();
    // The local selection is kept; nothing claims the seats are gone or held.
    expect(mapSeat("st-a-1")).toHaveAttribute("aria-pressed", "true");

    await user.click(within(rail()).getByRole("button", { name: "Check availability again" }));
    await waitFor(() => expect(within(rail()).getByRole("button", { name: "Hold 1 seat" })).toBeEnabled());
    expect(within(rail()).queryByText(/Holding is paused/)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps holding available when only the live socket drops and polling still succeeds", async () => {
    const user = userEvent.setup();
    renderSelection("http://localhost:3001");
    act(() => emit("connect"));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await user.click(mapSeat("st-a-1"));

    act(() => emit("disconnect"));
    expect(screen.getByText("Reconnecting live updates")).toBeInTheDocument();
    act(() => emit("inventory:transport-state", { state: "fallback" }));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    expect(within(rail()).getByRole("button", { name: "Hold 1 seat" })).toBeEnabled();
    expect(within(rail()).queryByText(/Holding is paused/)).not.toBeInTheDocument();
  });
});

describe("M5.5 compact mobile sheet", () => {
  const base = {
    sections: smallMap(),
    maxSeats: 8,
    onRemoveSeat: () => undefined,
    onClearSelection: () => undefined,
    variant: "sheet" as const,
  };

  it("shows only the heading and status before any seat is selected", () => {
    render(<SelectionSummary {...base} selectedSeatIds={[]} />);
    const sheet = screen.getByRole("complementary", { name: "Selected seats (0)" });
    expect(within(sheet).getByRole("status")).toHaveTextContent("0 of 8 seats selected.");
    expect(within(sheet).queryByRole("button", { name: /^Hold/ })).not.toBeInTheDocument();
    expect(within(sheet).queryByTestId("selection-total")).not.toBeInTheDocument();
  });

  it("puts the total beside the hold action once seats are selected", () => {
    render(<SelectionSummary {...base} selectedSeatIds={["st-a-1"]} />);
    const sheet = screen.getByRole("complementary", { name: "Selected seats (1)" });
    const total = within(sheet).getByTestId("selection-total");
    const hold = within(sheet).getByRole("button", { name: "Hold 1 seat" });
    // Same row: total wrapper → row → hold wrapper.
    expect(total.parentElement!.parentElement).toContainElement(hold);
    expect(sheet.className).toContain("env(safe-area-inset-bottom)");
  });

  it("shows a hold notice next to the action and disables it", () => {
    render(
      <SelectionSummary {...base} selectedSeatIds={["st-a-1"]} holdEnabled={false} holdNotice={<p>Paused</p>} />,
    );
    const sheet = screen.getByRole("complementary", { name: "Selected seats (1)" });
    expect(within(sheet).getByText("Paused")).toBeVisible();
    expect(within(sheet).getByRole("button", { name: "Hold 1 seat" })).toBeDisabled();
  });
});

describe("M5.5 zoom controls", () => {
  it("are outside the panning surface, before the seats in focus order", () => {
    render(<VenueSeatMap sections={smallMap()} selectedSeatIds={[]} maxSeats={8} onToggleSeat={() => undefined} />);
    const toolbar = screen.getByRole("toolbar", { name: "Map zoom" });
    const surface = screen.getByTestId("seat-map-viewport");
    expect(surface.contains(toolbar)).toBe(false);
    expect(toolbar.compareDocumentPosition(surface) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Row above the map on narrow screens; floating column from `sm`.
    expect(toolbar.className).toContain("sm:absolute");
    expect(toolbar.className).toContain("sm:flex-col");
  });
});

describe("M5.5 seat layer rendering", () => {
  it("leaves the (still invisible) seat buttons out of server HTML but renders them on the client", () => {
    const element = <VenueSeatMap sections={smallMap()} selectedSeatIds={[]} maxSeats={8} onToggleSeat={() => undefined} />;
    const html = renderToString(element);
    expect(html).not.toContain("data-seat-id");
    // Section navigation and the schematic notice are still server-rendered.
    expect(html).toContain("Jump to section");

    render(element);
    expect(document.querySelectorAll("[data-seat-id]")).toHaveLength(8);
  });
});

describe("M5.5 pointer focus does not pan the map", () => {
  function scale() {
    return Number(document.querySelector<HTMLElement>('[data-testid="seat-map-viewport"]')!.dataset.viewportScale);
  }

  it("keeps the view on a tap or click, but still reveals keyboard focus", { timeout: 30_000 }, () => {
    stubViewportSize(358, 420);
    render(<VenueSeatMap sections={syntheticMap()} selectedSeatIds={[]} maxSeats={8} onToggleSeat={() => undefined} />);
    // Direct selector: role queries over 3,000 buttons are slow in jsdom.
    fireEvent.click(document.querySelector<HTMLElement>('button[aria-label="Show whole map"]')!);
    const overview = scale();
    expect(overview * 36).toBeLessThan(READABLE_SEAT_PX);

    const seat = document.querySelector<HTMLElement>('[data-seat-id="s0-r0-n0"]')!;
    fireEvent.pointerDown(seat, { pointerId: 1, pointerType: "touch" });
    act(() => seat.focus());
    expect(scale()).toBe(overview);

    fireEvent.keyDown(seat, { key: "ArrowDown" });
    expect(scale() * 36).toBeGreaterThanOrEqual(READABLE_SEAT_PX - 1e-6);
  });
});
