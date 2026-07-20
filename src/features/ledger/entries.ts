import { createHash } from "node:crypto";

import type { LedgerDirection, LedgerEntryType } from "@/generated/prisma/enums";

/**
 * Financial ledger entry construction.
 *
 * The ledger is append-only and is the audit record operators read, so two
 * rules are enforced here as well as in the database:
 *
 *  - Direction is fixed per entry type. A refund can never be written as a
 *    credit that silently cancels out the original capture.
 *  - Provider identifiers are hashed, never stored raw, so reading the ledger
 *    never exposes a provider reference.
 */

const DIRECTION_BY_ENTRY_TYPE: Record<LedgerEntryType, LedgerDirection> = {
  PAYMENT_AUTHORIZED: "CREDIT",
  PAYMENT_CAPTURED: "CREDIT",
  PAYMENT_FAILED: "DEBIT",
  REFUND_REQUESTED: "DEBIT",
  REFUND_PROCESSING: "DEBIT",
  REFUND_SUCCEEDED: "DEBIT",
  REFUND_FAILED: "CREDIT",
  REFUND_CANCELLED: "CREDIT",
  DISPUTE_OPENED: "DEBIT",
  DISPUTE_UPDATED: "DEBIT",
  DISPUTE_WON: "CREDIT",
  DISPUTE_LOST: "DEBIT",
  CHARGEBACK_RECORDED: "DEBIT",
  MANUAL_ADJUSTMENT_REQUESTED: "DEBIT",
};

export function directionForEntryType(entryType: LedgerEntryType): LedgerDirection {
  return DIRECTION_BY_ENTRY_TYPE[entryType];
}

/**
 * Entry types that record money actually moving, as opposed to a request or a
 * status note. Only these participate in balance reconciliation.
 */
const SETTLING_ENTRY_TYPES = new Set<LedgerEntryType>([
  "PAYMENT_CAPTURED",
  "REFUND_SUCCEEDED",
  "DISPUTE_LOST",
  "CHARGEBACK_RECORDED",
]);

export function isSettlingEntryType(entryType: LedgerEntryType) {
  return SETTLING_ENTRY_TYPES.has(entryType);
}

/** Hash a provider reference so the ledger never carries the raw identifier. */
export function hashProviderReference(reference: string) {
  return createHash("sha256").update(`seatflow-ledger-reference:${reference}`).digest("hex");
}

/**
 * Deterministic idempotency key.
 *
 * Built from the entry type plus the thing that caused it, so replaying the
 * same verified provider event or the same domain action can only ever produce
 * one ledger row. The unique index on this key is what makes duplicate webhook
 * delivery a no-op at the storage layer rather than a matter of timing.
 */
export function buildLedgerIdempotencyKey(input: {
  entryType: LedgerEntryType;
  /** Stable cause: a provider event id, a refund id, or a dispute id. */
  causeKey: string;
}) {
  const normalized = input.causeKey.replace(/[^A-Za-z0-9_:.-]/g, "-").slice(0, 120);
  return `${input.entryType}:${normalized}`;
}

export interface LedgerEntryDraft {
  entryType: LedgerEntryType;
  direction: LedgerDirection;
  amountMinor: number;
  idempotencyKey: string;
  providerReferenceHash: string | null;
}

export type LedgerDraftResult =
  | { outcome: "OK"; draft: LedgerEntryDraft }
  | { outcome: "REJECTED"; reason: "AMOUNT_INVALID" | "CAUSE_MISSING" };

export function buildLedgerEntryDraft(input: {
  entryType: LedgerEntryType;
  amountMinor: number;
  causeKey: string;
  providerReference?: string | null;
}): LedgerDraftResult {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0) {
    return { outcome: "REJECTED", reason: "AMOUNT_INVALID" };
  }
  if (!input.causeKey.trim()) {
    return { outcome: "REJECTED", reason: "CAUSE_MISSING" };
  }
  return {
    outcome: "OK",
    draft: {
      entryType: input.entryType,
      direction: directionForEntryType(input.entryType),
      amountMinor: input.amountMinor,
      idempotencyKey: buildLedgerIdempotencyKey({
        entryType: input.entryType,
        causeKey: input.causeKey,
      }),
      providerReferenceHash: input.providerReference
        ? hashProviderReference(input.providerReference)
        : null,
    },
  };
}

export interface LedgerBalanceInput {
  entryType: LedgerEntryType;
  direction: LedgerDirection;
  amountMinor: number;
}

/**
 * Net settled position for one payment: what was captured minus what has been
 * returned through refunds and lost disputes. Non-settling entries are ignored
 * so a pending refund request never looks like money that already moved.
 */
export function calculateSettledBalanceMinor(entries: readonly LedgerBalanceInput[]) {
  return entries.reduce((balance, entry) => {
    if (!isSettlingEntryType(entry.entryType)) return balance;
    return entry.direction === "CREDIT"
      ? balance + entry.amountMinor
      : balance - entry.amountMinor;
  }, 0);
}

/**
 * Detect a payment whose ledger disagrees with its stored aggregates. Any
 * non-zero divergence is an operational alarm, never something to auto-correct:
 * the ledger is append-only, so the fix is always investigation.
 */
export function detectLedgerDivergence(input: {
  capturedMinor: number;
  refundedMinor: number;
  entries: readonly LedgerBalanceInput[];
}) {
  const expected = input.capturedMinor - input.refundedMinor;
  const actual = calculateSettledBalanceMinor(input.entries);
  return { diverged: expected !== actual, expectedMinor: expected, actualMinor: actual };
}
