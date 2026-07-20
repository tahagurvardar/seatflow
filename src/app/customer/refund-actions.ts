"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ROUTES } from "@/config/site";
import { requireAuth } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";
import {
  RefundAuthorizationError,
  RefundEligibilityError,
  requestRefund,
} from "@/server/refunds/refund-service";

/**
 * Customer refund request.
 *
 * The client supplies only three things: which booking, which scope, and which
 * of its own seats. Amount, currency, provider, payment ancestry, ownership,
 * and eligibility are all derived on the server from the authenticated session
 * and PostgreSQL. A form field naming an amount, a currency, a user, or an
 * organization is not read at all — there is nowhere for it to go.
 */

const refundRequestSchema = z
  .object({
    bookingReference: z.string().min(24).max(191).regex(/^[A-Za-z0-9_-]+$/),
    scope: z.enum(["FULL_BOOKING", "SELECTED_SEATS"]),
    /**
     * Stable per rendered form. A double-click submits the same nonce, which
     * derives the same idempotency key and therefore returns the refund that
     * already exists rather than reserving a second amount.
     */
    submissionNonce: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
    bookingSeatIds: z.array(z.string().min(1).max(191)).max(64).optional(),
  })
  .strict();

export interface RefundActionState {
  status: "idle" | "success" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
}

/** Safe, human-readable copy for each refusal. No internal detail leaks. */
const ELIGIBILITY_MESSAGES: Record<string, string> = {
  PAYMENT_NOT_CAPTURED: "This booking has no completed payment to refund.",
  ALREADY_FULLY_REFUNDED: "This booking has already been fully refunded.",
  BOOKING_NOT_CONFIRMED: "This booking is not in a refundable state.",
  ORDER_NOT_FULFILLED: "This booking is not in a refundable state.",
  NOTHING_REFUNDABLE: "There is nothing left to refund on this booking.",
  UNDER_FINANCIAL_REVIEW:
    "This booking is under financial review. Our team will be in touch before anything changes.",
  SEAT_ALREADY_REFUNDED: "One of those seats is already covered by a refund.",
  SEAT_NOT_IN_BOOKING: "Those seats do not belong to this booking.",
  NO_SEATS_SELECTED: "Select at least one seat to refund.",
  EXCEEDS_REMAINING: "That refund is larger than the amount still refundable.",
  MIXED_CURRENCY: "This booking cannot be refunded automatically. Please contact support.",
  AMOUNT_NOT_POSITIVE: "There is nothing left to refund on this booking.",
};

export async function requestRefundAction(
  _previous: RefundActionState,
  formData: FormData,
): Promise<RefundActionState> {
  const parsed = refundRequestSchema.safeParse({
    bookingReference: formData.get("bookingReference"),
    scope: formData.get("scope"),
    submissionNonce: formData.get("submissionNonce"),
    bookingSeatIds: formData.getAll("bookingSeatIds").filter(Boolean),
  });
  if (!parsed.success) {
    return { status: "error", message: "That refund request was not valid." };
  }

  // Identity comes from the session, never from the form.
  const auth = await requireAuth(ROUTES.customerBooking(parsed.data.bookingReference));

  try {
    const result = await requestRefund(
      getDatabase(),
      { userId: auth.user.id, role: "CUSTOMER" },
      {
        bookingReference: parsed.data.bookingReference,
        scope: parsed.data.scope,
        bookingSeatIds: parsed.data.bookingSeatIds,
        reasonCode: "CUSTOMER_REQUEST",
        idempotencyKey: `customer:${parsed.data.scope}:${parsed.data.submissionNonce}`,
      },
    );

    revalidatePath(ROUTES.customerBooking(parsed.data.bookingReference));
    return {
      status: "success",
      // Deliberately does not say the money has been returned. It has not: a
      // refund is settled only by a verified provider event.
      message: result.replayed
        ? "That refund request was already received. We are still processing it."
        : "Refund requested. We will confirm here once your provider settles it.",
    };
  } catch (error) {
    if (error instanceof RefundAuthorizationError) {
      // A booking that is not theirs reads exactly like one that does not
      // exist, so the reference space cannot be probed through this form.
      return { status: "error", message: "That booking was not found." };
    }
    if (error instanceof RefundEligibilityError) {
      return {
        status: "error",
        message:
          ELIGIBILITY_MESSAGES[error.safeCode] ??
          "This booking cannot be refunded right now.",
      };
    }
    return {
      status: "error",
      message: "We could not process that request. Please try again shortly.",
    };
  }
}
