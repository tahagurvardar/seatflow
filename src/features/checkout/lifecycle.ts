import type {
  CheckoutOrderStatus,
  EventSessionStatus,
  EventStatus,
  SeatHoldStatus,
} from "@/generated/prisma/enums";

export const TERMINAL_CHECKOUT_STATUSES = [
  "FULFILLED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
  "PAID_UNFULFILLED",
  "REQUIRES_REVIEW",
] as const satisfies readonly CheckoutOrderStatus[];

export function isTerminalCheckoutStatus(status: CheckoutOrderStatus) {
  return (TERMINAL_CHECKOUT_STATUSES as readonly CheckoutOrderStatus[]).includes(status);
}

export function isCheckoutExpired(input: {
  status: CheckoutOrderStatus;
  checkoutExpiresAt: Date;
  now?: Date;
}) {
  return (
    ["PENDING", "PAYMENT_PENDING"].includes(input.status) &&
    (input.now ?? new Date()) >= input.checkoutExpiresAt
  );
}

export type PaidFulfillmentDecision =
  | { outcome: "FULFILL" }
  | { outcome: "IDEMPOTENT" }
  | {
      outcome: "REVIEW";
      code:
        | "HOLD_RELEASED"
        | "HOLD_EXPIRED"
        | "HOLD_NOT_ACTIVE"
        | "SESSION_CANCELLED"
        | "SESSION_UNAVAILABLE"
        | "ORDER_TERMINAL_CONFLICT";
    };

export function decidePaidFulfillment(input: {
  orderStatus: CheckoutOrderStatus;
  holdStatus: SeatHoldStatus;
  holdExpiresAt: Date;
  eventStatus: EventStatus;
  sessionStatus: EventSessionStatus;
  now?: Date;
}): PaidFulfillmentDecision {
  const now = input.now ?? new Date();
  if (input.orderStatus === "FULFILLED") return { outcome: "IDEMPOTENT" };
  if (
    ["FAILED", "CANCELLED", "EXPIRED", "PAID_UNFULFILLED", "REQUIRES_REVIEW"].includes(
      input.orderStatus,
    )
  ) {
    return { outcome: "REVIEW", code: "ORDER_TERMINAL_CONFLICT" };
  }
  if (input.holdStatus === "RELEASED") {
    return { outcome: "REVIEW", code: "HOLD_RELEASED" };
  }
  if (input.holdStatus === "EXPIRED" || now >= input.holdExpiresAt) {
    return { outcome: "REVIEW", code: "HOLD_EXPIRED" };
  }
  if (input.holdStatus !== "ACTIVE") {
    return { outcome: "REVIEW", code: "HOLD_NOT_ACTIVE" };
  }
  if (input.sessionStatus === "CANCELLED") {
    return { outcome: "REVIEW", code: "SESSION_CANCELLED" };
  }
  if (
    input.eventStatus !== "PUBLISHED" ||
    !["SCHEDULED", "ON_SALE", "SALES_PAUSED"].includes(input.sessionStatus)
  ) {
    return { outcome: "REVIEW", code: "SESSION_UNAVAILABLE" };
  }
  return { outcome: "FULFILL" };
}

