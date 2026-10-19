import type { BookingStatus } from "@/generated/prisma/enums";

/**
 * Customer-facing payment and refund summary for one booking.
 *
 * Every figure comes from the captured payment attempt's own ledger columns:
 * `amountMinor` (captured), `refundedMinor` (settled refunds) and
 * `inFlightRefundMinor` (refunds requested but not yet confirmed). Nothing here
 * is recomputed from refund rows or seat prices, so the summary can never drift
 * from the financial record, and an in-flight refund is never shown as money
 * already returned.
 *
 * The schema has no PARTIALLY_REFUNDED booking status: a partially refunded
 * booking stays CONFIRMED. The partial state is therefore derived from amounts.
 *
 * Pure: no I/O.
 */

export type BookingRefundState = "NONE" | "PARTIAL" | "FULL";

export interface BookingPaymentFigures {
  paidMinor: number;
  refundedMinor: number;
  inFlightMinor: number;
}

export interface BookingPaymentSummary extends BookingPaymentFigures {
  netPaidMinor: number;
  refundState: BookingRefundState;
  refundInProgress: boolean;
}

function nonNegativeInteger(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function summarizeBookingPayment(input: {
  bookingStatus: BookingStatus;
  figures: BookingPaymentFigures;
}): BookingPaymentSummary {
  const paidMinor = nonNegativeInteger(input.figures.paidMinor);
  // Refunds can never exceed the capture; clamp rather than show a negative net.
  const refundedMinor = Math.min(nonNegativeInteger(input.figures.refundedMinor), paidMinor);
  const inFlightMinor = nonNegativeInteger(input.figures.inFlightMinor);

  let refundState: BookingRefundState = "NONE";
  if (input.bookingStatus === "REFUNDED" || (paidMinor > 0 && refundedMinor >= paidMinor)) {
    refundState = "FULL";
  } else if (refundedMinor > 0) {
    refundState = "PARTIAL";
  }

  return {
    paidMinor,
    refundedMinor,
    inFlightMinor,
    netPaidMinor: paidMinor - refundedMinor,
    refundState,
    refundInProgress: inFlightMinor > 0,
  };
}

export function bookingStatusLabel(refundState: BookingRefundState) {
  if (refundState === "FULL") return "Refunded";
  if (refundState === "PARTIAL") return "Partially refunded";
  return "Confirmed";
}

/** Human label for the latest payment attempt status of a booking's order. */
export function paymentStatusLabel(status: string) {
  switch (status) {
    case "SUCCEEDED":
      return "Payment received";
    case "PENDING":
    case "CREATED":
      return "Payment pending";
    case "REQUIRES_REVIEW":
      return "Payment under review";
    case "FAILED":
      return "Payment failed";
    case "CANCELLED":
      return "Payment cancelled";
    default:
      return "Payment status unavailable";
  }
}
