import type { Currency, RefundScope } from "@/generated/prisma/enums";

/**
 * Server-side refund amount calculation.
 *
 * Every amount here comes from immutable booking snapshots taken at purchase
 * time. Current event pricing is never consulted, and no client-supplied total,
 * currency, or seat price is ever trusted: callers pass identifiers, and this
 * module decides what may be refunded.
 */

export interface RefundableSeatSnapshot {
  bookingSeatId: string;
  /** The price actually paid for this seat, from the BookingSeat snapshot. */
  priceMinor: number;
  currency: Currency;
  /** True when a live or already-succeeded refund covers this seat. */
  alreadyRefunded: boolean;
}

export interface RefundCapacity {
  /** The captured payment amount. */
  capturedMinor: number;
  /** Sum of refunds that have actually succeeded. */
  refundedMinor: number;
  /** Sum of refunds still reserved against the payment. */
  inFlightMinor: number;
  currency: Currency;
}

export function remainingRefundableMinor(capacity: RefundCapacity) {
  return Math.max(0, capacity.capturedMinor - capacity.refundedMinor - capacity.inFlightMinor);
}

export type RefundCalculationResult =
  | {
      outcome: "ELIGIBLE";
      scope: RefundScope;
      amountMinor: number;
      currency: Currency;
      bookingSeatIds: string[];
    }
  | { outcome: "REJECTED"; reason: RefundRejectionReason };

export type RefundRejectionReason =
  | "NOTHING_REFUNDABLE"
  | "SEAT_NOT_IN_BOOKING"
  | "SEAT_ALREADY_REFUNDED"
  | "NO_SEATS_SELECTED"
  | "MIXED_CURRENCY"
  | "EXCEEDS_REMAINING"
  | "AMOUNT_NOT_POSITIVE";

/**
 * Price a whole-booking refund from what is still refundable.
 *
 * A booking that has already been partially refunded yields only the remainder,
 * which is what keeps "refund the rest" from ever becoming a second full refund.
 */
export function calculateFullBookingRefund(input: {
  seats: readonly RefundableSeatSnapshot[];
  capacity: RefundCapacity;
}): RefundCalculationResult {
  const remaining = remainingRefundableMinor(input.capacity);
  if (remaining <= 0) return { outcome: "REJECTED", reason: "NOTHING_REFUNDABLE" };

  const openSeats = input.seats.filter((seat) => !seat.alreadyRefunded);
  if (openSeats.length === 0) return { outcome: "REJECTED", reason: "NOTHING_REFUNDABLE" };
  if (openSeats.some((seat) => seat.currency !== input.capacity.currency)) {
    return { outcome: "REJECTED", reason: "MIXED_CURRENCY" };
  }

  const seatTotal = openSeats.reduce((sum, seat) => sum + seat.priceMinor, 0);
  // The remaining capacity is the hard ceiling even when the seat snapshots add
  // up to more, so a refund can never exceed what was actually captured.
  const amountMinor = Math.min(seatTotal, remaining);
  if (amountMinor <= 0) return { outcome: "REJECTED", reason: "AMOUNT_NOT_POSITIVE" };

  return {
    outcome: "ELIGIBLE",
    // Only a refund that covers every open seat at full snapshot price is a
    // true full-booking refund; a capped one is priced per seat instead.
    scope: amountMinor === seatTotal ? "FULL_BOOKING" : "SELECTED_SEATS",
    amountMinor,
    currency: input.capacity.currency,
    bookingSeatIds: openSeats.map((seat) => seat.bookingSeatId),
  };
}

/**
 * Price a refund over specific booked seats. The caller supplies seat
 * identifiers only; prices come from the snapshots.
 */
export function calculateSeatRefund(input: {
  seats: readonly RefundableSeatSnapshot[];
  requestedBookingSeatIds: readonly string[];
  capacity: RefundCapacity;
}): RefundCalculationResult {
  const requested = [...new Set(input.requestedBookingSeatIds)];
  if (requested.length === 0) return { outcome: "REJECTED", reason: "NO_SEATS_SELECTED" };

  const byId = new Map(input.seats.map((seat) => [seat.bookingSeatId, seat]));
  const selected: RefundableSeatSnapshot[] = [];
  for (const id of requested) {
    const seat = byId.get(id);
    if (!seat) return { outcome: "REJECTED", reason: "SEAT_NOT_IN_BOOKING" };
    if (seat.alreadyRefunded) return { outcome: "REJECTED", reason: "SEAT_ALREADY_REFUNDED" };
    selected.push(seat);
  }

  if (selected.some((seat) => seat.currency !== input.capacity.currency)) {
    return { outcome: "REJECTED", reason: "MIXED_CURRENCY" };
  }

  const amountMinor = selected.reduce((sum, seat) => sum + seat.priceMinor, 0);
  if (amountMinor <= 0) return { outcome: "REJECTED", reason: "AMOUNT_NOT_POSITIVE" };
  if (amountMinor > remainingRefundableMinor(input.capacity)) {
    return { outcome: "REJECTED", reason: "EXCEEDS_REMAINING" };
  }

  return {
    outcome: "ELIGIBLE",
    scope: "SELECTED_SEATS",
    amountMinor,
    currency: input.capacity.currency,
    bookingSeatIds: selected.map((seat) => seat.bookingSeatId),
  };
}

/**
 * A refund for an amount an operator approved under policy rather than one
 * derived from seats. It is still bounded by remaining capacity and still
 * refuses anything that is not a positive integer of minor units.
 */
export function calculateFixedRefund(input: {
  approvedAmountMinor: number;
  capacity: RefundCapacity;
}): RefundCalculationResult {
  const { approvedAmountMinor } = input;
  if (!Number.isSafeInteger(approvedAmountMinor) || approvedAmountMinor <= 0) {
    return { outcome: "REJECTED", reason: "AMOUNT_NOT_POSITIVE" };
  }
  if (approvedAmountMinor > remainingRefundableMinor(input.capacity)) {
    return { outcome: "REJECTED", reason: "EXCEEDS_REMAINING" };
  }
  return {
    outcome: "ELIGIBLE",
    scope: "FIXED_AMOUNT",
    amountMinor: approvedAmountMinor,
    currency: input.capacity.currency,
    bookingSeatIds: [],
  };
}

/**
 * True when succeeded refunds have returned the entire captured amount, which
 * is the only condition under which a booking becomes fully refunded.
 */
export function isFullyRefunded(capacity: Pick<RefundCapacity, "capturedMinor" | "refundedMinor">) {
  return capacity.refundedMinor >= capacity.capturedMinor;
}
