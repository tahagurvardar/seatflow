import { randomBytes } from "node:crypto";

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type {
  CheckoutOrderStatus,
} from "@/generated/prisma/enums";
import { decidePaidFulfillment } from "@/features/checkout/lifecycle";
import {
  isContradictoryTerminalStatus,
  isTerminalPaymentStatus,
} from "@/features/payments/status";
import {
  assertPaymentWebhookPayloadSize,
  hashPaymentWebhookPayload,
} from "@/features/payments/webhook";
import { runInTransaction } from "@/server/database/run-in-transaction";
import { releaseExpiredHoldsForSession } from "@/server/holds/expiry-service";
import { enqueueInventoryEvent } from "@/server/inventory-events/outbox-service";
import {
  PaymentWebhookSignatureError,
  PaymentWebhookValidationError,
} from "@/server/payments/errors";
import type {
  NormalizedDisputeWebhookEvent,
  NormalizedPaymentWebhookEvent,
  NormalizedRefundWebhookEvent,
  PaymentProvider,
} from "@/server/payments/payment-provider";
import { applyDisputeFromVerifiedEvent } from "@/server/disputes/dispute-service";
import { settleRefundFromVerifiedEvent } from "@/server/refunds/settlement-service";
import {
  attemptImmediateTicketIssuance,
  enqueueTicketIssuance,
} from "@/server/tickets/issuance-service";

function generateBookingReference() {
  return randomBytes(24).toString("base64url");
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String((error as { code?: unknown }).code) === "P2002"
  );
}

interface LockedInventoryRow {
  id: string;
  sessionId: string;
  seatId: string;
  sectionId: string;
  priceTierId: string;
  priceMinor: number;
  currency: string;
  state: string;
  currentHoldId: string | null;
  holdExpiresAt: Date | null;
}

export type WebhookProcessingResult =
  | { outcome: "BOOKED"; bookingReference: string; duplicate: boolean }
  | { outcome: "FAILED"; duplicate: boolean }
  | { outcome: "PENDING"; duplicate: boolean }
  | { outcome: "REQUIRES_REVIEW"; safeCode: string; duplicate: boolean }
  // Phase 5C2A categories. Refund and dispute events share this table so one
  // unique (provider, providerEventId) gives exact-once replay protection
  // across every financial event type the provider can deliver.
  | { outcome: "REFUND_SETTLED"; status: string; duplicate: boolean }
  | { outcome: "REFUND_IGNORED"; reason: string; duplicate: boolean }
  | { outcome: "DISPUTE_RECORDED"; status: string; duplicate: boolean }
  | { outcome: "DISPUTE_IGNORED"; reason: string; duplicate: boolean }
  | { outcome: "UNSUPPORTED_EVENT"; duplicate: boolean };

interface ProcessOptions {
  now?: Date;
  maximumPayloadBytes?: number;
  ticketCredentialSecret?: string;
  /** Integration-test hook used only to prove that all fulfillment writes roll back. */
  beforeCommit?: () => Promise<void> | void;
}

async function loadExistingResult(
  database: PrismaClient,
  webhookId: string,
  duplicate: boolean,
): Promise<WebhookProcessingResult> {
  const webhook = await database.paymentWebhookEvent.findUniqueOrThrow({
    where: { id: webhookId },
    include: {
      paymentAttempt: {
        include: { order: { include: { booking: true } } },
      },
    },
  });
  const booking = webhook.paymentAttempt?.order.booking;
  if (booking) {
    return { outcome: "BOOKED", bookingReference: booking.publicReference, duplicate };
  }
  if (webhook.processingStatus === "REQUIRES_REVIEW") {
    return {
      outcome: "REQUIRES_REVIEW",
      safeCode: webhook.safeProcessingError ?? "PAYMENT_REQUIRES_REVIEW",
      duplicate,
    };
  }
  if (webhook.normalizedStatus === "FAILED" || webhook.normalizedStatus === "CANCELLED") {
    return { outcome: "FAILED", duplicate };
  }
  return { outcome: "PENDING", duplicate };
}

async function storeVerifiedWebhook(
  database: PrismaClient,
  provider: PaymentProvider,
  event: NormalizedPaymentWebhookEvent,
  payloadHash: string,
  now: Date,
) {
  const attempt = await database.paymentAttempt.findFirst({
    where: {
      provider: provider.name,
      providerIntentId: event.providerIntentId,
    },
    select: { id: true },
  });
  try {
    const created = await database.paymentWebhookEvent.create({
      data: {
        provider: provider.name,
        providerEventId: event.providerEventId,
        eventType: event.eventType,
        providerIntentId: event.providerIntentId,
        paymentAttemptId: attempt?.id,
        normalizedStatus: event.status,
        amountMinor: event.amountMinor,
        currency: event.currency,
        signatureStatus: "VERIFIED",
        processingStatus: "RECEIVED",
        receivedAt: now,
        providerOccurredAt: event.occurredAt,
        payloadHash,
      },
      select: { id: true },
    });
    return { webhookId: created.id, duplicate: false };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await database.paymentWebhookEvent.findUniqueOrThrow({
      where: {
        provider_providerEventId: {
          provider: provider.name,
          providerEventId: event.providerEventId,
        },
      },
      select: { id: true },
    });
    return { webhookId: existing.id, duplicate: true };
  }
}

function snapshotsMatch(input: {
  orderItems: Array<{
    inventoryId: string;
    seatId: string;
    sectionId: string;
    priceTierId: string;
    priceMinor: number;
    currency: string;
  }>;
  holdItems: Array<{ inventoryId: string; priceMinor: number; currency: string }>;
  inventory: LockedInventoryRow[];
  holdId: string;
  sessionId: string;
  holdExpiresAt: Date;
}) {
  if (
    input.orderItems.length === 0 ||
    input.orderItems.length !== input.holdItems.length ||
    input.orderItems.length !== input.inventory.length
  ) {
    return false;
  }
  const holdItems = new Map(input.holdItems.map((item) => [item.inventoryId, item]));
  const inventory = new Map(input.inventory.map((item) => [item.id, item]));
  return input.orderItems.every((item) => {
    const holdItem = holdItems.get(item.inventoryId);
    const inventoryItem = inventory.get(item.inventoryId);
    return Boolean(
      holdItem &&
        inventoryItem &&
        holdItem.priceMinor === item.priceMinor &&
        holdItem.currency === item.currency &&
        inventoryItem.sessionId === input.sessionId &&
        inventoryItem.seatId === item.seatId &&
        inventoryItem.sectionId === item.sectionId &&
        inventoryItem.priceTierId === item.priceTierId &&
        inventoryItem.priceMinor === item.priceMinor &&
        inventoryItem.currency === item.currency &&
        inventoryItem.state === "HELD" &&
        inventoryItem.currentHoldId === input.holdId &&
        inventoryItem.holdExpiresAt?.getTime() === input.holdExpiresAt.getTime(),
    );
  });
}

async function markWebhookReview(
  transaction: Prisma.TransactionClient,
  input: {
    webhookId: string;
    attemptId?: string;
    orderId?: string;
    sessionId?: string;
    safeCode: string;
    now: Date;
    paid: boolean;
    preserveOrder?: boolean;
  },
) {
  if (input.attemptId && input.paid) {
    await transaction.paymentAttempt.update({
      where: { id: input.attemptId },
      data: {
        status: "SUCCEEDED",
        succeededAt: input.now,
        lastProviderStatus: "succeeded",
        updatedAt: input.now,
      },
    });
  }
  if (input.orderId && !input.preserveOrder) {
    await transaction.checkoutOrder.update({
      where: { id: input.orderId },
      data: {
        status: input.paid ? "PAID_UNFULFILLED" : "REQUIRES_REVIEW",
        paidAt: input.paid ? input.now : undefined,
        safeFailureCode: input.safeCode,
        version: { increment: 1 },
        updatedAt: input.now,
      },
    });
  }
  if (input.sessionId) {
    if (input.paid) {
      await enqueueInventoryEvent(transaction, {
        eventType: "PAYMENT_SUCCEEDED",
        sessionId: input.sessionId,
        aggregateId: input.orderId,
        deduplicationKey: `payment-succeeded-review:${input.webhookId}`,
        now: input.now,
      });
    }
    await enqueueInventoryEvent(transaction, {
      eventType: "PAYMENT_REQUIRES_REVIEW",
      sessionId: input.sessionId,
      aggregateId: input.orderId,
      deduplicationKey: `payment-review:${input.webhookId}`,
      now: input.now,
    });
  }
  await transaction.paymentWebhookEvent.update({
    where: { id: input.webhookId },
    data: {
      processingStatus: "REQUIRES_REVIEW",
      processedAt: input.now,
      attemptCount: { increment: 1 },
      safeProcessingError: input.safeCode,
    },
  });
}

/**
 * Process one already-verified normalized webhook under deterministic row locks.
 * The transaction is the only path that can create a booking or mark inventory
 * BOOKED. Unique constraints and row locks make concurrent duplicates exact once.
 */
export async function processVerifiedWebhookRecord(
  database: PrismaClient,
  webhookId: string,
  options: ProcessOptions = {},
): Promise<WebhookProcessingResult> {
  const now = options.now ?? new Date();
  let newlyConfirmedBookingId: string | null = null;
  try {
    await runInTransaction(
      database,
      async (transaction) => {
        await transaction.$queryRaw(Prisma.sql`
          SELECT "id" FROM "PaymentWebhookEvent" WHERE "id" = ${webhookId} FOR UPDATE
        `);
        const webhook = await transaction.paymentWebhookEvent.findUniqueOrThrow({
          where: { id: webhookId },
        });
        if (["PROCESSED", "REQUIRES_REVIEW"].includes(webhook.processingStatus)) return;
        if (webhook.signatureStatus !== "VERIFIED") {
          throw new PaymentWebhookSignatureError();
        }
        // Phase 5C2A shares one verified-webhook table across payment, refund,
        // and dispute events so a single unique (provider, providerEventId)
        // gives exact-once replay protection for all of them. This function
        // still advances payment-intent state only; refund and dispute
        // envelopes are routed to their own services.
        if (webhook.eventCategory !== "PAYMENT" || webhook.normalizedStatus === null) {
          throw new PaymentWebhookValidationError();
        }
        const normalizedStatus = webhook.normalizedStatus;
        if (!webhook.paymentAttemptId) {
          await markWebhookReview(transaction, {
            webhookId,
            safeCode: "UNKNOWN_PAYMENT_INTENT",
            now,
            paid: normalizedStatus === "SUCCEEDED",
          });
          return;
        }

        await transaction.$queryRaw(Prisma.sql`
          SELECT "id" FROM "PaymentAttempt"
          WHERE "id" = ${webhook.paymentAttemptId} FOR UPDATE
        `);
        const attempt = await transaction.paymentAttempt.findUniqueOrThrow({
          where: { id: webhook.paymentAttemptId },
        });

        await transaction.$queryRaw(Prisma.sql`
          SELECT "id" FROM "CheckoutOrder" WHERE "id" = ${attempt.orderId} FOR UPDATE
        `);
        const order = await transaction.checkoutOrder.findUniqueOrThrow({
          where: { id: attempt.orderId },
          include: { items: { orderBy: { inventoryId: "asc" } }, booking: true },
        });

        await transaction.$queryRaw(Prisma.sql`
          SELECT "id" FROM "SeatHold" WHERE "id" = ${order.sourceHoldId} FOR UPDATE
        `);
        const hold = await transaction.seatHold.findUniqueOrThrow({
          where: { id: order.sourceHoldId },
          include: { items: { orderBy: { inventoryId: "asc" } } },
        });

        const inventoryIds = order.items.map((item) => item.inventoryId);
        const inventory = inventoryIds.length
          ? await transaction.$queryRaw<LockedInventoryRow[]>(Prisma.sql`
              SELECT "id", "sessionId", "seatId", "sectionId", "priceTierId",
                     "priceMinor", "currency", "state", "currentHoldId", "holdExpiresAt"
              FROM "SessionSeatInventory"
              WHERE "id" IN (${Prisma.join(inventoryIds)})
              ORDER BY "seatId" ASC
              FOR UPDATE
            `)
          : [];
        const eventSession = await transaction.eventSession.findUniqueOrThrow({
          where: { id: order.sessionId },
          include: { event: true },
        });

        if (order.booking || order.status === "FULFILLED") {
          await transaction.paymentWebhookEvent.update({
            where: { id: webhookId },
            data: {
              processingStatus: "PROCESSED",
              processedAt: now,
              attemptCount: { increment: 1 },
              safeProcessingError: null,
            },
          });
          return;
        }

        if (isContradictoryTerminalStatus(attempt.status, normalizedStatus)) {
          await markWebhookReview(transaction, {
            webhookId,
            attemptId: attempt.id,
            orderId: order.id,
            sessionId: order.sessionId,
            safeCode: "CONTRADICTORY_TERMINAL_STATUS",
            now,
            paid: false,
            preserveOrder: true,
          });
          return;
        }

        if (isTerminalPaymentStatus(attempt.status) && attempt.status === normalizedStatus) {
          await transaction.paymentWebhookEvent.update({
            where: { id: webhookId },
            data: {
              processingStatus:
                order.status === "PAID_UNFULFILLED" || order.status === "REQUIRES_REVIEW"
                  ? "REQUIRES_REVIEW"
                  : "PROCESSED",
              processedAt: now,
              attemptCount: { increment: 1 },
              safeProcessingError: order.safeFailureCode,
            },
          });
          return;
        }

        const amountMatches =
          webhook.providerIntentId === attempt.providerIntentId &&
          webhook.amountMinor === attempt.amountMinor &&
          webhook.currency === attempt.currency &&
          order.totalMinor === attempt.amountMinor &&
          order.currency === attempt.currency;
        if (!amountMatches) {
          await markWebhookReview(transaction, {
            webhookId,
            attemptId: attempt.id,
            orderId: order.id,
            sessionId: order.sessionId,
            safeCode: "PAYMENT_AMOUNT_OR_CURRENCY_MISMATCH",
            now,
            paid: normalizedStatus === "SUCCEEDED",
          });
          return;
        }

        if (normalizedStatus === "FAILED" || normalizedStatus === "CANCELLED") {
          const cancelled = normalizedStatus === "CANCELLED";
          await transaction.paymentAttempt.update({
            where: { id: attempt.id },
            data: {
              status: normalizedStatus,
              failedAt: cancelled ? null : now,
              cancelledAt: cancelled ? now : null,
              lastProviderStatus: normalizedStatus.toLowerCase(),
              safeFailureCode: cancelled ? "PAYMENT_CANCELLED" : "PAYMENT_FAILED",
              updatedAt: now,
            },
          });
          const orderStatus: CheckoutOrderStatus = order.status;
          if (["PENDING", "PAYMENT_PENDING"].includes(orderStatus)) {
            await transaction.checkoutOrder.update({
              where: { id: order.id },
              data: {
                status: "FAILED",
                failedAt: now,
                safeFailureCode: cancelled ? "PAYMENT_CANCELLED" : "PAYMENT_FAILED",
                version: { increment: 1 },
                updatedAt: now,
              },
            });
          }
          await enqueueInventoryEvent(transaction, {
            eventType: "PAYMENT_FAILED",
            sessionId: order.sessionId,
            aggregateId: order.id,
            deduplicationKey: `payment-failed:${webhookId}`,
            now,
          });
          await transaction.paymentWebhookEvent.update({
            where: { id: webhookId },
            data: {
              processingStatus: "PROCESSED",
              processedAt: now,
              attemptCount: { increment: 1 },
              safeProcessingError: null,
            },
          });
          return;
        }

        if (normalizedStatus !== "SUCCEEDED") {
          await transaction.paymentAttempt.update({
            where: { id: attempt.id },
            data: {
              status: "PENDING",
              lastProviderStatus: normalizedStatus.toLowerCase(),
              updatedAt: now,
            },
          });
          await transaction.paymentWebhookEvent.update({
            where: { id: webhookId },
            data: {
              processingStatus: "PROCESSED",
              processedAt: now,
              attemptCount: { increment: 1 },
            },
          });
          return;
        }

        const decision = decidePaidFulfillment({
          orderStatus: order.status,
          holdStatus: hold.status,
          holdExpiresAt: hold.expiresAt,
          eventStatus: eventSession.event.status,
          sessionStatus: eventSession.status,
          now,
        });
        if (decision.outcome === "REVIEW") {
          if (decision.code === "HOLD_EXPIRED" && hold.status === "ACTIVE") {
            await releaseExpiredHoldsForSession(transaction, order.sessionId, now);
          }
          await markWebhookReview(transaction, {
            webhookId,
            attemptId: attempt.id,
            orderId: order.id,
            sessionId: order.sessionId,
            safeCode: decision.code,
            now,
            paid: true,
          });
          return;
        }

        const matches = snapshotsMatch({
          orderItems: order.items,
          holdItems: hold.items,
          inventory,
          holdId: hold.id,
          sessionId: order.sessionId,
          holdExpiresAt: hold.expiresAt,
        });
        if (!matches) {
          await markWebhookReview(transaction, {
            webhookId,
            attemptId: attempt.id,
            orderId: order.id,
            sessionId: order.sessionId,
            safeCode: "FULFILLMENT_SNAPSHOT_MISMATCH",
            now,
            paid: true,
          });
          return;
        }

        await transaction.paymentAttempt.update({
          where: { id: attempt.id },
          data: {
            status: "SUCCEEDED",
            succeededAt: now,
            lastProviderStatus: "succeeded",
            safeFailureCode: null,
            updatedAt: now,
          },
        });
        const booking = await transaction.booking.create({
          data: {
            publicReference: generateBookingReference(),
            orderId: order.id,
            userId: order.userId,
            organizationId: order.organizationId,
            eventId: order.eventId,
            sessionId: order.sessionId,
            status: "CONFIRMED",
            currency: order.currency,
            totalMinor: order.totalMinor,
            confirmedAt: now,
            createdAt: now,
          },
        });
        await transaction.bookingSeat.createMany({
          data: order.items.map((item) => ({
            bookingId: booking.id,
            inventoryId: item.inventoryId,
            sessionId: order.sessionId,
            seatId: item.seatId,
            sectionId: item.sectionId,
            priceTierId: item.priceTierId,
            seatLabel: item.seatLabel,
            rowLabel: item.rowLabel,
            sectionName: item.sectionName,
            sectionCode: item.sectionCode,
            tierName: item.tierName,
            tierCode: item.tierCode,
            priceMinor: item.priceMinor,
            currency: item.currency,
            createdAt: now,
          })),
        });
        await enqueueTicketIssuance(transaction, booking.id, now);
        newlyConfirmedBookingId = booking.id;
        const booked = await transaction.sessionSeatInventory.updateMany({
          where: {
            id: { in: inventoryIds },
            state: "HELD",
            currentHoldId: hold.id,
          },
          data: {
            state: "BOOKED",
            currentHoldId: null,
            holdExpiresAt: null,
            updatedAt: now,
          },
        });
        if (booked.count !== inventoryIds.length) {
          throw new Error("FULFILLMENT_INVENTORY_CONFLICT");
        }
        await transaction.seatHold.update({
          where: { id: hold.id },
          data: { status: "CONVERTED", convertedAt: now, updatedAt: now },
        });
        await transaction.checkoutOrder.update({
          where: { id: order.id },
          data: {
            status: "FULFILLED",
            paidAt: now,
            fulfilledAt: now,
            safeFailureCode: null,
            version: { increment: 1 },
            updatedAt: now,
          },
        });

        await enqueueInventoryEvent(transaction, {
          eventType: "PAYMENT_SUCCEEDED",
          sessionId: order.sessionId,
          aggregateId: order.id,
          deduplicationKey: `payment-succeeded:${webhookId}`,
          now,
        });
        await enqueueInventoryEvent(transaction, {
          eventType: "INVENTORY_BOOKED",
          sessionId: order.sessionId,
          aggregateId: booking.id,
          deduplicationKey: `inventory-booked:${booking.id}`,
          now,
        });
        await enqueueInventoryEvent(transaction, {
          eventType: "BOOKING_CONFIRMED",
          sessionId: order.sessionId,
          aggregateId: booking.id,
          deduplicationKey: `booking-confirmed:${booking.id}`,
          now,
        });
        await transaction.paymentWebhookEvent.update({
          where: { id: webhookId },
          data: {
            processingStatus: "PROCESSED",
            processedAt: now,
            attemptCount: { increment: 1 },
            safeProcessingError: null,
          },
        });

        await options.beforeCommit?.();
      },
      { timeout: 30_000 },
    );
    const credentialSecret = options.ticketCredentialSecret ?? process.env.TICKET_CREDENTIAL_SECRET;
    if (newlyConfirmedBookingId && credentialSecret) {
      await attemptImmediateTicketIssuance(database, {
        bookingId: newlyConfirmedBookingId,
        credentialSecret,
        now,
      });
    }
  } catch (error) {
    if (error instanceof PaymentWebhookSignatureError) throw error;
    await database.paymentWebhookEvent.updateMany({
      where: {
        id: webhookId,
        processingStatus: { in: ["RECEIVED", "FAILED"] },
      },
      data: {
        processingStatus: "FAILED",
        attemptCount: { increment: 1 },
        safeProcessingError: "PROCESSING_RETRY_REQUIRED",
      },
    });
    throw error;
  }
  return loadExistingResult(database, webhookId, false);
}

/**
 * Store a verified refund or dispute envelope.
 *
 * Uses the same unique `(provider, providerEventId)` constraint as payment
 * events, so a duplicate delivery of any category collapses to one row no
 * matter which delivery wins the race.
 */
async function storeVerifiedFinancialWebhook(
  database: PrismaClient,
  provider: PaymentProvider,
  input:
    | { category: "REFUND"; event: NormalizedRefundWebhookEvent }
    | { category: "DISPUTE"; event: NormalizedDisputeWebhookEvent },
  payloadHash: string,
  now: Date,
) {
  const attempt = await database.paymentAttempt.findFirst({
    where: { provider: provider.name, providerIntentId: input.event.providerIntentId },
    select: { id: true },
  });
  try {
    const created = await database.paymentWebhookEvent.create({
      data: {
        provider: provider.name,
        providerEventId: input.event.providerEventId,
        eventType: input.event.eventType,
        eventCategory: input.category,
        providerIntentId: input.event.providerIntentId,
        paymentAttemptId: attempt?.id,
        normalizedStatus: null,
        normalizedRefundStatus:
          input.category === "REFUND" ? input.event.status : null,
        normalizedDisputeStatus:
          input.category === "DISPUTE" ? input.event.status : null,
        providerRefundId:
          input.category === "REFUND" ? input.event.providerRefundId : null,
        providerDisputeId:
          input.category === "DISPUTE" ? input.event.providerDisputeId : null,
        amountMinor: input.event.amountMinor,
        currency: input.event.currency,
        signatureStatus: "VERIFIED",
        processingStatus: "RECEIVED",
        receivedAt: now,
        providerOccurredAt: input.event.occurredAt,
        payloadHash,
      },
      select: { id: true },
    });
    return { webhookId: created.id, duplicate: false };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await database.paymentWebhookEvent.findUniqueOrThrow({
      where: {
        provider_providerEventId: {
          provider: provider.name,
          providerEventId: input.event.providerEventId,
        },
      },
      select: { id: true },
    });
    return { webhookId: existing.id, duplicate: true };
  }
}

/**
 * Settle one verified refund event under a row lock on the webhook record.
 *
 * The webhook is marked processed inside the same transaction that applied the
 * financial change, so a failure at any point leaves it retryable rather than
 * recorded as done.
 */
async function processVerifiedRefundRecord(
  database: PrismaClient,
  webhookId: string,
  options: ProcessOptions,
): Promise<WebhookProcessingResult> {
  const now = options.now ?? new Date();
  return runInTransaction(
    database,
    async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        SELECT "id" FROM "PaymentWebhookEvent" WHERE "id" = ${webhookId} FOR UPDATE
      `);
      const webhook = await transaction.paymentWebhookEvent.findUniqueOrThrow({
        where: { id: webhookId },
      });
      if (["PROCESSED", "REQUIRES_REVIEW"].includes(webhook.processingStatus)) {
        return { outcome: "REFUND_IGNORED", reason: "ALREADY_PROCESSED", duplicate: true };
      }
      if (webhook.signatureStatus !== "VERIFIED") throw new PaymentWebhookSignatureError();
      if (!webhook.providerRefundId || !webhook.normalizedRefundStatus) {
        throw new PaymentWebhookValidationError();
      }

      const settlement = await settleRefundFromVerifiedEvent(transaction, {
        webhookId,
        providerRefundId: webhook.providerRefundId,
        incomingStatus: webhook.normalizedRefundStatus,
        amountMinor: webhook.amountMinor,
        currency: webhook.currency,
        occurredAt: webhook.providerOccurredAt,
        now,
      });

      const requiresReview =
        settlement.outcome === "REVIEW" || settlement.outcome === "UNKNOWN_REFUND";
      await transaction.paymentWebhookEvent.update({
        where: { id: webhookId },
        data: {
          processingStatus: requiresReview ? "REQUIRES_REVIEW" : "PROCESSED",
          processedAt: now,
          attemptCount: { increment: 1 },
          safeProcessingError:
            settlement.outcome === "REVIEW"
              ? settlement.safeCode
              : settlement.outcome === "UNKNOWN_REFUND"
                ? "UNKNOWN_PROVIDER_REFUND"
                : null,
        },
      });

      await options.beforeCommit?.();

      if (settlement.outcome === "APPLIED") {
        return { outcome: "REFUND_SETTLED", status: settlement.status, duplicate: false };
      }
      if (settlement.outcome === "REVIEW") {
        return { outcome: "REQUIRES_REVIEW", safeCode: settlement.safeCode, duplicate: false };
      }
      if (settlement.outcome === "UNKNOWN_REFUND") {
        return {
          outcome: "REQUIRES_REVIEW",
          safeCode: "UNKNOWN_PROVIDER_REFUND",
          duplicate: false,
        };
      }
      return { outcome: "REFUND_IGNORED", reason: settlement.reason, duplicate: false };
    },
    { timeout: 30_000 },
  );
}

/** Apply one verified dispute event under a row lock on the webhook record. */
async function processVerifiedDisputeRecord(
  database: PrismaClient,
  webhookId: string,
  options: ProcessOptions,
): Promise<WebhookProcessingResult> {
  const now = options.now ?? new Date();
  return runInTransaction(
    database,
    async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        SELECT "id" FROM "PaymentWebhookEvent" WHERE "id" = ${webhookId} FOR UPDATE
      `);
      const webhook = await transaction.paymentWebhookEvent.findUniqueOrThrow({
        where: { id: webhookId },
      });
      if (["PROCESSED", "REQUIRES_REVIEW"].includes(webhook.processingStatus)) {
        return { outcome: "DISPUTE_IGNORED", reason: "ALREADY_PROCESSED", duplicate: true };
      }
      if (webhook.signatureStatus !== "VERIFIED") throw new PaymentWebhookSignatureError();
      if (!webhook.providerDisputeId || !webhook.normalizedDisputeStatus) {
        throw new PaymentWebhookValidationError();
      }

      const applied = await applyDisputeFromVerifiedEvent(transaction, {
        webhookId,
        providerEventId: webhook.providerEventId,
        eventType: webhook.eventType,
        providerIntentId: webhook.providerIntentId,
        providerDisputeId: webhook.providerDisputeId,
        status: webhook.normalizedDisputeStatus,
        reasonCategory: "UNRECOGNIZED",
        amountMinor: webhook.amountMinor,
        currency: webhook.currency,
        occurredAt: webhook.providerOccurredAt,
        evidenceDueAt: null,
        now,
      });

      const requiresReview =
        applied.outcome === "REVIEW" || applied.outcome === "UNKNOWN_PAYMENT";
      await transaction.paymentWebhookEvent.update({
        where: { id: webhookId },
        data: {
          processingStatus: requiresReview ? "REQUIRES_REVIEW" : "PROCESSED",
          processedAt: now,
          attemptCount: { increment: 1 },
          safeProcessingError:
            applied.outcome === "REVIEW"
              ? applied.safeCode
              : applied.outcome === "UNKNOWN_PAYMENT"
                ? "UNKNOWN_PAYMENT_INTENT"
                : null,
        },
      });

      await options.beforeCommit?.();

      if (applied.outcome === "OPENED") {
        return { outcome: "DISPUTE_RECORDED", status: "OPEN", duplicate: false };
      }
      if (applied.outcome === "APPLIED") {
        return { outcome: "DISPUTE_RECORDED", status: applied.status, duplicate: false };
      }
      if (applied.outcome === "REVIEW") {
        return { outcome: "REQUIRES_REVIEW", safeCode: applied.safeCode, duplicate: false };
      }
      if (applied.outcome === "UNKNOWN_PAYMENT") {
        return {
          outcome: "REQUIRES_REVIEW",
          safeCode: "UNKNOWN_PAYMENT_INTENT",
          duplicate: false,
        };
      }
      return { outcome: "DISPUTE_IGNORED", reason: applied.reason, duplicate: false };
    },
    { timeout: 30_000 },
  );
}

/**
 * Verify the exact raw body, then route by event category.
 *
 * Order is load-bearing and unchanged from Phase 5A: bound the payload, verify
 * the signature over the exact bytes, and only then parse or persist anything
 * the provider claims. Nothing below the signature check trusts a provider
 * field, and an event category this build does not model is recorded as
 * unsupported rather than guessed at.
 */
export async function processPaymentWebhook(
  database: PrismaClient,
  provider: PaymentProvider,
  input: { rawBody: Uint8Array; signature: string },
  options: ProcessOptions = {},
): Promise<WebhookProcessingResult> {
  assertPaymentWebhookPayloadSize(input.rawBody, options.maximumPayloadBytes);
  if (!provider.verifyWebhook(input)) throw new PaymentWebhookSignatureError();

  let normalized;
  try {
    normalized = provider.normalizeWebhookEvent(input.rawBody);
  } catch (error) {
    if (error instanceof PaymentWebhookValidationError) throw error;
    throw new PaymentWebhookValidationError();
  }

  const now = options.now ?? new Date();
  const payloadHash = hashPaymentWebhookPayload(input.rawBody);

  if (normalized.category === "UNSUPPORTED") {
    // Acknowledged so the provider stops retrying, but nothing is inferred
    // from an event whose meaning this build does not know.
    return { outcome: "UNSUPPORTED_EVENT", duplicate: false };
  }

  if (normalized.category === "PAYMENT") {
    const stored = await storeVerifiedWebhook(
      database,
      provider,
      normalized.event,
      payloadHash,
      now,
    );
    if (stored.duplicate) {
      const existing = await database.paymentWebhookEvent.findUniqueOrThrow({
        where: { id: stored.webhookId },
        select: { processingStatus: true },
      });
      if (["PROCESSED", "REQUIRES_REVIEW"].includes(existing.processingStatus)) {
        return loadExistingResult(database, stored.webhookId, true);
      }
    }
    const result = await processVerifiedWebhookRecord(database, stored.webhookId, options);
    return { ...result, duplicate: stored.duplicate };
  }

  const stored = await storeVerifiedFinancialWebhook(
    database,
    provider,
    normalized,
    payloadHash,
    now,
  );
  const result =
    normalized.category === "REFUND"
      ? await processVerifiedRefundRecord(database, stored.webhookId, options)
      : await processVerifiedDisputeRecord(database, stored.webhookId, options);
  return { ...result, duplicate: stored.duplicate || result.duplicate };
}
