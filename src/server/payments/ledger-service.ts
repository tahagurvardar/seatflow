import { randomBytes } from "node:crypto";

import { buildLedgerEntryDraft } from "@/features/ledger/entries";
import type { Prisma } from "@/generated/prisma/client";
import type {
  Currency,
  FinancialOutboxEventType,
  LedgerEntryType,
  PaymentProviderName,
} from "@/generated/prisma/enums";

/**
 * Financial ledger and outbox writes.
 *
 * Both always run inside the caller's transaction, so a ledger entry and the
 * state change it describes commit together or not at all. There is no path
 * here that updates or deletes an existing entry: the database rejects that
 * outright, and this module never attempts it.
 */

function generatePublicReference() {
  return randomBytes(24).toString("base64url");
}

export interface AppendLedgerEntryInput {
  entryType: LedgerEntryType;
  amountMinor: number;
  currency: Currency;
  orderId: string;
  paymentAttemptId: string;
  bookingId?: string | null;
  refundId?: string | null;
  disputeId?: string | null;
  provider: PaymentProviderName;
  /** Stable cause: a provider event id, refund id, or dispute id. */
  causeKey: string;
  providerReference?: string | null;
  effectiveAt: Date;
  correlationId?: string | null;
  safeMetadata?: Prisma.InputJsonValue;
}

/**
 * Append one ledger entry, or do nothing if its deterministic key already
 * exists.
 *
 * The `skipDuplicates` path is what makes duplicate webhook delivery a no-op at
 * the storage layer: two concurrent deliveries of the same provider event race
 * to insert the same idempotency key, and exactly one row survives regardless
 * of which wins.
 */
export async function appendLedgerEntry(
  transaction: Prisma.TransactionClient,
  input: AppendLedgerEntryInput,
): Promise<{ written: boolean; idempotencyKey: string }> {
  const draft = buildLedgerEntryDraft({
    entryType: input.entryType,
    amountMinor: input.amountMinor,
    causeKey: input.causeKey,
    providerReference: input.providerReference ?? null,
  });
  if (draft.outcome === "REJECTED") {
    throw new Error(`LEDGER_ENTRY_REJECTED_${draft.reason}`);
  }

  const created = await transaction.financialLedgerEntry.createMany({
    data: [
      {
        publicReference: generatePublicReference(),
        entryType: draft.draft.entryType,
        direction: draft.draft.direction,
        amountMinor: draft.draft.amountMinor,
        currency: input.currency,
        orderId: input.orderId,
        paymentAttemptId: input.paymentAttemptId,
        bookingId: input.bookingId ?? null,
        refundId: input.refundId ?? null,
        disputeId: input.disputeId ?? null,
        provider: input.provider,
        providerReferenceHash: draft.draft.providerReferenceHash,
        effectiveAt: input.effectiveAt,
        idempotencyKey: draft.draft.idempotencyKey,
        correlationId: input.correlationId ?? null,
        metadataVersion: 1,
        safeMetadata: input.safeMetadata,
      },
    ],
    skipDuplicates: true,
  });

  return { written: created.count === 1, idempotencyKey: draft.draft.idempotencyKey };
}

export interface EnqueueFinancialEventInput {
  eventType: FinancialOutboxEventType;
  deduplicationKey: string;
  aggregateId?: string | null;
  orderId?: string | null;
  refundId?: string | null;
  disputeId?: string | null;
  bookingId?: string | null;
  /**
   * Must contain no customer email, provider secret, payment method, raw
   * provider event, webhook signature, ticket credential or its hash, or
   * connection string. Payloads are built by callers from bounded fields only.
   */
  payload: Prisma.InputJsonValue;
  now: Date;
}

export async function enqueueFinancialEvent(
  transaction: Prisma.TransactionClient,
  input: EnqueueFinancialEventInput,
) {
  const created = await transaction.financialOutbox.createMany({
    data: [
      {
        eventType: input.eventType,
        aggregateId: input.aggregateId ?? null,
        orderId: input.orderId ?? null,
        refundId: input.refundId ?? null,
        disputeId: input.disputeId ?? null,
        bookingId: input.bookingId ?? null,
        payload: input.payload,
        deduplicationKey: input.deduplicationKey,
        status: "PENDING",
        availableAt: input.now,
        createdAt: input.now,
        updatedAt: input.now,
      },
    ],
    skipDuplicates: true,
  });
  return created.count === 1;
}

/**
 * Every ledger entry for one payment, oldest first. Used by reconciliation to
 * compare the append-only record against the stored aggregates.
 */
export async function readLedgerForPayment(
  transaction: Prisma.TransactionClient,
  paymentAttemptId: string,
) {
  return transaction.financialLedgerEntry.findMany({
    where: { paymentAttemptId },
    orderBy: [{ effectiveAt: "asc" }, { createdAt: "asc" }],
    select: {
      entryType: true,
      direction: true,
      amountMinor: true,
      currency: true,
      effectiveAt: true,
      refundId: true,
      disputeId: true,
    },
  });
}
