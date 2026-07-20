import type {
  BookingStatus,
  CheckoutOrderStatus,
  EventSessionStatus,
  PaymentAttemptStatus,
  RefundInitiator,
  TicketStatus,
} from "@/generated/prisma/enums";

/**
 * Who may ask for a refund, and of what.
 *
 * Authorization is decided from server-loaded state only. Nothing in this
 * module accepts a user id, organization id, amount, currency, or status that
 * came from a client: callers pass what the database says, and this decides.
 */

export type RefundEligibilityReason =
  | "BOOKING_NOT_CONFIRMED"
  | "PAYMENT_NOT_CAPTURED"
  | "ORDER_NOT_FULFILLED"
  | "NOTHING_REFUNDABLE"
  | "ALREADY_FULLY_REFUNDED"
  | "SESSION_ALREADY_COMPLETED"
  | "UNDER_FINANCIAL_REVIEW";

export type RefundEligibility =
  | { eligible: true }
  | { eligible: false; reason: RefundEligibilityReason };

/**
 * Whether this booking can be the subject of a new refund request at all.
 *
 * A paid-but-unfulfilled order is deliberately still refundable: the customer's
 * money was taken, so refusing them a refund because fulfillment failed would
 * punish them for the platform's problem. It stays operationally visible.
 */
export function evaluateRefundEligibility(input: {
  bookingStatus: BookingStatus;
  orderStatus: CheckoutOrderStatus;
  paymentStatus: PaymentAttemptStatus;
  sessionStatus: EventSessionStatus;
  remainingRefundableMinor: number;
  underFinancialReview: boolean;
}): RefundEligibility {
  if (input.paymentStatus !== "SUCCEEDED") {
    return { eligible: false, reason: "PAYMENT_NOT_CAPTURED" };
  }
  if (input.bookingStatus === "REFUNDED") {
    return { eligible: false, reason: "ALREADY_FULLY_REFUNDED" };
  }
  if (input.bookingStatus !== "CONFIRMED") {
    return { eligible: false, reason: "BOOKING_NOT_CONFIRMED" };
  }
  if (!["FULFILLED", "PAID", "PAID_UNFULFILLED"].includes(input.orderStatus)) {
    return { eligible: false, reason: "ORDER_NOT_FULFILLED" };
  }
  // A refund already in flight, or a dispute, means a human decides next.
  if (input.underFinancialReview) {
    return { eligible: false, reason: "UNDER_FINANCIAL_REVIEW" };
  }
  if (input.remainingRefundableMinor <= 0) {
    return { eligible: false, reason: "NOTHING_REFUNDABLE" };
  }
  return { eligible: true };
}

export type RefundActorRole = "CUSTOMER" | "ORGANIZER" | "PLATFORM_ADMIN";

export type RefundAuthorizationDecision =
  | { allowed: true; initiator: RefundInitiator; requiresApproval: boolean }
  | { allowed: false; reason: RefundAuthorizationDenial };

export type RefundAuthorizationDenial =
  | "NOT_BOOKING_OWNER"
  | "NOT_IN_ORGANIZATION"
  | "ORGANIZER_CANNOT_INITIATE_PROVIDER_REFUND"
  | "UNKNOWN_ROLE";

/**
 * Decide whether an actor may create a refund, and whether what they create is
 * a request awaiting approval or an authorized refund.
 *
 * A customer never gets direct refund authority. Their submission is a request:
 * it reserves the amount and is visible to operators, but only an approval path
 * turns it into money leaving the platform. An organizer may review within
 * their own organization but may not create provider refunds, because that
 * would let one tenant move platform money without platform oversight.
 */
export function authorizeRefundRequest(input: {
  role: RefundActorRole;
  actorUserId: string;
  bookingOwnerUserId: string;
  bookingOrganizationId: string;
  actorOrganizationIds: readonly string[];
  isPlatformAdmin: boolean;
}): RefundAuthorizationDecision {
  if (input.role === "CUSTOMER") {
    if (input.actorUserId !== input.bookingOwnerUserId) {
      return { allowed: false, reason: "NOT_BOOKING_OWNER" };
    }
    return { allowed: true, initiator: "CUSTOMER", requiresApproval: true };
  }

  if (input.role === "ORGANIZER") {
    if (!input.actorOrganizationIds.includes(input.bookingOrganizationId)) {
      return { allowed: false, reason: "NOT_IN_ORGANIZATION" };
    }
    return { allowed: false, reason: "ORGANIZER_CANNOT_INITIATE_PROVIDER_REFUND" };
  }

  if (input.role === "PLATFORM_ADMIN") {
    if (!input.isPlatformAdmin) return { allowed: false, reason: "UNKNOWN_ROLE" };
    return { allowed: true, initiator: "PLATFORM_ADMIN", requiresApproval: false };
  }

  return { allowed: false, reason: "UNKNOWN_ROLE" };
}

/**
 * Whether an organizer may read a refund or dispute. Organization scoping is
 * absolute: there is no cross-organization read path.
 */
export function canReadOrganizationFinancials(input: {
  isPlatformAdmin: boolean;
  actorOrganizationIds: readonly string[];
  resourceOrganizationId: string;
}) {
  if (input.isPlatformAdmin) return true;
  return input.actorOrganizationIds.includes(input.resourceOrganizationId);
}

/**
 * Ticket consequences of a refund.
 *
 * Refunding money revokes the admission it paid for, but never erases history:
 * a ticket already used stays USED and remains visible. Inventory is untouched
 * — the Phase 5A trigger makes BOOKED terminal, so a refunded seat does not
 * silently return to sale.
 */
export function decideRefundTicketConsequence(input: {
  ticketStatus: TicketStatus;
  seatWasRefunded: boolean;
}): { action: "REVOKE"; safeReason: string } | { action: "NONE"; reason: string } {
  if (!input.seatWasRefunded) {
    return { action: "NONE", reason: "SEAT_NOT_REFUNDED" };
  }
  if (input.ticketStatus === "USED") {
    return { action: "NONE", reason: "USED_TICKETS_REMAIN_HISTORICALLY_USED" };
  }
  if (input.ticketStatus === "REVOKED") {
    return { action: "NONE", reason: "ALREADY_REVOKED" };
  }
  return { action: "REVOKE", safeReason: "REFUNDED" };
}
