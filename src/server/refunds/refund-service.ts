import { createHmac, randomBytes } from "node:crypto";

import {
  calculateFullBookingRefund,
  calculateSeatRefund,
  remainingRefundableMinor,
  type RefundableSeatSnapshot,
  type RefundCalculationResult,
} from "@/features/refunds/calculation";
import {
  authorizeRefundRequest,
  evaluateRefundEligibility,
  type RefundActorRole,
} from "@/features/refunds/authorization";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { RefundReasonCode } from "@/generated/prisma/enums";
import { runInTransaction } from "@/server/database/run-in-transaction";
import {
  appendLedgerEntry,
  enqueueFinancialEvent,
} from "@/server/payments/ledger-service";

/**
 * Refund request creation.
 *
 * The shape of this module follows one rule: nothing a client sends decides
 * money. Callers pass a booking reference, a scope, and at most a set of seat
 * identifiers. Amount, currency, provider, order, payment attempt, and status
 * are all read from PostgreSQL under a row lock.
 *
 * Over-refunding is prevented by the database. Creating a refund fires a
 * trigger that recomputes the reserved and refunded totals on the parent
 * PaymentAttempt row; that write takes a row lock, which serializes every
 * concurrent refund for one payment, and a CHECK constraint rejects any total
 * exceeding the captured amount. Concurrency safety therefore does not depend
 * on callers remembering to lock anything.
 */

export class RefundAuthorizationError extends Error {
  constructor(readonly safeCode: string) {
    super("This refund request is not permitted.");
    this.name = "RefundAuthorizationError";
  }
}

export class RefundEligibilityError extends Error {
  constructor(readonly safeCode: string) {
    super("This booking cannot be refunded right now.");
    this.name = "RefundEligibilityError";
  }
}

function generatePublicReference() {
  return randomBytes(24).toString("base64url");
}

/**
 * The provider idempotency key is derived, not random, and is committed before
 * any provider call. A crash between committing the refund and calling the
 * provider therefore replays with the identical key, so the provider returns
 * the existing refund instead of creating a second one.
 */
function deriveProviderIdempotencyKey(input: {
  paymentAttemptId: string;
  requestIdempotencyKey: string;
}) {
  const digest = createHmac("sha256", "seatflow-refund-idempotency")
    .update(`${input.paymentAttemptId}:${input.requestIdempotencyKey}`)
    .digest("base64url")
    .slice(0, 40);
  return `refund_${digest}`;
}

export interface RefundRequestInput {
  bookingReference: string;
  scope: "FULL_BOOKING" | "SELECTED_SEATS";
  /** Only meaningful for SELECTED_SEATS. Identifiers only, never prices. */
  bookingSeatIds?: readonly string[];
  reasonCode: RefundReasonCode;
  /** Caller-stable key; replaying it returns the existing refund. */
  idempotencyKey: string;
}

export interface RefundActor {
  userId: string;
  role: RefundActorRole;
}

export interface CreateRefundResult {
  refundId: string;
  publicReference: string;
  amountMinor: number;
  currency: string;
  status: string;
  replayed: boolean;
}

interface LockedAttemptRow {
  id: string;
  amountMinor: number;
  refundedMinor: number;
  inFlightRefundMinor: number;
}

/**
 * Create a refund request for one booking.
 *
 * Sequence is deliberate: lock the payment attempt first so the capacity read
 * and the insert cannot interleave with a concurrent request, then price from
 * immutable snapshots, then write the refund, its seats, its ledger entry, and
 * its outbox event in one transaction.
 */
export async function requestRefund(
  database: PrismaClient,
  actor: RefundActor,
  input: RefundRequestInput,
  options: { now?: Date; correlationId?: string } = {},
): Promise<CreateRefundResult> {
  const now = options.now ?? new Date();

  return runInTransaction(
    database,
    async (transaction) => {
      const booking = await transaction.booking.findUnique({
        where: { publicReference: input.bookingReference },
        include: {
          order: { select: { id: true, status: true, financialReviewState: true } },
          session: { select: { status: true } },
          seats: {
            select: { id: true, priceMinor: true, currency: true },
            orderBy: { id: "asc" },
          },
        },
      });
      // A booking the actor may not see is reported exactly like one that does
      // not exist, so the reference space cannot be probed.
      if (!booking) throw new RefundAuthorizationError("REFUND_TARGET_NOT_FOUND");

      const membershipOrganizationIds = await transaction.membership
        .findMany({ where: { userId: actor.userId }, select: { organizationId: true } })
        .then((rows) => rows.map((row) => row.organizationId));
      const actorRecord = await transaction.user.findUniqueOrThrow({
        where: { id: actor.userId },
        select: { platformRole: true },
      });

      const authorization = authorizeRefundRequest({
        role: actor.role,
        actorUserId: actor.userId,
        bookingOwnerUserId: booking.userId,
        bookingOrganizationId: booking.organizationId,
        actorOrganizationIds: membershipOrganizationIds,
        isPlatformAdmin: actorRecord.platformRole === "ADMIN",
      });
      if (!authorization.allowed) {
        throw new RefundAuthorizationError(
          authorization.reason === "NOT_BOOKING_OWNER"
            ? "REFUND_TARGET_NOT_FOUND"
            : authorization.reason,
        );
      }

      const attempt = await transaction.paymentAttempt.findFirst({
        where: { orderId: booking.orderId, status: "SUCCEEDED" },
        select: { id: true, provider: true, currency: true, status: true },
      });
      if (!attempt) throw new RefundEligibilityError("PAYMENT_NOT_CAPTURED");

      // Lock the payment attempt before reading capacity. Everything that
      // changes the refunded totals must pass through this row.
      const locked = await transaction.$queryRaw<LockedAttemptRow[]>(Prisma.sql`
        SELECT "id", "amountMinor", "refundedMinor", "inFlightRefundMinor"
        FROM "PaymentAttempt" WHERE "id" = ${attempt.id} FOR UPDATE
      `);
      const capacityRow = locked[0];
      if (!capacityRow) throw new RefundEligibilityError("PAYMENT_NOT_CAPTURED");

      const providerIdempotencyKey = deriveProviderIdempotencyKey({
        paymentAttemptId: attempt.id,
        requestIdempotencyKey: input.idempotencyKey,
      });
      // A replayed request returns the refund it already created rather than
      // reserving a second amount against the same payment.
      const existing = await transaction.refund.findUnique({
        where: { providerIdempotencyKey },
        select: {
          id: true,
          publicReference: true,
          requestedAmountMinor: true,
          currency: true,
          status: true,
        },
      });
      if (existing) {
        return {
          refundId: existing.id,
          publicReference: existing.publicReference,
          amountMinor: existing.requestedAmountMinor,
          currency: existing.currency,
          status: existing.status,
          replayed: true,
        };
      }

      const capacity = {
        capturedMinor: capacityRow.amountMinor,
        refundedMinor: capacityRow.refundedMinor,
        inFlightMinor: capacityRow.inFlightRefundMinor,
        currency: attempt.currency,
      };

      const eligibility = evaluateRefundEligibility({
        bookingStatus: booking.status,
        orderStatus: booking.order.status,
        paymentStatus: attempt.status,
        sessionStatus: booking.session.status,
        remainingRefundableMinor: remainingRefundableMinor(capacity),
        underFinancialReview: booking.order.financialReviewState !== "NONE",
      });
      if (!eligibility.eligible) throw new RefundEligibilityError(eligibility.reason);

      // Seats already covered by a live or completed refund are excluded here
      // and rejected again by a database trigger.
      const refundedSeatIds = await transaction.refundSeat
        .findMany({
          where: {
            bookingSeat: { bookingId: booking.id },
            refund: {
              OR: [
                { succeededAt: { not: null } },
                { status: { in: ["REQUESTED", "SUBMITTING", "PROCESSING", "REQUIRES_REVIEW"] } },
              ],
            },
          },
          select: { bookingSeatId: true },
        })
        .then((rows) => new Set(rows.map((row) => row.bookingSeatId)));

      const seatSnapshots: RefundableSeatSnapshot[] = booking.seats.map((seat) => ({
        bookingSeatId: seat.id,
        priceMinor: seat.priceMinor,
        currency: seat.currency,
        alreadyRefunded: refundedSeatIds.has(seat.id),
      }));

      const calculation: RefundCalculationResult =
        input.scope === "SELECTED_SEATS"
          ? calculateSeatRefund({
              seats: seatSnapshots,
              requestedBookingSeatIds: input.bookingSeatIds ?? [],
              capacity,
            })
          : calculateFullBookingRefund({ seats: seatSnapshots, capacity });
      if (calculation.outcome === "REJECTED") {
        throw new RefundEligibilityError(calculation.reason);
      }

      const refund = await transaction.refund.create({
        data: {
          publicReference: generatePublicReference(),
          orderId: booking.orderId,
          paymentAttemptId: attempt.id,
          bookingId: booking.id,
          requestedByUserId: actor.userId,
          approvedByUserId: authorization.requiresApproval ? null : actor.userId,
          initiator: authorization.initiator,
          status: "REQUESTED",
          reasonCode: input.reasonCode,
          scope: calculation.scope,
          requestedAmountMinor: calculation.amountMinor,
          currency: calculation.currency,
          provider: attempt.provider,
          providerIdempotencyKey,
          requestedAt: now,
          createdAt: now,
          updatedAt: now,
        },
        select: { id: true, publicReference: true },
      });

      if (calculation.bookingSeatIds.length > 0) {
        const byId = new Map(seatSnapshots.map((seat) => [seat.bookingSeatId, seat]));
        await transaction.refundSeat.createMany({
          data: calculation.bookingSeatIds.map((bookingSeatId) => ({
            refundId: refund.id,
            bookingSeatId,
            priceMinor: byId.get(bookingSeatId)!.priceMinor,
            currency: byId.get(bookingSeatId)!.currency,
            createdAt: now,
          })),
        });
      }

      await appendLedgerEntry(transaction, {
        entryType: "REFUND_REQUESTED",
        amountMinor: calculation.amountMinor,
        currency: calculation.currency,
        orderId: booking.orderId,
        paymentAttemptId: attempt.id,
        bookingId: booking.id,
        refundId: refund.id,
        provider: attempt.provider,
        causeKey: refund.id,
        effectiveAt: now,
        correlationId: options.correlationId ?? null,
        safeMetadata: { scope: calculation.scope, initiator: authorization.initiator },
      });

      await enqueueFinancialEvent(transaction, {
        eventType: "REFUND_REQUESTED",
        deduplicationKey: `refund-requested:${refund.id}`,
        aggregateId: refund.id,
        orderId: booking.orderId,
        refundId: refund.id,
        bookingId: booking.id,
        // Reference and amount only: no email, provider id, or credential.
        payload: {
          refundReference: refund.publicReference,
          amountMinor: calculation.amountMinor,
          currency: calculation.currency,
          reasonCode: input.reasonCode,
        },
        now,
      });

      return {
        refundId: refund.id,
        publicReference: refund.publicReference,
        amountMinor: calculation.amountMinor,
        currency: calculation.currency,
        status: "REQUESTED",
        replayed: false,
      };
    },
    { timeout: 20_000 },
  );
}

/**
 * What a customer may be shown about refundability, computed on the server.
 * Provider identifiers are never included.
 */
export async function summarizeRefundability(
  database: PrismaClient,
  input: { bookingReference: string; actorUserId: string },
) {
  const booking = await database.booking.findUnique({
    where: { publicReference: input.bookingReference },
    include: {
      order: { select: { status: true, financialReviewState: true } },
      session: { select: { status: true } },
      seats: {
        select: { id: true, priceMinor: true, currency: true, seatLabel: true, rowLabel: true, sectionName: true },
        orderBy: { id: "asc" },
      },
    },
  });
  if (!booking || booking.userId !== input.actorUserId) return null;

  const attempt = await database.paymentAttempt.findFirst({
    where: { orderId: booking.orderId, status: "SUCCEEDED" },
    select: { id: true, amountMinor: true, refundedMinor: true, inFlightRefundMinor: true, currency: true, status: true },
  });
  if (!attempt) {
    return {
      bookingReference: booking.publicReference,
      currency: booking.currency,
      paidMinor: booking.totalMinor,
      refundedMinor: 0,
      inFlightMinor: 0,
      maximumRefundableMinor: 0,
      eligible: false as const,
      reason: "PAYMENT_NOT_CAPTURED",
      seats: [],
    };
  }

  const capacity = {
    capturedMinor: attempt.amountMinor,
    refundedMinor: attempt.refundedMinor,
    inFlightMinor: attempt.inFlightRefundMinor,
    currency: attempt.currency,
  };
  const maximumRefundableMinor = remainingRefundableMinor(capacity);
  const eligibility = evaluateRefundEligibility({
    bookingStatus: booking.status,
    orderStatus: booking.order.status,
    paymentStatus: attempt.status,
    sessionStatus: booking.session.status,
    remainingRefundableMinor: maximumRefundableMinor,
    underFinancialReview: booking.order.financialReviewState !== "NONE",
  });

  const refundedSeatIds = await database.refundSeat
    .findMany({
      where: {
        bookingSeat: { bookingId: booking.id },
        refund: {
          OR: [
            { succeededAt: { not: null } },
            { status: { in: ["REQUESTED", "SUBMITTING", "PROCESSING", "REQUIRES_REVIEW"] } },
          ],
        },
      },
      select: { bookingSeatId: true },
    })
    .then((rows) => new Set(rows.map((row) => row.bookingSeatId)));

  return {
    bookingReference: booking.publicReference,
    currency: attempt.currency,
    paidMinor: attempt.amountMinor,
    refundedMinor: attempt.refundedMinor,
    inFlightMinor: attempt.inFlightRefundMinor,
    maximumRefundableMinor,
    eligible: eligibility.eligible,
    reason: eligibility.eligible ? null : eligibility.reason,
    seats: booking.seats.map((seat) => ({
      bookingSeatId: seat.id,
      label: `${seat.sectionName} · ${seat.rowLabel}${seat.seatLabel}`,
      priceMinor: seat.priceMinor,
      currency: seat.currency,
      alreadyRefunded: refundedSeatIds.has(seat.id),
    })),
  };
}

/** Customer-visible refund history. Honest statuses, no provider metadata. */
export async function listRefundsForBooking(
  database: PrismaClient,
  input: { bookingReference: string; actorUserId: string },
) {
  const booking = await database.booking.findUnique({
    where: { publicReference: input.bookingReference },
    select: { id: true, userId: true },
  });
  if (!booking || booking.userId !== input.actorUserId) return null;

  const refunds = await database.refund.findMany({
    where: { bookingId: booking.id },
    orderBy: { requestedAt: "desc" },
    select: {
      publicReference: true,
      status: true,
      reasonCode: true,
      scope: true,
      requestedAmountMinor: true,
      currency: true,
      requestedAt: true,
      succeededAt: true,
      failedAt: true,
      cancelledAt: true,
      reviewRequiredAt: true,
    },
  });
  return refunds;
}

export { deriveProviderIdempotencyKey };
