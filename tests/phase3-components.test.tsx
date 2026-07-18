import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { EventForm } from "@/components/organizer/event-form";
import { PricingSummary } from "@/components/organizer/pricing-summary";
import { SessionForm } from "@/components/organizer/session-form";
import { EmptyState } from "@/components/ui/empty-state";

describe("Phase 3 organizer forms", () => {
  it("renders normalized event fields without exposing an organizer id", () => {
    render(
      <EventForm
        action={vi.fn(async () => ({}))}
        submitLabel="Save event"
        defaults={{
          title: "Aurora Room",
          slug: "aurora-room",
          shortDescription: "A luminous live performance.",
          description:
            "A complete description for this persistent event and its programme.",
          category: "CONCERT",
        }}
      />,
    );
    expect(screen.getByLabelText("Event title")).toHaveValue("Aurora Room");
    expect(screen.getByLabelText("Category")).toHaveValue("CONCERT");
    expect(screen.queryByLabelText(/organizer id/i)).not.toBeInTheDocument();
  });

  it("filters spaces and published maps when the approved venue changes", async () => {
    const user = userEvent.setup();
    render(
      <SessionForm
        action={vi.fn(async () => ({}))}
        submitLabel="Save session"
        venues={[
          {
            id: "venue-1",
            name: "North Hall",
            city: "Baku",
            timeZone: "Asia/Baku",
            spaces: [
              {
                id: "space-1",
                name: "Main",
                seatMaps: [{ id: "map-1", name: "Main map", version: 2 }],
              },
            ],
          },
          {
            id: "venue-2",
            name: "South Hall",
            city: "Tbilisi",
            timeZone: "Asia/Tbilisi",
            spaces: [
              {
                id: "space-2",
                name: "Studio",
                seatMaps: [{ id: "map-2", name: "Studio map", version: 4 }],
              },
            ],
          },
        ]}
      />,
    );
    await user.selectOptions(screen.getByLabelText("Approved venue"), "venue-2");
    expect(screen.getByLabelText("Active space")).toHaveValue("space-2");
    expect(screen.getByLabelText("Exact published seat map")).toHaveValue("map-2");
    expect(screen.getByText(/Asia\/Tbilisi/)).toBeInTheDocument();
  });
});

describe("Phase 3 pricing and empty states", () => {
  it("renders tier price and section-derived capacity without sales claims", () => {
    render(
      <PricingSummary
        tiers={[
          {
            id: "tier-1",
            name: "Premium",
            code: "PREM",
            priceMinor: 4_500,
            currency: "AZN",
            sellableCapacity: 12,
          },
        ]}
        totalSellable={20}
        pricedSellable={12}
        unpricedSellable={8}
      />,
    );
    expect(screen.getByText("Premium")).toBeInTheDocument();
    expect(screen.getByText("12 seats")).toBeInTheDocument();
    expect(screen.getByText(/45\.00/)).toBeInTheDocument();
    expect(screen.queryByText(/sold/i)).not.toBeInTheDocument();
  });

  it("renders honest event and session empty states", () => {
    const { rerender } = render(
      <EmptyState
        icon="calendar"
        title="No persistent events yet"
        description="Create a draft event before adding sessions."
      />,
    );
    expect(screen.getByText("No persistent events yet")).toBeInTheDocument();
    rerender(
      <EmptyState
        icon="calendar"
        title="No sessions are configured"
        description="Add an approved venue session when ready."
      />,
    );
    expect(screen.getByText("No sessions are configured")).toBeInTheDocument();
  });
});
