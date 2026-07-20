import type { RefundStatus } from "@/generated/prisma/enums";

/**
 * Refund lifecycle decisions.
 *
 * Pure and free of Prisma, Redis, and `process.env`, so every ordering and
 * contradiction rule below can be unit tested exhaustively. The database
 * enforces the same rules again as a second line of defence.
 */

export const REFUND_TERMINAL_STATUSES = [
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const satisfies readonly RefundStatus[];

/** States in which money is still reserved against the captured payment. */
export const REFUND_IN_FLIGHT_STATUSES = [
  "REQUESTED",
  "SUBMITTING",
  "PROCESSING",
  "REQUIRES_REVIEW",
] as const satisfies readonly RefundStatus[];

export function isTerminalRefundStatus(status: RefundStatus) {
  return (REFUND_TERMINAL_STATUSES as readonly RefundStatus[]).includes(status);
}

export function isInFlightRefundStatus(status: RefundStatus) {
  return (REFUND_IN_FLIGHT_STATUSES as readonly RefundStatus[]).includes(status);
}

/**
 * Two terminal outcomes that cannot both be true of the same refund. A provider
 * that reports success and then failure for one refund is not a state machine
 * we may follow: the money either moved or it did not, so the refund is frozen
 * for a human instead.
 */
export function isContradictoryRefundOutcome(
  current: RefundStatus,
  incoming: RefundStatus,
) {
  if (!isTerminalRefundStatus(current) || !isTerminalRefundStatus(incoming)) return false;
  return current !== incoming;
}

export type RefundTransitionDecision =
  | { outcome: "APPLY"; status: RefundStatus }
  | { outcome: "IGNORE"; reason: string }
  | { outcome: "REVIEW"; safeCode: string };

/**
 * Decide what a verified provider refund event should do to local state.
 *
 * Ordering is deliberate:
 *  - A refund already under review stays under review. Nothing automatic may
 *    release it.
 *  - A repeat of the outcome we already recorded is a duplicate, not a change.
 *  - A contradictory terminal outcome escalates to review and never overwrites
 *    the first result.
 *  - An event that would move a settled refund backwards (a late PROCESSING
 *    after SUCCEEDED, say) is ignored, which is what makes out-of-order
 *    provider delivery safe.
 */
export function decideRefundTransition(input: {
  current: RefundStatus;
  incoming: RefundStatus;
}): RefundTransitionDecision {
  const { current, incoming } = input;

  if (current === "REQUIRES_REVIEW") {
    return { outcome: "IGNORE", reason: "ALREADY_UNDER_REVIEW" };
  }
  if (current === incoming) {
    return { outcome: "IGNORE", reason: "DUPLICATE_STATUS" };
  }
  if (isContradictoryRefundOutcome(current, incoming)) {
    return { outcome: "REVIEW", safeCode: "CONTRADICTORY_REFUND_OUTCOME" };
  }
  if (isTerminalRefundStatus(current)) {
    // A non-terminal event arriving after a terminal one is stale delivery.
    return { outcome: "IGNORE", reason: "STALE_EVENT_AFTER_TERMINAL" };
  }
  if (incoming === "REQUIRES_REVIEW") {
    return { outcome: "REVIEW", safeCode: "PROVIDER_REQUESTED_REVIEW" };
  }
  if (incoming === "REQUESTED") {
    // A provider never moves a refund back to locally-requested.
    return { outcome: "IGNORE", reason: "NON_ADVANCING_STATUS" };
  }
  return { outcome: "APPLY", status: incoming };
}

/**
 * Provider events can arrive out of order. An event older than the one already
 * applied is not evidence of anything newer, so it is dropped rather than
 * replayed over fresher state.
 */
export function isStaleProviderEvent(input: {
  lastAppliedAt: Date | null;
  incomingOccurredAt: Date | null;
}) {
  if (!input.lastAppliedAt || !input.incomingOccurredAt) return false;
  return input.incomingOccurredAt.getTime() < input.lastAppliedAt.getTime();
}
