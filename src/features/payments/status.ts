import type {
  DisputeStatus,
  PaymentAttemptStatus,
  RefundStatus,
} from "@/generated/prisma/enums";

const normalizedStatuses: Record<string, PaymentAttemptStatus> = {
  created: "CREATED",
  pending: "PENDING",
  processing: "PENDING",
  requires_action: "PENDING",
  succeeded: "SUCCEEDED",
  success: "SUCCEEDED",
  paid: "SUCCEEDED",
  failed: "FAILED",
  failure: "FAILED",
  requires_payment_method: "FAILED",
  canceled: "CANCELLED",
  cancelled: "CANCELLED",
};

export function normalizeProviderPaymentStatus(value: string): PaymentAttemptStatus {
  const normalized = normalizedStatuses[value.trim().toLowerCase()];
  if (!normalized) throw new Error("Unsupported provider payment status.");
  return normalized;
}

export function isTerminalPaymentStatus(status: PaymentAttemptStatus) {
  return ["SUCCEEDED", "FAILED", "CANCELLED", "REQUIRES_REVIEW"].includes(status);
}

export function isContradictoryTerminalStatus(
  current: PaymentAttemptStatus,
  incoming: PaymentAttemptStatus,
) {
  return isTerminalPaymentStatus(current) && current !== incoming;
}

/**
 * Provider refund vocabularies differ, so they are mapped onto ours explicitly.
 * An unrecognised value throws rather than defaulting: silently treating an
 * unknown status as PROCESSING would let a provider word we have never seen
 * decide what happens to a customer's money.
 */
const normalizedRefundStatuses: Record<string, RefundStatus> = {
  pending: "PROCESSING",
  processing: "PROCESSING",
  requires_action: "PROCESSING",
  succeeded: "SUCCEEDED",
  success: "SUCCEEDED",
  failed: "FAILED",
  failure: "FAILED",
  canceled: "CANCELLED",
  cancelled: "CANCELLED",
  requires_review: "REQUIRES_REVIEW",
};

export function normalizeProviderRefundStatus(value: string): RefundStatus {
  const normalized = normalizedRefundStatuses[value.trim().toLowerCase()];
  if (!normalized) throw new Error("Unsupported provider refund status.");
  return normalized;
}

const normalizedDisputeStatuses: Record<string, DisputeStatus> = {
  open: "OPEN",
  warning_needs_response: "NEEDS_RESPONSE",
  needs_response: "NEEDS_RESPONSE",
  warning_under_review: "UNDER_REVIEW",
  under_review: "UNDER_REVIEW",
  won: "WON",
  warning_closed: "CLOSED",
  lost: "LOST",
  closed: "CLOSED",
};

export function normalizeProviderDisputeStatus(value: string): DisputeStatus {
  const normalized = normalizedDisputeStatuses[value.trim().toLowerCase()];
  if (!normalized) throw new Error("Unsupported provider dispute status.");
  return normalized;
}

