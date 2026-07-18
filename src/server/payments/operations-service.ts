import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { runInTransaction } from "@/server/database/run-in-transaction";
import { releaseExpiredHoldsForSession } from "@/server/holds/expiry-service";
import { ensurePaymentIntent } from "@/server/payments/checkout-service";
import type { PaymentProvider } from "@/server/payments/payment-provider";
import { processVerifiedWebhookRecord } from "@/server/payments/webhook-service";

export async function listPaidUnfulfilledOrders(
  database: PrismaClient,
  limit = 100,
) {
  return database.checkoutOrder.findMany({
    where: {
      paidAt: { not: null },
      status: { in: ["PAID_UNFULFILLED", "REQUIRES_REVIEW"] },
    },
    orderBy: { paidAt: "asc" },
    take: Math.min(Math.max(limit, 1), 1_000),
    select: {
      publicReference: true,
      status: true,
      currency: true,
      totalMinor: true,
      paidAt: true,
      safeFailureCode: true,
      sessionId: true,
    },
  });
}

export async function listStalePendingCheckoutOrders(
  database: PrismaClient,
  now = new Date(),
  limit = 100,
) {
  return database.checkoutOrder.findMany({
    where: {
      status: { in: ["PENDING", "PAYMENT_PENDING"] },
      checkoutExpiresAt: { lte: now },
    },
    orderBy: { checkoutExpiresAt: "asc" },
    take: Math.min(Math.max(limit, 1), 1_000),
    select: {
      publicReference: true,
      status: true,
      checkoutExpiresAt: true,
      currency: true,
      totalMinor: true,
    },
  });
}

export interface ExpireCheckoutResult {
  expiredOrders: number;
  batches: number;
}

export async function expireUnpaidCheckoutOrders(
  database: PrismaClient,
  options: { now?: Date; batchSize?: number; maxBatches?: number } = {},
): Promise<ExpireCheckoutResult> {
  const now = options.now ?? new Date();
  const batchSize = Math.min(Math.max(options.batchSize ?? 100, 1), 1_000);
  const maxBatches = Math.min(Math.max(options.maxBatches ?? 10, 1), 100_000);
  let expiredOrders = 0;
  let batches = 0;

  while (batches < maxBatches) {
    const count = await runInTransaction(database, async (transaction) => {
      const claimed = await transaction.$queryRaw<Array<{ id: string; sessionId: string }>>(
        Prisma.sql`
          SELECT "id", "sessionId"
          FROM "CheckoutOrder"
          WHERE "status" IN ('PENDING', 'PAYMENT_PENDING')
            AND "checkoutExpiresAt" <= ${now}
          ORDER BY "checkoutExpiresAt" ASC, "id" ASC
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        `,
      );
      if (!claimed.length) return 0;
      await transaction.checkoutOrder.updateMany({
        where: { id: { in: claimed.map((order) => order.id) }, status: { in: ["PENDING", "PAYMENT_PENDING"] } },
        data: {
          status: "EXPIRED",
          expiredAt: now,
          safeFailureCode: "CHECKOUT_EXPIRED",
          version: { increment: 1 },
          updatedAt: now,
        },
      });
      for (const sessionId of new Set(claimed.map((order) => order.sessionId))) {
        await releaseExpiredHoldsForSession(transaction, sessionId, now);
      }
      return claimed.length;
    });
    if (count === 0) break;
    expiredOrders += count;
    batches += 1;
  }
  return { expiredOrders, batches };
}

export interface ReconciliationResult {
  inspected: number;
  initialized: number;
  refreshed: number;
  awaitingVerifiedWebhook: number;
  failed: number;
}

/**
 * Reconcile provider calls without granting payment authority. Even when the
 * provider reports success, this command only records a bounded provider status
 * and reports that a verified webhook is still required.
 */
export async function reconcilePendingPaymentIntents(
  database: PrismaClient,
  provider: PaymentProvider,
  limit = 100,
): Promise<ReconciliationResult> {
  const attempts = await database.paymentAttempt.findMany({
    where: { provider: provider.name, status: { in: ["CREATED", "PENDING"] } },
    orderBy: { updatedAt: "asc" },
    take: Math.min(Math.max(limit, 1), 1_000),
    select: { id: true, orderId: true, providerIntentId: true },
  });
  const result: ReconciliationResult = {
    inspected: attempts.length,
    initialized: 0,
    refreshed: 0,
    awaitingVerifiedWebhook: 0,
    failed: 0,
  };
  for (const attempt of attempts) {
    try {
      if (!attempt.providerIntentId) {
        await ensurePaymentIntent(database, provider, attempt.orderId);
        result.initialized += 1;
        continue;
      }
      const providerIntent = await provider.retrievePaymentIntent({
        providerIntentId: attempt.providerIntentId,
      });
      await database.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          lastProviderStatus: providerIntent.providerStatus.slice(0, 80),
          updatedAt: new Date(),
        },
      });
      result.refreshed += 1;
      if (providerIntent.status === "SUCCEEDED") {
        result.awaitingVerifiedWebhook += 1;
      }
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

export async function reprocessVerifiedWebhook(
  database: PrismaClient,
  webhookId: string,
) {
  const webhook = await database.paymentWebhookEvent.findUnique({
    where: { id: webhookId },
    select: { id: true, signatureStatus: true, processingStatus: true },
  });
  if (!webhook || webhook.signatureStatus !== "VERIFIED") {
    throw new Error("Verified webhook record was not found.");
  }
  if (["PROCESSED", "REQUIRES_REVIEW"].includes(webhook.processingStatus)) {
    return processVerifiedWebhookRecord(database, webhook.id);
  }
  return processVerifiedWebhookRecord(database, webhook.id);
}

export async function getPaymentOperationsHealth(
  database: PrismaClient,
  now = new Date(),
) {
  const [
    pendingOrders,
    stalePendingOrders,
    verifiedUnprocessedWebhooks,
    failedWebhooks,
    paidUnfulfilled,
    confirmedBookings,
    bookedSeats,
  ] = await Promise.all([
    database.checkoutOrder.count({ where: { status: { in: ["PENDING", "PAYMENT_PENDING"] } } }),
    database.checkoutOrder.count({ where: { status: { in: ["PENDING", "PAYMENT_PENDING"] }, checkoutExpiresAt: { lte: now } } }),
    database.paymentWebhookEvent.count({ where: { signatureStatus: "VERIFIED", processingStatus: "RECEIVED" } }),
    database.paymentWebhookEvent.count({ where: { processingStatus: "FAILED" } }),
    database.checkoutOrder.count({ where: { paidAt: { not: null }, status: { in: ["PAID_UNFULFILLED", "REQUIRES_REVIEW"] } } }),
    database.booking.count({ where: { status: "CONFIRMED" } }),
    database.sessionSeatInventory.count({ where: { state: "BOOKED" } }),
  ]);
  return {
    checkedAt: now.toISOString(),
    pendingOrders,
    stalePendingOrders,
    verifiedUnprocessedWebhooks,
    failedWebhooks,
    paidUnfulfilled,
    confirmedBookings,
    bookedSeats,
  };
}

