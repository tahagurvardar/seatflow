import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HoldCountdown } from "@/components/holds/hold-countdown";
import { HoldSummaryCard } from "@/components/holds/hold-summary-card";
import type { CustomerHoldView } from "@/features/holds/view-models";

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

const NOW = new Date("2035-05-01T12:00:00.000Z");

function holdView(
  override: Partial<CustomerHoldView> = {},
): CustomerHoldView {
  return {
    publicToken: "public-token-with-enough-entropy",
    status: "ACTIVE",
    live: true,
    expired: false,
    expiresAt: "2035-05-01T12:10:00.000Z",
    createdAt: "2035-05-01T12:00:00.000Z",
    releasedAt: null,
    expiredAt: null,
    secondsRemaining: 600,
    event: { title: "Aurora Room", publicSlug: "aurora-room" },
    session: {
      id: "session-1",
      startAt: "2035-05-01T20:00:00.000Z",
      timeZone: "Asia/Baku",
      venueName: "North Hall",
      spaceName: "Main Auditorium",
      city: "Baku",
    },
    seats: [
      {
        sectionName: "Main",
        sectionCode: "MAIN",
        rowLabel: "A",
        seatLabel: "1",
        seatType: "STANDARD",
        priceMinor: 2_500,
        currency: "AZN",
      },
    ],
    totalMinor: 2_500,
    currency: "AZN",
    seatCount: 1,
    ...override,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  refreshMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Phase 4A informational hold countdown", () => {
  it("renders deterministic minutes and seconds, then refreshes once at zero", () => {
    render(<HoldCountdown expiresAt="2035-05-01T12:01:30.000Z" />);
    expect(screen.getByRole("timer")).toHaveTextContent("1:30");
    expect(screen.getByRole("timer")).toHaveAttribute("aria-live", "off");

    act(() => vi.advanceTimersByTime(31_000));
    expect(screen.getByRole("timer")).toHaveTextContent("0:59");
    expect(refreshMock).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(59_000));
    expect(screen.getByRole("status")).toHaveTextContent(/confirming with server/i);
    expect(refreshMock).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(5_000));
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });
});

describe("Phase 4A hold summary states", () => {
  it("renders an active hold with its informational countdown", () => {
    render(<HoldSummaryCard hold={holdView()} />);
    expect(screen.getByText("ACTIVE")).toBeInTheDocument();
    expect(screen.getByText(/expires in/i)).toBeInTheDocument();
    expect(screen.getByRole("timer")).toHaveTextContent("10:00");
    expect(screen.getByRole("link", { name: "View hold" })).toHaveAttribute(
      "href",
      "/customer/holds/public-token-with-enough-entropy",
    );
  });

  it("labels an elapsed but not-yet-swept active row as expired", () => {
    render(
      <HoldSummaryCard
        hold={holdView({
          live: false,
          expired: true,
          secondsRemaining: 0,
          expiresAt: "2035-05-01T11:59:59.000Z",
        })}
      />,
    );
    expect(screen.getByText("EXPIRED")).toBeInTheDocument();
    expect(screen.queryByText(/expires in/i)).not.toBeInTheDocument();
  });

  it("renders a manually released hold as terminal", () => {
    render(
      <HoldSummaryCard
        hold={holdView({
          status: "RELEASED",
          live: false,
          releasedAt: "2035-05-01T12:02:00.000Z",
          secondsRemaining: 0,
        })}
      />,
    );
    expect(screen.getByText("RELEASED")).toBeInTheDocument();
    expect(screen.getByText("released")).toBeInTheDocument();
  });
});
