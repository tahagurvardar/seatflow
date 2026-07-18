import type {
  CheckoutOrderStatus,
  PaymentAttemptStatus,
} from "@/generated/prisma/enums";

export type CheckoutDisplayState =
  | "PENDING"
  | "FAILED"
  | "CONFIRMED"
  | "REQUIRES_REVIEW"
  | "EXPIRED"
  | "CANCELLED";

export function toCheckoutDisplayState(input: {
  orderStatus: CheckoutOrderStatus;
  paymentStatus: PaymentAttemptStatus | null;
  bookingConfirmed: boolean;
  checkoutExpiresAt: Date;
  now?: Date;
}): CheckoutDisplayState {
  const now = input.now ?? new Date();
  if (input.bookingConfirmed && input.orderStatus === "FULFILLED") return "CONFIRMED";
  if (["PAID_UNFULFILLED", "REQUIRES_REVIEW", "PAID"].includes(input.orderStatus)) {
    return "REQUIRES_REVIEW";
  }
  if (input.orderStatus === "FAILED" || input.paymentStatus === "FAILED") return "FAILED";
  if (input.orderStatus === "CANCELLED" || input.paymentStatus === "CANCELLED") {
    return "CANCELLED";
  }
  if (
    input.orderStatus === "EXPIRED" ||
    (["PENDING", "PAYMENT_PENDING"].includes(input.orderStatus) &&
      now >= input.checkoutExpiresAt)
  ) {
    return "EXPIRED";
  }
  return "PENDING";
}

