import type { PaymentAttemptStatus } from "@/generated/prisma/enums";

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

