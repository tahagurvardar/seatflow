import { act, cleanup, render, screen } from "@testing-library/react";
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

describe("Phase 4A selectable coordinate seat map", () => {
  it("renders coordinates, section, seat type, price, and customer-safe states", () => {
    render(
      <SelectableSeatMap
        sections={sections}
        maxSeats={8}
        currency="AZN"
        action={noOpAction}
      />,
    );

    const available = screen.getByRole("button", {
      name: /Main floor, row A, seat 1, standard: available.*10\.00/i,
    });
    const heldByYou = screen.getByRole("button", {
      name: /seat 4, premium: held by you.*40\.00/i,
    });
    const heldByAnother = screen.getByRole("button", {
      name: /seat 5, companion: unavailable/i,
    });
    const blocked = screen.getByRole("button", {
      name: /seat 6, standard: blocked/i,
    });

    expect(available).toBeEnabled();
    expect(heldByYou).toBeDisabled();
    expect(heldByAnother).toBeDisabled();
    expect(heldByAnother).not.toHaveAccessibleName(/hold|customer|token/i);
    expect(blocked).toBeDisabled();
    expect(available.parentElement).toHaveAttribute("data-seat-coordinate", "0,0");
    expect(available.parentElement).toHaveStyle({ left: "56px", top: "12px" });
  });

  it("updates selected count and total, then enforces the maximum with feedback", async () => {
    const user = userEvent.setup();
    render(
      <SelectableSeatMap
        sections={sections}
        maxSeats={2}
        currency="AZN"
        action={noOpAction}
      />,
    );

    await user.click(screen.getByRole("button", { name: /seat 1, standard: available/i }));
    await user.click(screen.getByRole("button", { name: /seat 2, premium: available/i }));

    expect(screen.getByText("2 of 2 seats selected")).toBeInTheDocument();
    expect(screen.getByText(/35\.00/)).toBeInTheDocument();
    expect(screen.getByText(/reached the maximum of 2 seats/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /seat 3, accessible: available/i }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Hold 2 seats" })).toBeEnabled();
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
    render(
      <SelectableSeatMap
        sections={sections}
        maxSeats={8}
        currency="AZN"
        action={action}
      />,
    );

    await user.click(screen.getByRole("button", { name: /seat 1, standard: available/i }));
    await user.click(screen.getByRole("button", { name: "Hold 1 seat" }));

    expect(await screen.findByRole("button", { name: "Holding…" })).toBeDisabled();
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
    render(
      <SelectableSeatMap
        sections={sections}
        maxSeats={8}
        currency="AZN"
        action={action}
      />,
    );

    await user.click(screen.getByRole("button", { name: /seat 2, premium: available/i }));
    await user.click(screen.getByRole("button", { name: "Hold 1 seat" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/no longer available/i);
    expect(screen.getByText("1 of 8 seats selected")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /seat 2, premium: available/i }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("renders honest empty and temporarily unavailable states", () => {
    const { rerender } = render(
      <SelectableSeatMap
        sections={[]}
        maxSeats={8}
        currency={null}
        action={noOpAction}
      />,
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
        currency="AZN"
        action={noOpAction}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      /no seats are currently available to hold/i,
    );
    expect(screen.getByRole("button", { name: /seat 1.*unavailable/i })).toBeDisabled();
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
