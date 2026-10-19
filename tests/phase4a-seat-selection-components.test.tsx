import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HoldActionState } from "@/app/customer/hold-actions";
import { OrganizerInventorySummary } from "@/components/holds/organizer-inventory-summary";
import { SeatSelectionPreview } from "@/components/holds/seat-selection-preview";
import { SelectableSeatMap } from "@/components/holds/selectable-seat-map";
import type { SelectionSectionView } from "@/features/holds/inventory";

const sections: SelectionSectionView[] = [
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
          { seatId: "seat-2", label: "2", x: 40, y: 0, type: "PREMIUM", state: "AVAILABLE", priceMinor: 2_500, currency: "AZN" },
          { seatId: "seat-3", label: "3", x: 80, y: 0, type: "ACCESSIBLE", state: "AVAILABLE", priceMinor: 3_000, currency: "AZN" },
          { seatId: "seat-4", label: "4", x: 120, y: 0, type: "PREMIUM", state: "HELD_BY_YOU", priceMinor: 4_000, currency: "AZN" },
          { seatId: "seat-5", label: "5", x: 160, y: 0, type: "COMPANION", state: "UNAVAILABLE", priceMinor: null, currency: null },
          { seatId: "seat-6", label: "6", x: 200, y: 0, type: "STANDARD", state: "BLOCKED", priceMinor: null, currency: null },
        ],
      },
    ],
  },
];

const noOpAction = vi.fn(async (): Promise<HoldActionState> => ({}));

afterEach(() => {
  cleanup();
  noOpAction.mockClear();
});

// M5.4: SelectableSeatMap now composes the schematic venue map, the seat list
// and the selection summary. The map seat buttons, the desktop rail and the
// form are queried directly; jsdom applies no CSS, so the mobile sheet (a
// second summary hidden at lg+) is also in the DOM and queries are scoped.
function mapSeat(seatId: string) {
  return document.querySelector<HTMLElement>(`[data-seat-id="${seatId}"]`)!;
}

function rail() {
  return screen.getByRole("complementary", { name: "Your selection" });
}

describe("Phase 4A selectable seat map", () => {
  it("renders section, seat type, price, and customer-safe states on the map", () => {
    render(<SelectableSeatMap sections={sections} maxSeats={8} action={noOpAction} />);

    const available = mapSeat("seat-1");
    const heldByYou = mapSeat("seat-4");
    const heldByAnother = mapSeat("seat-5");
    const blocked = mapSeat("seat-6");

    expect(available.getAttribute("aria-label")!.replace(/\u00a0/g, " ")).toMatch(
      /^Main floor, row A, seat 1, available, AZN 10\.00$/,
    );
    expect(available).not.toHaveAttribute("aria-disabled");
    expect(heldByYou).toHaveAccessibleName(/seat 4, held by you, premium seat.*40\.00/i);
    expect(heldByYou).toHaveAttribute("aria-disabled", "true");
    expect(heldByAnother).toHaveAccessibleName(/seat 5, unavailable, companion seat$/i);
    expect(heldByAnother).toHaveAttribute("aria-disabled", "true");
    expect(heldByAnother).not.toHaveAccessibleName(/hold|customer|token/i);
    expect(blocked).toHaveAccessibleName(/seat 6, unavailable$/i);
    expect(blocked).toHaveAttribute("aria-disabled", "true");
    // Real seat order is kept on the schematic layout.
    expect(parseFloat(mapSeat("seat-2").style.left)).toBeGreaterThan(parseFloat(available.style.left));
  });

  it("updates selected count and total, then enforces the maximum with feedback", async () => {
    const user = userEvent.setup();
    render(<SelectableSeatMap sections={sections} maxSeats={2} action={noOpAction} />);

    await user.click(mapSeat("seat-1"));
    await user.click(mapSeat("seat-2"));

    expect(within(rail()).getByText(/2 of 2 seats selected/)).toBeInTheDocument();
    expect(within(rail()).getByTestId("selection-total")).toHaveTextContent(/35\.00/);
    expect(within(rail()).getByText(/reached the maximum of 2 seats/i)).toBeInTheDocument();
    expect(mapSeat("seat-3")).toHaveAttribute("aria-disabled", "true");
    expect(within(rail()).getByRole("button", { name: "Hold 2 seats" })).toBeEnabled();
  });

  it("shows a deterministic pending state while hold submission is in flight", async () => {
    const user = userEvent.setup();
    let resolveAction!: (state: HoldActionState) => void;
    const action = vi.fn<
      (state: HoldActionState, formData: FormData) => Promise<HoldActionState>
    >(
      () =>
        new Promise<HoldActionState>((resolve) => {
          resolveAction = resolve;
        }),
    );
    render(<SelectableSeatMap sections={sections} maxSeats={8} action={action} />);

    await user.click(mapSeat("seat-1"));
    await user.click(within(rail()).getByRole("button", { name: "Hold 1 seat" }));

    expect(await within(rail()).findByRole("button", { name: "Holding…" })).toBeDisabled();
    expect(action).toHaveBeenCalledTimes(1);
    const submitted = action.mock.calls[0]![1];
    expect(submitted.getAll("seatIds")).toEqual(["seat-1"]);
    expect(String(submitted.get("idempotencyKey"))).toMatch(/^[0-9a-f-]{36}$/i);

    await act(async () => resolveAction({}));
  });

  it("renders server conflict feedback without clearing the selected seats", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async () => ({
      message: "One or more selected seats are no longer available.",
    }));
    render(<SelectableSeatMap sections={sections} maxSeats={8} action={action} />);

    await user.click(mapSeat("seat-2"));
    await user.click(within(rail()).getByRole("button", { name: "Hold 1 seat" }));

    expect(await within(rail()).findByRole("alert")).toHaveTextContent(/no longer available/i);
    expect(within(rail()).getByText(/1 of 8 seats selected/)).toBeInTheDocument();
    expect(mapSeat("seat-2")).toHaveAttribute("aria-pressed", "true");
  });

  it("renders honest empty and temporarily unavailable states", () => {
    const { rerender } = render(
      <SelectableSeatMap sections={[]} maxSeats={8} action={noOpAction} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/no seats are available/i);

    rerender(
      <SelectableSeatMap
        sections={[
          {
            ...sections[0]!,
            rows: [
              {
                ...sections[0]!.rows[0]!,
                seats: sections[0]!.rows[0]!.seats.map((seat) => ({
                  ...seat,
                  state: "UNAVAILABLE" as const,
                  priceMinor: null,
                  currency: null,
                })),
              },
            ],
          },
        ]}
        maxSeats={8}
        action={noOpAction}
      />,
    );
    expect(screen.getByText(/no seats are currently available to hold/i)).toHaveAttribute("role", "status");
    expect(mapSeat("seat-1")).toHaveAccessibleName(/seat 1.*unavailable/i);
    expect(mapSeat("seat-1")).toHaveAttribute("aria-disabled", "true");
  });
});

describe("Phase 4A non-interactive seat and organizer summaries", () => {
  it("previews available, owner-held, other-held, and blocked seats", () => {
    render(<SeatSelectionPreview sections={sections} />);
    expect(screen.getByRole("img", { name: /seat 1, standard: available/i })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /seat 4, premium: held by you/i })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /seat 5, companion: unavailable/i })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /seat 6, standard: blocked/i })).toBeInTheDocument();
  });

  it("shows a preview empty state instead of inventing seats", () => {
    render(<SeatSelectionPreview sections={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent(/no seats are available/i);
  });

  it("renders an aggregate organizer inventory summary without customer details", () => {
    render(
      <OrganizerInventorySummary
        summary={{
          total: 20,
          available: 14,
          held: 6,
          activeHolds: 3,
          earliestHoldExpiresAt: "2035-05-01T12:10:00.000Z",
        }}
        timeZone="Asia/Baku"
      />,
    );
    expect(screen.getByText("Sellable inventory").nextElementSibling).toHaveTextContent(
      "20",
    );
    expect(screen.getByText("Available").nextElementSibling).toHaveTextContent("14");
    expect(screen.getByText("Currently held").nextElementSibling).toHaveTextContent("6");
    expect(screen.getByText("Active holds").nextElementSibling).toHaveTextContent("3");
    expect(screen.getByText(/earliest active hold expires/i)).toBeInTheDocument();
    expect(screen.queryByText(/@example\.com|public-token/i)).not.toBeInTheDocument();
  });

  it("renders the organizer pre-materialization state", () => {
    render(
      <OrganizerInventorySummary
        summary={{
          total: 0,
          available: 0,
          held: 0,
          activeHolds: 0,
          earliestHoldExpiresAt: null,
        }}
        timeZone="Asia/Baku"
      />,
    );
    expect(screen.getByText(/materialized when this session is published/i)).toBeInTheDocument();
  });
});
