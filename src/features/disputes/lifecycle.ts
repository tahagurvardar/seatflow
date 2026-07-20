import type { DisputeOutcome, DisputeStatus, TicketStatus } from "@/generated/prisma/enums";

/**
 * Dispute lifecycle decisions.
 *
 * A dispute only ever exists because a cryptographically verified provider
 * webhook said so. Nothing in this module can be reached from a browser action,
 * an organizer, or Redis; it decides what a verified provider event means once
 * the signature has already been checked.
 */

export const DISPUTE_TERMINAL_STATUSES = [
  "WON",
  "LOST",
  "CLOSED",
] as const satisfies readonly DisputeStatus[];

export const DISPUTE_OPEN_STATUSES = [
  "OPEN",
  "NEEDS_RESPONSE",
  "UNDER_REVIEW",
] as const satisfies readonly DisputeStatus[];

export function isTerminalDisputeStatus(status: DisputeStatus) {
  return (DISPUTE_TERMINAL_STATUSES as readonly DisputeStatus[]).includes(status);
}

export function isOpenDisputeStatus(status: DisputeStatus) {
  return (DISPUTE_OPEN_STATUSES as readonly DisputeStatus[]).includes(status);
}

export function outcomeForTerminalStatus(status: DisputeStatus): DisputeOutcome | null {
  if (status === "WON") return "WON";
  if (status === "LOST") return "LOST";
  return null;
}

export type DisputeTransitionDecision =
  | { outcome: "APPLY"; status: DisputeStatus; disputeOutcome: DisputeOutcome | null }
  | { outcome: "IGNORE"; reason: string }
  | { outcome: "REVIEW"; safeCode: string };

/**
 * Decide what a verified provider dispute event does to local state.
 *
 * The first terminal outcome wins permanently. A provider that reports WON and
 * then LOST for one dispute has told us two incompatible things about the same
 * money, so the dispute is frozen for a human rather than silently flipped.
 */
export function decideDisputeTransition(input: {
  current: DisputeStatus;
  incoming: DisputeStatus;
}): DisputeTransitionDecision {
  const { current, incoming } = input;

  if (current === "REQUIRES_REVIEW") {
    return { outcome: "IGNORE", reason: "ALREADY_UNDER_REVIEW" };
  }
  if (current === incoming) {
    return { outcome: "IGNORE", reason: "DUPLICATE_STATUS" };
  }
  if (incoming === "REQUIRES_REVIEW") {
    return { outcome: "REVIEW", safeCode: "PROVIDER_REQUESTED_REVIEW" };
  }
  if (isTerminalDisputeStatus(current)) {
    if (isTerminalDisputeStatus(incoming)) {
      return { outcome: "REVIEW", safeCode: "CONTRADICTORY_DISPUTE_OUTCOME" };
    }
    // A dispute does not reopen on a late non-terminal event.
    return { outcome: "IGNORE", reason: "STALE_EVENT_AFTER_TERMINAL" };
  }
  return {
    outcome: "APPLY",
    status: incoming,
    disputeOutcome: outcomeForTerminalStatus(incoming),
  };
}

/**
 * Ticket consequences of a dispute.
 *
 * The default is deliberately conservative: an open dispute changes nothing
 * about admission, because a customer who is disputing a charge may still turn
 * up and a provider may still rule in the platform's favour. Only a lost
 * dispute revokes tickets, and a ticket already used stays used — history is
 * never rewritten to make the books look tidier.
 */
export type DisputeTicketPolicy = "PRESERVE_ON_OPEN" | "REVOKE_ON_OPEN";

export type TicketConsequence =
  | { action: "NONE"; reason: string }
  | { action: "REVOKE"; safeReason: string }
  | { action: "PRESERVE_USED"; reason: string };

export function decideDisputeTicketConsequence(input: {
  disputeStatus: DisputeStatus;
  ticketStatus: TicketStatus;
  policy?: DisputeTicketPolicy;
}): TicketConsequence {
  const policy = input.policy ?? "PRESERVE_ON_OPEN";

  if (input.ticketStatus === "USED") {
    return { action: "PRESERVE_USED", reason: "USED_TICKETS_REMAIN_HISTORICALLY_USED" };
  }
  if (input.ticketStatus === "REVOKED") {
    return { action: "NONE", reason: "ALREADY_REVOKED" };
  }

  if (input.disputeStatus === "LOST") {
    return { action: "REVOKE", safeReason: "DISPUTE_LOST" };
  }
  if (isOpenDisputeStatus(input.disputeStatus) && policy === "REVOKE_ON_OPEN") {
    return { action: "REVOKE", safeReason: "DISPUTE_OPENED" };
  }
  return { action: "NONE", reason: "DISPUTE_DOES_NOT_AFFECT_ADMISSION" };
}

/**
 * Detect the double-compensation risk: a customer who has already been refunded
 * and then also wins a chargeback would be paid twice for the same seat. This
 * never auto-resolves; it raises the order for financial review.
 */
export function detectRefundDisputeOverlap(input: {
  succeededRefundMinor: number;
  disputedAmountMinor: number;
  capturedMinor: number;
}) {
  const combined = input.succeededRefundMinor + input.disputedAmountMinor;
  return {
    overlapping: input.succeededRefundMinor > 0 && input.disputedAmountMinor > 0,
    exceedsCaptured: combined > input.capturedMinor,
    combinedMinor: combined,
  };
}
