import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BookingSummaryCard } from "@/components/bookings/booking-summary-card";
import { OrganizerBookingSummary } from "@/components/bookings/organizer-booking-summary";
import { CheckoutSummary } from "@/components/checkout/checkout-summary";
import { PendingSubmitButton } from "@/components/checkout/pending-submit-button";
import { SimulatedPaymentWarning } from "@/components/checkout/simulated-payment-warning";
import type { CustomerCheckoutView } from "@/server/payments/checkout-queries";
import type { CustomerBookingView } from "@/server/payments/booking-queries";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

afterEach(() => cleanup());

function checkout(state: CustomerCheckoutView["displayState"]): CustomerCheckoutView {
  return {
    publicReference: "order_reference_1234567890123456",
    status: state === "CONFIRMED" ? "FULFILLED" : state === "FAILED" ? "FAILED" : state === "EXPIRED" ? "EXPIRED" : state === "REQUIRES_REVIEW" ? "PAID_UNFULFILLED" : state === "CANCELLED" ? "CANCELLED" : "PAYMENT_PENDING",
    displayState: state,
    currency: "AZN",
    subtotalMinor: 5_000,
    totalMinor: 5_000,
    checkoutExpiresAt: "2035-01-01T00:10:00.000Z",
    paidAt: state === "CONFIRMED" || state === "REQUIRES_REVIEW" ? "2035-01-01T00:01:00.000Z" : null,
    fulfilledAt: state === "CONFIRMED" ? "2035-01-01T00:01:00.000Z" : null,
    safeFailureCode: state === "REQUIRES_REVIEW" ? "HOLD_EXPIRED" : null,
    simulatedProvider: true,
    payment: { status: state === "FAILED" ? "FAILED" : state === "CONFIRMED" || state === "REQUIRES_REVIEW" ? "SUCCEEDED" : "PENDING", provider: "LOCAL_SIGNED", initialized: true },
    bookingReference: state === "CONFIRMED" ? "booking_reference_123456789012" : null,
    event: { title: "Aurora Live", publicSlug: "seatflow--aurora-live" },
    session: { id: "session_1", startAt: "2035-02-01T18:00:00.000Z", timeZone: "Asia/Baku", venueName: "Main Hall", spaceName: "Auditorium", city: "Baku" },
    seats: [
      { inventoryId: "inventory_1", seatLabel: "1", rowLabel: "A", sectionName: "Orchestra", sectionCode: "ORCH", tierName: "Standard", tierCode: "STD", priceMinor: 2_500, currency: "AZN" },
      { inventoryId: "inventory_2", seatLabel: "2", rowLabel: "A", sectionName: "Orchestra", sectionCode: "ORCH", tierName: "Standard", tierCode: "STD", priceMinor: 2_500, currency: "AZN" },
    ],
  };
}

describe("Phase 5A checkout states", () => {
  it.each([
    ["PENDING", /payment pending/i],
    ["FAILED", /payment failed/i],
    ["CONFIRMED", /booking confirmed/i],
    ["REQUIRES_REVIEW", /payment under review/i],
    ["EXPIRED", /checkout expired/i],
    ["CANCELLED", /payment cancelled/i],
  ] as const)("renders the %s state honestly", (state, label) => {
    render(<CheckoutSummary checkout={checkout(state)} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText(/official total/i).nextElementSibling).toHaveTextContent("50");
    if (state === "CONFIRMED") expect(screen.getByRole("link", { name: /view confirmed booking/i })).toBeInTheDocument();
    else expect(screen.queryByRole("link", { name: /view confirmed booking/i })).not.toBeInTheDocument();
  });

  it("labels the local provider as simulated and disclaims real payment data", () => {
    render(<SimulatedPaymentWarning />);
    expect(screen.getByRole("note")).toHaveTextContent(/simulated payment/i);
    expect(screen.getByRole("note")).toHaveTextContent(/no real card or bank details/i);
  });

  it("disables the submit control while checkout creation is pending", async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const pendingAction = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(
      <form action={pendingAction}>
        <PendingSubmitButton pendingLabel="Creating checkout…">Continue to checkout</PendingSubmitButton>
      </form>,
    );
    const button = screen.getByRole("button", { name: /continue to checkout/i });
    await user.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    await user.click(button);
    expect(pendingAction).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(button).toBeEnabled());
  });
});

describe("Phase 5A booking views", () => {
  const booking: CustomerBookingView = {
    publicReference: "booking_reference_123456789012",
    status: "CONFIRMED",
    currency: "AZN",
    totalMinor: 2_500,
    confirmedAt: "2035-01-01T00:01:00.000Z",
    paymentStatus: "SUCCEEDED",
    event: { title: "Aurora Live", publicSlug: "seatflow--aurora-live" },
    session: { id: "session_1", startAt: "2035-02-01T18:00:00.000Z", timeZone: "Asia/Baku", venueName: "Main Hall", spaceName: "Auditorium", city: "Baku" },
    seats: [{ seatLabel: "1", rowLabel: "A", sectionName: "Orchestra", sectionCode: "ORCH", tierName: "Standard", tierCode: "STD", priceMinor: 2_500, currency: "AZN" }],
  };

  it("renders a confirmed customer booking without calling it a ticket", () => {
    render(<BookingSummaryCard booking={booking} />);
    expect(screen.getByText("CONFIRMED")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view booking/i })).toBeInTheDocument();
    expect(screen.queryByText(/ticket/i)).not.toBeInTheDocument();
  });

  it("renders organizer aggregates without customer identity", () => {
    render(<OrganizerBookingSummary summary={{ confirmedBookingCount: 3, bookedSeatCount: 7, grossByCurrency: [{ currency: "AZN", totalMinor: 17_500 }], paidUnfulfilledReviewCount: 1 }} />);
    expect(screen.getByText("Confirmed bookings").nextElementSibling).toHaveTextContent("3");
    expect(screen.getByText("Booked seats").nextElementSibling).toHaveTextContent("7");
    expect(screen.getByText(/paid — review required/i).nextElementSibling).toHaveTextContent("1");
    expect(screen.queryByText(/@example\.com/i)).not.toBeInTheDocument();
  });
});
