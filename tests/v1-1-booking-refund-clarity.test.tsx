import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BookingPaymentSummary } from "@/components/bookings/booking-payment-summary";
import { RefundHistory, refundStatusPresentation } from "@/components/refunds/refund-history";
import { TicketSummaryCard } from "@/components/tickets/ticket-summary-card";
import {
  paymentStatusLabel,
  summarizeBookingPayment,
} from "@/features/bookings/payment-summary";
import { formatMinorCurrency } from "@/features/events/money";
import {
  ticketPdfAvailability,
  ticketRevocationMessage,
} from "@/features/tickets/lifecycle";
import type { CustomerTicketView } from "@/server/tickets/ticket-queries";

// toHaveTextContent collapses whitespace, including the non-breaking space Intl
// places after the currency code, so the expectation is normalized the same way.
const azn = (minor: number) => formatMinorCurrency(minor, "AZN").replace(/\s+/g, " ");

describe("booking payment summary", () => {
  it("reports no refund for an untouched booking", () => {
    expect(
      summarizeBookingPayment({
        bookingStatus: "CONFIRMED",
        figures: { paidMinor: 5_000, refundedMinor: 0, inFlightMinor: 0 },
      }),
    ).toEqual({
      paidMinor: 5_000,
      refundedMinor: 0,
      inFlightMinor: 0,
      netPaidMinor: 5_000,
      refundState: "NONE",
      refundInProgress: false,
    });
  });

  it("derives a partial refund from amounts while the booking stays CONFIRMED", () => {
    const summary = summarizeBookingPayment({
      bookingStatus: "CONFIRMED",
      figures: { paidMinor: 5_000, refundedMinor: 2_500, inFlightMinor: 0 },
    });
    expect(summary).toMatchObject({ refundState: "PARTIAL", netPaidMinor: 2_500 });
  });

  it("treats a REFUNDED booking as fully refunded", () => {
    const summary = summarizeBookingPayment({
      bookingStatus: "REFUNDED",
      figures: { paidMinor: 5_000, refundedMinor: 5_000, inFlightMinor: 0 },
    });
    expect(summary).toMatchObject({ refundState: "FULL", netPaidMinor: 0 });
  });

  it("treats settled refunds equal to the capture as full even before the status catches up", () => {
    expect(
      summarizeBookingPayment({
        bookingStatus: "CONFIRMED",
        figures: { paidMinor: 5_000, refundedMinor: 5_000, inFlightMinor: 0 },
      }).refundState,
    ).toBe("FULL");
  });

  it("never subtracts an in-flight refund that has not settled", () => {
    const summary = summarizeBookingPayment({
      bookingStatus: "CONFIRMED",
      figures: { paidMinor: 5_000, refundedMinor: 0, inFlightMinor: 2_500 },
    });
    expect(summary).toMatchObject({ refundState: "NONE", netPaidMinor: 5_000, refundInProgress: true });
  });

  it("combines a settled partial refund with a further one in flight", () => {
    const summary = summarizeBookingPayment({
      bookingStatus: "CONFIRMED",
      figures: { paidMinor: 6_000, refundedMinor: 2_000, inFlightMinor: 2_000 },
    });
    expect(summary).toMatchObject({ refundState: "PARTIAL", netPaidMinor: 4_000, refundInProgress: true });
  });

  it("clamps impossible figures instead of showing a negative net", () => {
    expect(
      summarizeBookingPayment({
        bookingStatus: "CONFIRMED",
        figures: { paidMinor: 1_000, refundedMinor: 9_999, inFlightMinor: -5 },
      }),
    ).toMatchObject({ refundedMinor: 1_000, netPaidMinor: 0, inFlightMinor: 0, refundState: "FULL" });
    expect(
      summarizeBookingPayment({
        bookingStatus: "CONFIRMED",
        figures: { paidMinor: Number.NaN, refundedMinor: 0, inFlightMinor: 0 },
      }),
    ).toMatchObject({ paidMinor: 0, netPaidMinor: 0, refundState: "NONE" });
  });

  it("labels payment states in plain language and never echoes an unknown code", () => {
    expect(paymentStatusLabel("SUCCEEDED")).toBe("Payment received");
    expect(paymentStatusLabel("REQUIRES_REVIEW")).toBe("Payment under review");
    expect(paymentStatusLabel("SOMETHING_NEW")).toBe("Payment status unavailable");
  });
});

describe("BookingPaymentSummary component", () => {
  function renderSummary(bookingStatus: "CONFIRMED" | "REFUNDED", figures: { paidMinor: number; refundedMinor: number; inFlightMinor: number }) {
    return render(
      <BookingPaymentSummary summary={summarizeBookingPayment({ bookingStatus, figures })} currency="AZN" />,
    );
  }

  it("keeps the single confirmed total when nothing was refunded", () => {
    renderSummary("CONFIRMED", { paidMinor: 5_000, refundedMinor: 0, inFlightMinor: 0 });
    expect(screen.getByText("Confirmed total").nextElementSibling).toHaveTextContent(azn(5_000));
    expect(screen.queryByText("Refunded")).not.toBeInTheDocument();
    expect(screen.queryByText("Net paid")).not.toBeInTheDocument();
  });

  it("shows paid, refunded and net for a partial refund", () => {
    renderSummary("CONFIRMED", { paidMinor: 5_000, refundedMinor: 2_000, inFlightMinor: 0 });
    expect(screen.getByText("Paid").nextElementSibling).toHaveTextContent(azn(5_000));
    expect(screen.getByText("Refunded").nextElementSibling).toHaveTextContent(azn(2_000));
    expect(screen.getByText("Net paid").nextElementSibling).toHaveTextContent(azn(3_000));
  });

  it("shows a zero net for a full refund", () => {
    renderSummary("REFUNDED", { paidMinor: 5_000, refundedMinor: 5_000, inFlightMinor: 0 });
    expect(screen.getByText("Net paid").nextElementSibling).toHaveTextContent(azn(0));
  });

  it("describes an in-flight refund as in progress without subtracting it", () => {
    renderSummary("CONFIRMED", { paidMinor: 5_000, refundedMinor: 0, inFlightMinor: 1_500 });
    expect(screen.getByText("Confirmed total").nextElementSibling).toHaveTextContent(azn(5_000));
    expect(screen.getByText(/refund of .* is in progress/i)).toHaveTextContent(azn(1_500));
  });
});

describe("ticket revocation and PDF availability", () => {
  it.each([
    ["REFUNDED", /because it was refunded/],
    ["DISPUTE_OPENED", /payment dispute is reviewed/],
    ["DISPUTE_LOST", /after a payment dispute/],
    [null, /contact the event organizer/i],
  ] as const)("explains reason %s in plain language", (reason, pattern) => {
    expect(ticketRevocationMessage(reason)).toMatch(pattern);
  });

  it("never shows operator free text to the customer", () => {
    const note = "internal: suspected resale, see ticket OPS-4411";
    const message = ticketRevocationMessage(note);
    expect(message).not.toContain("OPS-4411");
    expect(message).toMatch(/cancelled/);
  });

  it("withholds the PDF for a refunded booking", () => {
    expect(ticketPdfAvailability({ bookingStatus: "REFUNDED", ticketStatuses: ["USED", "REVOKED"] })).toEqual({
      available: false,
      message: expect.stringMatching(/booking was refunded/),
    });
  });

  it("keeps the PDF for a partially refunded booking that still has a valid ticket", () => {
    expect(ticketPdfAvailability({ bookingStatus: "CONFIRMED", ticketStatuses: ["ACTIVE", "REVOKED"] })).toEqual({
      available: true,
    });
  });

  it("withholds the PDF when every ticket in a confirmed booking was cancelled", () => {
    expect(ticketPdfAvailability({ bookingStatus: "CONFIRMED", ticketStatuses: ["REVOKED", "REVOKED"] }).available).toBe(false);
  });

  it("does not offer the PDF on the page of a cancelled ticket", () => {
    expect(
      ticketPdfAvailability({ bookingStatus: "CONFIRMED", ticketStatuses: ["REVOKED"], viewedTicketStatus: "REVOKED" }),
    ).toEqual({ available: false, message: expect.stringMatching(/ticket was cancelled/) });
    expect(
      ticketPdfAvailability({ bookingStatus: "CONFIRMED", ticketStatuses: ["USED"], viewedTicketStatus: "USED" }).available,
    ).toBe(true);
  });
});

describe("refund history states", () => {
  const base = {
    publicReference: "R".repeat(32),
    scope: "FULL_BOOKING",
    requestedAmountMinor: 2_500,
    currency: "AZN" as const,
    requestedAt: "2035-01-01T10:00:00.000Z",
    succeededAt: null,
    failedAt: null,
    cancelledAt: null,
    reviewRequiredAt: null,
  };

  it("does not present an unknown status as requested or succeeded", () => {
    render(<RefundHistory refunds={[{ ...base, status: "PARTIALLY_SETTLED_V2" }]} />);
    expect(screen.getByText("Status updating")).toBeInTheDocument();
    expect(screen.queryByText("Requested")).not.toBeInTheDocument();
    expect(screen.queryByText("Succeeded")).not.toBeInTheDocument();
  });

  it("does not resolve inherited object keys as statuses", () => {
    expect(refundStatusPresentation("toString").label).toBe("Status updating");
    expect(refundStatusPresentation("constructor").label).toBe("Status updating");
  });

  it.each([
    ["REQUESTED", "Requested"],
    ["SUBMITTING", "Processing"],
    ["PROCESSING", "Processing"],
    ["SUCCEEDED", "Succeeded"],
    ["FAILED", "Failed"],
    ["CANCELLED", "Cancelled"],
    ["REQUIRES_REVIEW", "Requires review"],
  ])("keeps the %s label", (status, label) => {
    expect(refundStatusPresentation(status).label).toBe(label);
  });
});

describe("ticket summary card revocation", () => {
  const ticket: CustomerTicketView = {
    publicReference: "A".repeat(32),
    bookingReference: "B".repeat(32),
    bookingStatus: "REFUNDED",
    status: "REVOKED",
    issuedAt: "2035-01-01T10:00:00.000Z",
    revokedAt: "2035-01-02T10:00:00.000Z",
    revocationReason: "REFUNDED",
    credentialAvailable: false,
    event: { title: "Aurora Room", publicSlug: "seatflow--aurora-room" },
    session: {
      id: "session-safe",
      startAt: "2035-02-01T18:00:00.000Z",
      endAt: "2035-02-01T20:00:00.000Z",
      timeZone: "Asia/Baku",
      venueName: "Harbor Hall",
      spaceName: "Main",
      city: "Baku",
    },
    seat: { seatLabel: "12", rowLabel: "A", sectionName: "Orchestra", sectionCode: "ORCH", tierName: "Standard" },
  };

  it("explains why a revoked ticket cannot be used", () => {
    render(<TicketSummaryCard ticket={ticket} />);
    expect(screen.getByText(/cancelled because it was refunded/)).toBeInTheDocument();
  });

  it("adds no explanation to a valid ticket", () => {
    render(<TicketSummaryCard ticket={{ ...ticket, status: "ACTIVE", revocationReason: null, revokedAt: null }} />);
    expect(screen.queryByText(/cancelled/)).not.toBeInTheDocument();
  });
});
