import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HoldActionState } from "../src/app/customer/hold-actions";
import { RealtimeSeatSelection } from "../src/components/holds/realtime-seat-selection";
import { SelectableSeatMap } from "../src/components/holds/selectable-seat-map";
import { formatVenueDateTimeRange } from "../src/features/events/date-time";
import type {
  SelectionPriceTierView,
  SelectionSeatView,
} from "../src/features/holds/inventory";
import { smallMap } from "./v1-1-m5-seat-map-fixtures";

// M5.4 seat-selection page composition: the venue map, list picker, desktop
// rail and mobile sheet share one selection inside the hold form. jsdom applies
// no CSS, so both summary variants exist in the DOM; real browsers show only
// one (rail at lg+, sheet below) and screenshots are reserved for M5.5.

const TIERS: SelectionPriceTierView[] = [
  { id: "tier-std", name: "Standard", code: "STD", description: null, priceMinor: 12_000, currency: "AZN" },
  { id: "tier-front", name: "Front Stalls", code: "FRONT", description: "Closest to the stage", priceMinor: 15_000, currency: "AZN" },
];

function tieredMap(overrides: Partial<Record<string, Partial<SelectionSeatView>>> = {}) {
  const tiered: Partial<Record<string, Partial<SelectionSeatView>>> = {};
  for (const section of smallMap()) {
    for (const row of section.rows) {
      for (const seat of row.seats) {
        tiered[seat.seatId] = {
          priceTierId: seat.priceMinor === null ? null : seat.type === "PREMIUM" ? "tier-front" : "tier-std",
          ...overrides[seat.seatId],
        };
      }
    }
  }
  return smallMap(tiered);
}

const noOpAction = vi.fn(async (): Promise<HoldActionState> => ({}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  noOpAction.mockClear();
});

function plain(text: string | null) {
  return (text ?? "").replace(/ /g, " ");
}

function mapSeat(seatId: string) {
  return document.querySelector<HTMLElement>(`[data-seat-id="${seatId}"]`)!;
}

function listSeat(seatId: string) {
  return document.querySelector<HTMLElement>(`[data-list-seat-id="${seatId}"]`)!;
}

function rail() {
  return screen.getByRole("complementary", { name: "Your selection" });
}

function sheet() {
  return document.querySelector<HTMLElement>('[data-summary-variant="sheet"]')!;
}

function submittedSeatIds() {
  return [...document.querySelectorAll<HTMLInputElement>('input[type="hidden"][name="seatIds"]')].map(
    (input) => input.value,
  );
}

describe("M5.4 seat page: one shared selection", () => {
  it("keeps map, list, rail, sheet and the submitted seat ids in sync", async () => {
    const user = userEvent.setup();
    render(<SelectableSeatMap sections={tieredMap()} priceTiers={TIERS} maxSeats={8} action={noOpAction} />);

    await user.click(mapSeat("st-a-1"));
    expect(listSeat("st-a-1")).toHaveAttribute("aria-pressed", "true");
    await user.click(listSeat("st-a-2"));
    expect(mapSeat("st-a-2")).toHaveAttribute("aria-pressed", "true");
    expect(submittedSeatIds()).toEqual(["st-a-1", "st-a-2"]);

    for (const summary of [rail(), sheet()]) {
      // The sheet keeps its seat list collapsed until "View details".
      const seats = within(summary).getByRole("list", { name: "Selected seats", hidden: true });
      expect(within(seats).getAllByRole("listitem", { hidden: true })).toHaveLength(2);
      expect(plain(within(summary).getByTestId("selection-total").textContent)).toBe("AZN 240.00");
      expect(within(summary).getByRole("button", { name: "Hold 2 seats" })).toBeEnabled();
    }
    expect(within(rail()).getAllByText("Standard").length).toBeGreaterThan(0);

    // Removing from the sheet updates every view and the form payload.
    await user.click(within(sheet()).getByRole("button", { name: "View details" }));
    await user.click(within(sheet()).getByRole("button", { name: "Remove Stalls, row A, seat 1" }));
    expect(mapSeat("st-a-1")).toHaveAttribute("aria-pressed", "false");
    expect(listSeat("st-a-1")).toHaveAttribute("aria-pressed", "false");
    expect(submittedSeatIds()).toEqual(["st-a-2"]);

    await user.click(within(rail()).getByRole("button", { name: "Clear selection" }));
    expect(submittedSeatIds()).toEqual([]);
    expect(within(rail()).getByRole("button", { name: "Hold 0 seats" })).toBeDisabled();
  });

  it("selects seats with the keyboard alone on the map and in the list", async () => {
    const user = userEvent.setup();
    render(<SelectableSeatMap sections={tieredMap()} priceTiers={TIERS} maxSeats={8} action={noOpAction} />);

    act(() => mapSeat("st-a-1").focus());
    await user.keyboard("{ArrowRight}");
    expect(mapSeat("st-a-2")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(mapSeat("st-a-2")).toHaveAttribute("aria-pressed", "true");

    act(() => listSeat("st-a-1").focus());
    await user.keyboard(" ");
    expect(mapSeat("st-a-1")).toHaveAttribute("aria-pressed", "true");
    expect(submittedSeatIds()).toEqual(["st-a-2", "st-a-1"]);
  });

  it("never selects sold, unavailable or already-held seats", async () => {
    const user = userEvent.setup();
    render(<SelectableSeatMap sections={tieredMap()} priceTiers={TIERS} maxSeats={8} action={noOpAction} />);

    await user.click(mapSeat("st-a-3"));
    await user.click(mapSeat("st-b-3"));
    expect(mapSeat("st-a-3")).toHaveAttribute("aria-disabled", "true");
    expect(mapSeat("st-b-3")).toHaveAccessibleName(/held by you/);
    expect(submittedSeatIds()).toEqual([]);
    expect(within(rail()).getByText(/0 of 8 seats selected/)).toBeInTheDocument();
  });

  it("drops seats taken by a refresh and trims to a lower server limit", () => {
    const { rerender } = render(
      <SelectableSeatMap sections={tieredMap()} priceTiers={TIERS} maxSeats={8} action={noOpAction} />,
    );
    for (const seatId of ["st-a-1", "st-a-2", "st-b-1"]) fireEvent.click(mapSeat(seatId));

    rerender(
      <SelectableSeatMap
        sections={tieredMap({ "st-a-1": { state: "UNAVAILABLE", priceMinor: null, currency: null, priceTierId: null } })}
        priceTiers={TIERS}
        maxSeats={1}
        action={noOpAction}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "1 selected seat is no longer available and was removed. 1 seat was removed to stay within the seat limit for one hold.",
    );
    expect(submittedSeatIds()).toEqual(["st-a-2"]);
  });
});

describe("M5.4 seat page: hold submission", () => {
  it("posts the shared selection with one stable idempotency key across retries", async () => {
    const user = userEvent.setup();
    const action = vi.fn<(state: HoldActionState, form: FormData) => Promise<HoldActionState>>(async () => ({
      message: "SeatFlow could not complete that request.",
    }));
    render(<SelectableSeatMap sections={tieredMap()} priceTiers={TIERS} maxSeats={8} action={action} />);

    await user.click(mapSeat("st-b-2"));
    await user.click(within(sheet()).getByRole("button", { name: "Hold 1 seat" }));
    await within(rail()).findByRole("alert", {}, { timeout: 5_000 });
    await user.click(within(rail()).getByRole("button", { name: "Hold 1 seat" }));
    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(2));

    const [first, second] = action.mock.calls.map((call) => call[1]);
    expect(first!.getAll("seatIds")).toEqual(["st-b-2"]);
    expect(first!.get("idempotencyKey")).toBe(second!.get("idempotencyKey"));
  });

  it("refreshes inventory only for a conflict and keeps the selection", async () => {
    const user = userEvent.setup();
    const onConflictRefresh = vi.fn();
    const action = vi.fn(async (): Promise<HoldActionState> => ({
      message: "One or more selected seats are no longer available.",
    }));
    render(
      <SelectableSeatMap
        sections={tieredMap()}
        priceTiers={TIERS}
        maxSeats={8}
        action={action}
        onConflictRefresh={onConflictRefresh}
      />,
    );
    await user.click(mapSeat("st-a-1"));
    await user.click(within(rail()).getByRole("button", { name: "Hold 1 seat" }));

    expect(await within(rail()).findByRole("alert", {}, { timeout: 5_000 })).toHaveTextContent(/no longer available/);
    expect(onConflictRefresh).toHaveBeenCalledTimes(1);
    expect(mapSeat("st-a-1")).toHaveAttribute("aria-pressed", "true");
  });

  it("never claims a reservation before the server confirms a hold", async () => {
    const user = userEvent.setup();
    render(<SelectableSeatMap sections={tieredMap()} priceTiers={TIERS} maxSeats={8} action={noOpAction} />);
    await user.click(mapSeat("st-a-1"));

    const text = document.body.textContent ?? "";
    expect(text).toContain("Seats selected — not reserved yet.");
    expect(text).not.toMatch(/reserved for|\bbooked\b|\bsecured\b/i);
    // "Confirmed" only ever describes the future hold ("until your hold is confirmed").
    expect(text.match(/confirmed/gi)?.length).toBe(text.match(/until your hold is confirmed/gi)?.length);
    expect(text).not.toMatch(/fee|discount|tax/i);
  });
});

describe("M5.4 seat page: responsive composition", () => {
  it("shows the rail from lg and a sticky, safe-area sheet below lg at the end of the form", () => {
    render(<SelectableSeatMap sections={tieredMap()} priceTiers={TIERS} maxSeats={8} action={noOpAction} />);
    const form = rail().closest("form")!;

    expect(rail().className).toMatch(/(^| )hidden( |$)/);
    expect(rail().className).toContain("lg:block");
    expect(form.querySelector(".lg\\:grid-cols-\\[minmax\\(0\\,7fr\\)_minmax\\(20rem\\,3fr\\)\\]")).not.toBeNull();

    expect(sheet().className).toContain("lg:hidden");
    expect(sheet().className).toContain("sticky");
    expect(sheet().className).toContain("env(safe-area-inset-bottom)");
    // Last in the form: the sticky sheet never overlaps the content after it.
    expect(form.lastElementChild).toBe(sheet());
  });

  it("keeps the collapsed sheet compact: status, total and the hold action only", async () => {
    const user = userEvent.setup();
    render(<SelectableSeatMap sections={tieredMap()} priceTiers={TIERS} maxSeats={8} action={noOpAction} />);
    await user.click(mapSeat("st-a-1"));

    const collapsed = within(sheet());
    expect(collapsed.getByText(/not reserved yet/)).toBeVisible();
    expect(collapsed.getByTestId("selection-total")).toBeVisible();
    expect(collapsed.getByRole("button", { name: "Hold 1 seat" })).toBeVisible();
    expect(collapsed.queryByRole("button", { name: "Clear selection" })).not.toBeInTheDocument();
    expect(collapsed.getByText(/^Estimate only/)).not.toBeVisible();

    await user.click(collapsed.getByRole("button", { name: "View details" }));
    expect(collapsed.getByRole("button", { name: "Clear selection" })).toBeVisible();
    expect(collapsed.getByText(/^Estimate only/)).toBeVisible();
  });

  it("offers the list alternative under its own heading", () => {
    render(<SelectableSeatMap sections={tieredMap()} priceTiers={TIERS} maxSeats={8} action={noOpAction} />);
    const list = screen.getByRole("region", { name: "Choose seats from a list" });
    expect(within(list).getByLabelText("Section")).toBeInTheDocument();
    expect(within(list).getByLabelText("Row")).toBeInTheDocument();
  });
});

describe("M5.4 seat page: read-only preview", () => {
  it("shows the same map without selection, plus the side notice and real tiers", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <RealtimeSeatSelection
        sessionId="session-1"
        eventSlug="public-event"
        initialSections={tieredMap()}
        initialCounts={{ total: 8, available: 6, heldByYou: 1, unavailable: 1, blocked: 0 }}
        priceTiers={TIERS}
        maxSeats={8}
        initialTicket="initial-ticket"
        realtimeUrl=""
        railNotice={<p>Active hold notice</p>}
      />,
    );

    expect(mapSeat("st-a-1")).not.toHaveAttribute("aria-pressed");
    expect(mapSeat("st-a-1")).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("button", { name: /^Hold/ })).not.toBeInTheDocument();
    expect(document.querySelector("form")).toBeNull();
    expect(screen.getByText("Active hold notice")).toBeInTheDocument();
    const pricing = screen.getByRole("region", { name: "Seat categories and pricing" });
    expect(plain(pricing.textContent)).toContain("Front StallsClosest to the stageAZN 150.00");
  });
});

describe("M5.4 session date range", () => {
  it("formats a same-day session once in the venue time zone", () => {
    expect(
      formatVenueDateTimeRange("2035-05-01T15:00:00.000Z", "2035-05-01T19:00:00.000Z", "Asia/Baku").replace(/\s/g, " "),
    ).toBe("Tue, 1 May 2035, 19:00–23:00 GMT+4");
  });

  it("shows both dates when the session ends the next day", () => {
    const text = formatVenueDateTimeRange("2035-05-01T15:00:00.000Z", "2035-05-02T01:00:00.000Z", "Asia/Baku");
    expect(text.replace(/\s/g, " ")).toBe("Tue, 1 May 2035, 19:00 GMT+4 – Wed, 2 May 2035, 05:00 GMT+4");
  });
});
