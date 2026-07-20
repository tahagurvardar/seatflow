import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { runInTransaction } from "@/server/database/run-in-transaction";
import { appendLedgerEntry, enqueueFinancialEvent } from "@/server/payments/ledger-service";
import type { PaymentProvider } from "@/server/payments/payment-provider";

/**
 * Refund submission to the external provider.
 *
 * The whole point of this file is the ordering, because getting it wrong is how
 * a platform pays a customer twice:
 *
 *  1. The refund already exists locally with a deterministic provider
 *     idempotency key, committed before anything leaves the process.
 *  2. Claim it by moving REQUESTED -> SUBMITTING in its own short transaction.
 *     The claim is what stops two workers submitting the same refund.
 *  3. Call the provider with **no PostgreSQL row lock held**. An external HTTP
 *     call inside a transaction would pin a lock for the duration of someone
 *     else's network, which is how refund throughput becomes a database outage.
 *  4. Record the outcome in a second short transaction.
 *
 * Because step 1 commits the key before step 3, every failure mode converges:
 * a timeout, a crash between 3 and 4, or a retry after a restart all re-submit
 * with the identical key, and the provider returns the refund it already
 * created instead of making another one.
 *
 * Nothing here settles a refund. A provider saying "succeeded" during
 * submission is a receipt, not authority; only a verified webhook moves a
 * refund to SUCCEEDED.
 */

export interface RefundSubmissionResult {
  refundId: string;
  outcome: "SUBMITTED" | "ALREADY_SUBMITTED" | "TIMEOUT_PENDING_RECONCILIATION" | "FAILED";
  safeCode?: string;
}

interface ClaimedRefund {
  id: string;
  orderId: string;
  paymentAttemptId: string;
  bookingId: string;
  requestedAmountMinor: number;
  currency: string;
  providerIdempotencyKey: string;
  providerIntentId: string;
  reasonCode: string;
  attemptNumber: number;
}

function safeCodeFrom(error: unknown) {
  const raw =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : "REFUND_PROVIDER_FAILURE";
  return raw.replace(/[^A-Za-z0-9_:-]/g, "_").toUpperCase().slice(0, 80) || "REFUND_PROVIDER_FAILURE";
}

/** A provider failure that leaves the external outcome genuinely unknown. */
function isAmbiguousFailure(error: unknown) {
  const code = safeCodeFrom(error);
  return /TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|SOCKET|ABORT|STRIPE_CONNECTION|STRIPE_API/.test(
    code,
  );
}

/**
 * Claim one refund for submission.
 *
 * `SELECT ... FOR UPDATE SKIP LOCKED` on a single row plus the REQUESTED status
 * guard means two concurrent workers cannot both claim the same refund, and a
 * worker never waits behind one that is already submitting.
 */
async function claimRefundForSubmission(
  database: PrismaClient,
  refundId: string,
  now: Date,
): Promise<ClaimedRefund | null> {
  return runInTransaction(database, async (transaction) => {
    const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "Refund"
      WHERE "id" = ${refundId} AND "status" = 'REQUESTED'
      FOR UPDATE SKIP LOCKED
    `);
    if (!rows[0]) return null;

    const refund = await transaction.refund.findUniqueOrThrow({
      where: { id: refundId },
      include: {
        paymentAttempt: { select: { providerIntentId: true } },
        attempts: { select: { attemptNumber: true }, orderBy: { attemptNumber: "desc" }, take: 1 },
      },
    });
    if (!refund.paymentAttempt.providerIntentId) return null;

    const attemptNumber = (refund.attempts[0]?.attemptNumber ?? 0) + 1;

    await transaction.refund.update({
      where: { id: refund.id },
      data: {
        status: "SUBMITTING",
        submittedAt: refund.submittedAt ?? now,
        version: { increment: 1 },
        updatedAt: now,
      },
    });
    await transaction.refundAttempt.create({
      data: {
        refundId: refund.id,
        attemptNumber,
        provider: refund.provider,
        status: "STARTED",
        startedAt: now,
        // Distinct per attempt so retries are individually auditable, while the
        // provider-facing key on the refund stays stable.
        idempotencyKey: `${refund.providerIdempotencyKey}:a${attemptNumber}`,
        createdAt: now,
      },
    });

    return {
      id: refund.id,
      orderId: refund.orderId,
      paymentAttemptId: refund.paymentAttemptId,
      bookingId: refund.bookingId,
      requestedAmountMinor: refund.requestedAmountMinor,
      currency: refund.currency,
      providerIdempotencyKey: refund.providerIdempotencyKey,
      providerIntentId: refund.paymentAttempt.providerIntentId,
      reasonCode: refund.reasonCode,
      attemptNumber,
    };
  });
}

async function completeAttempt(
  database: PrismaClient,
  input: {
    refundId: string;
    attemptNumber: number;
    status: "SUCCEEDED" | "FAILED" | "TIMEOUT";
    providerRequestReference?: string | null;
    safeFailureCode?: string | null;
    now: Date;
  },
) {
  await database.refundAttempt.updateMany({
    where: { refundId: input.refundId, attemptNumber: input.attemptNumber, status: "STARTED" },
    data: {
      status: input.status,
      completedAt: input.now,
      providerRequestReference: input.providerRequestReference ?? null,
      safeFailureCode: input.safeFailureCode ?? null,
    },
  });
}

/**
 * Submit one claimed refund to the provider and record what came back.
 *
 * The provider call sits deliberately between two transactions, holding no
 * lock.
 */
export async function submitRefund(
  database: PrismaClient,
  provider: PaymentProvider,
  refundId: string,
  options: { now?: Date; correlationId?: string } = {},
): Promise<RefundSubmissionResult> {
  const now = options.now ?? new Date();

  const claimed = await claimRefundForSubmission(database, refundId, now);
  if (!claimed) return { refundId, outcome: "ALREADY_SUBMITTED" };

  let providerRefund;
  try {
    // No database transaction is open here, by design.
    providerRefund = await provider.createRefund({
      providerIntentId: claimed.providerIntentId,
      amountMinor: claimed.requestedAmountMinor,
      currency: claimed.currency as never,
      idempotencyKey: claimed.providerIdempotencyKey,
      safeReasonCode: claimed.reasonCode,
    });
  } catch (error) {
    const safeCode = safeCodeFrom(error);
    const ambiguous = isAmbiguousFailure(error);
    await completeAttempt(database, {
      refundId: claimed.id,
      attemptNumber: claimed.attemptNumber,
      status: ambiguous ? "TIMEOUT" : "FAILED",
      safeFailureCode: safeCode,
      now,
    });

    if (ambiguous) {
      // The provider may well have accepted the idempotency key before the
      // connection broke, so the refund must NOT be failed here. It stays
      // in-flight for reconciliation, which is what prevents a second external
      // refund being created for the same money.
      await runInTransaction(database, async (transaction) => {
        await transaction.refund.updateMany({
          where: { id: claimed.id, status: "SUBMITTING" },
          data: { status: "PROCESSING", version: { increment: 1 }, updatedAt: now },
        });
        await enqueueFinancialEvent(transaction, {
          eventType: "FINANCIAL_RECONCILIATION_REQUIRED",
          deduplicationKey: `refund-ambiguous:${claimed.id}:a${claimed.attemptNumber}`,
          aggregateId: claimed.id,
          orderId: claimed.orderId,
          refundId: claimed.id,
          bookingId: claimed.bookingId,
          payload: { reason: "PROVIDER_OUTCOME_UNKNOWN", attemptNumber: claimed.attemptNumber },
          now,
        });
      });
      return {
        refundId: claimed.id,
        outcome: "TIMEOUT_PENDING_RECONCILIATION",
        safeCode,
      };
    }

    // A clean rejection means no external refund exists, so the reservation is
    // released and the seats become refundable again.
    await failRefund(database, {
      refundId: claimed.id,
      safeCode,
      now,
      correlationId: options.correlationId,
    });
    return { refundId: claimed.id, outcome: "FAILED", safeCode };
  }

  await completeAttempt(database, {
    refundId: claimed.id,
    attemptNumber: claimed.attemptNumber,
    status: "SUCCEEDED",
    providerRequestReference: providerRefund.providerRefundId,
    now,
  });

  await runInTransaction(database, async (transaction) => {
    // Attach the external identity once and move to PROCESSING. The provider's
    // own status is deliberately not trusted to settle anything: only a
    // verified webhook may set succeededAt.
    await transaction.refund.updateMany({
      where: { id: claimed.id, status: { in: ["SUBMITTING", "PROCESSING"] } },
      data: {
        status: "PROCESSING",
        providerRefundId: providerRefund.providerRefundId,
        version: { increment: 1 },
        updatedAt: now,
      },
    });
    await appendLedgerEntry(transaction, {
      entryType: "REFUND_PROCESSING",
      amountMinor: claimed.requestedAmountMinor,
      currency: claimed.currency as never,
      orderId: claimed.orderId,
      paymentAttemptId: claimed.paymentAttemptId,
      bookingId: claimed.bookingId,
      refundId: claimed.id,
      provider: provider.name,
      causeKey: `${claimed.id}:submitted`,
      providerReference: providerRefund.providerRefundId,
      effectiveAt: now,
      correlationId: options.correlationId ?? null,
    });
    await enqueueFinancialEvent(transaction, {
      eventType: "REFUND_SUBMITTED",
      deduplicationKey: `refund-submitted:${claimed.id}`,
      aggregateId: claimed.id,
      orderId: claimed.orderId,
      refundId: claimed.id,
      bookingId: claimed.bookingId,
      payload: { amountMinor: claimed.requestedAmountMinor, currency: claimed.currency },
      now,
    });
  });

  return { refundId: claimed.id, outcome: "SUBMITTED" };
}

/**
 * Mark a refund permanently failed. Used only when the provider clearly
 * rejected the request, never when the outcome is unknown.
 */
export async function failRefund(
  database: PrismaClient,
  input: { refundId: string; safeCode: string; now: Date; correlationId?: string },
) {
  await runInTransaction(database, async (transaction) => {
    const refund = await transaction.refund.findUniqueOrThrow({
      where: { id: input.refundId },
      select: {
        id: true,
        status: true,
        orderId: true,
        paymentAttemptId: true,
        bookingId: true,
        requestedAmountMinor: true,
        currency: true,
        provider: true,
      },
    });
    if (["SUCCEEDED", "FAILED", "CANCELLED", "REQUIRES_REVIEW"].includes(refund.status)) return;

    await transaction.refund.update({
      where: { id: refund.id },
      data: {
        status: "FAILED",
        failedAt: input.now,
        safeFailureCode: input.safeCode,
        version: { increment: 1 },
        updatedAt: input.now,
      },
    });
    // A failed refund writes no success entry of any kind. This entry records
    // that the attempt ended, and releases the reservation.
    await appendLedgerEntry(transaction, {
      entryType: "REFUND_FAILED",
      amountMinor: refund.requestedAmountMinor,
      currency: refund.currency,
      orderId: refund.orderId,
      paymentAttemptId: refund.paymentAttemptId,
      bookingId: refund.bookingId,
      refundId: refund.id,
      provider: refund.provider,
      causeKey: `${refund.id}:failed`,
      effectiveAt: input.now,
      correlationId: input.correlationId ?? null,
      safeMetadata: { safeCode: input.safeCode },
    });
    await enqueueFinancialEvent(transaction, {
      eventType: "REFUND_FAILED",
      deduplicationKey: `refund-failed:${refund.id}`,
      aggregateId: refund.id,
      orderId: refund.orderId,
      refundId: refund.id,
      bookingId: refund.bookingId,
      payload: { safeCode: input.safeCode },
      now: input.now,
    });
  });
}

/**
 * Submit every refund currently awaiting the provider. Each is claimed and
 * submitted independently, so one provider failure cannot stall the batch.
 */
export async function submitPendingRefunds(
  database: PrismaClient,
  provider: PaymentProvider,
  options: { batchSize?: number; now?: Date } = {},
) {
  const now = options.now ?? new Date();
  const pending = await database.refund.findMany({
    where: { status: "REQUESTED", provider: provider.name },
    orderBy: { requestedAt: "asc" },
    take: options.batchSize ?? 50,
    select: { id: true },
  });

  const result = { claimed: 0, submitted: 0, failed: 0, ambiguous: 0 };
  for (const refund of pending) {
    const outcome = await submitRefund(database, provider, refund.id, { now });
    if (outcome.outcome === "ALREADY_SUBMITTED") continue;
    result.claimed += 1;
    if (outcome.outcome === "SUBMITTED") result.submitted += 1;
    if (outcome.outcome === "FAILED") result.failed += 1;
    if (outcome.outcome === "TIMEOUT_PENDING_RECONCILIATION") result.ambiguous += 1;
  }
  return result;
}
