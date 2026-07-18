import { randomBytes } from "node:crypto";

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { PaymentProviderName } from "@/generated/prisma/enums";
import { checkoutCreateInputSchema } from "@/features/checkout/schema";
import { calculateCheckoutTotal } from "@/features/checkout/totals";
import { evaluateSessionSalesEligibility } from "@/features/holds/eligibility";
import { runInTransaction } from "@/server/database/run-in-transaction";
import { enqueueInventoryEvent } from "@/server/inventory-events/outbox-service";
import {
  CheckoutAuthenticationError,
  CheckoutAuthorizationError,
  CheckoutConflictError,
  CheckoutEligibilityError,
  CheckoutValidationError,
  PaymentProviderError,
} from "@/server/payments/errors";
import type {
  PaymentProvider,
  ProviderPaymentIntent,
} from "@/server/payments/payment-provider";

function generatePublicReference() {
  return randomBytes(24).toString("base64url");
}

function generateProviderIdempotencyKey() {
  return `pay_${randomBytes(32).toString("base64url")}`;
}

interface LockedInventoryRow {
  id: string;
  seatId: string;
  state: string;
  currentHoldId: string | null;
  holdExpiresAt: Date | null;
}

const checkoutSourceHoldInclude = {
  session: {
    include: {
      event: true,
    },
  },
  items: {
    include: {
      inventory: {
        include: {
          seat: { include: { row: true } },
          section: true,
          priceTier: true,
        },
      },
    },
  },
  checkoutOrder: {
    select: {
      id: true,
      publicReference: true,
      userId: true,
      idempotencyKey: true,
    },
  },
} satisfies Prisma.SeatHoldInclude;

export interface CheckoutActor {
  userId: string;
}

export interface CreateCheckoutResult {
  orderId: string;
  publicReference: string;
  replayed: boolean;
}

/**
 * Create one immutable checkout from the authenticated customer's active hold.
 * The hold and every inventory row are locked; price, currency, customer,
 * organization, session, event, and expiry are read only from PostgreSQL.
 */
export async function createCheckoutOrder(
  database: PrismaClient,
  actor: CheckoutActor,
  rawInput: unknown,
  options: { now?: Date; provider: PaymentProviderName } ,
): Promise<CreateCheckoutResult> {
  if (!actor?.userId) throw new CheckoutAuthenticationError();
  const parsed = checkoutCreateInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new CheckoutValidationError(parsed.error.issues.map((issue) => issue.message));
  }
  const now = options.now ?? new Date();

  return runInTransaction(
    database,
    async (transaction) => {
      const lockedHold = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "SeatHold"
        WHERE "publicToken" = ${parsed.data.holdToken}
        FOR UPDATE
      `);
      if (lockedHold.length !== 1) throw new CheckoutAuthorizationError();

      const hold = await transaction.seatHold.findUnique({
        where: { id: lockedHold[0]!.id },
        include: checkoutSourceHoldInclude,
      });
      if (!hold || hold.userId !== actor.userId) {
        throw new CheckoutAuthorizationError();
      }

      if (hold.checkoutOrder) {
        if (
          hold.checkoutOrder.userId === actor.userId &&
          hold.checkoutOrder.idempotencyKey === parsed.data.idempotencyKey
        ) {
          return {
            orderId: hold.checkoutOrder.id,
            publicReference: hold.checkoutOrder.publicReference,
            replayed: true,
          };
        }
        throw new CheckoutConflictError(
          "This hold already has a checkout order. Continue with the existing checkout.",
        );
      }

      if (hold.status !== "ACTIVE" || now >= hold.expiresAt) {
        throw new CheckoutEligibilityError(
          "This seat hold has expired or is no longer active.",
          "HOLD_NOT_ACTIVE",
        );
      }
      if (hold.items.length === 0) {
        throw new CheckoutEligibilityError(
          "This seat hold does not contain any seats.",
          "HOLD_EMPTY",
        );
      }

      const inventoryIds = hold.items.map((item) => item.inventoryId);
      const lockedInventory = await transaction.$queryRaw<LockedInventoryRow[]>(Prisma.sql`
        SELECT "id", "seatId", "state", "currentHoldId", "holdExpiresAt"
        FROM "SessionSeatInventory"
        WHERE "id" IN (${Prisma.join(inventoryIds)})
        ORDER BY "seatId" ASC
        FOR UPDATE
      `);
      if (
        lockedInventory.length !== inventoryIds.length ||
        lockedInventory.some(
          (row) =>
            row.state !== "HELD" ||
            row.currentHoldId !== hold.id ||
            !row.holdExpiresAt ||
            row.holdExpiresAt.getTime() !== hold.expiresAt.getTime(),
        )
      ) {
        throw new CheckoutConflictError(
          "The held inventory no longer matches this checkout.",
        );
      }

      const eligibility = evaluateSessionSalesEligibility({
        eventStatus: hold.session.event.status,
        sessionStatus: hold.session.status,
        sessionStartAt: hold.session.startAt,
        salesStartAt: hold.session.salesStartAt,
        salesEndAt: hold.session.salesEndAt,
        hasInventory: true,
        now,
      });
      if (!eligibility.sellable) {
        throw new CheckoutEligibilityError(eligibility.message, eligibility.reason);
      }

      const total = calculateCheckoutTotal(
        hold.items.map((item) => ({
          priceMinor: item.priceMinor,
          currency: item.currency,
        })),
      );
      const order = await transaction.checkoutOrder.create({
        data: {
          publicReference: generatePublicReference(),
          userId: actor.userId,
          organizationId: hold.session.event.organizerOrganizationId,
          eventId: hold.session.eventId,
          sessionId: hold.sessionId,
          sourceHoldId: hold.id,
          status: "PENDING",
          currency: total.currency,
          subtotalMinor: total.subtotalMinor,
          totalMinor: total.totalMinor,
          idempotencyKey: parsed.data.idempotencyKey,
          checkoutExpiresAt: hold.expiresAt,
          createdAt: now,
          updatedAt: now,
        },
        select: { id: true, publicReference: true },
      });

      await transaction.checkoutOrderItem.createMany({
        data: hold.items.map((item) => ({
          orderId: order.id,
          inventoryId: item.inventoryId,
          seatId: item.inventory.seatId,
          sectionId: item.inventory.sectionId,
          priceTierId: item.inventory.priceTierId,
          seatLabel: item.inventory.seat.label,
          rowLabel: item.inventory.seat.row.label,
          sectionName: item.inventory.section.name,
          sectionCode: item.inventory.section.code,
          tierName: item.inventory.priceTier.name,
          tierCode: item.inventory.priceTier.code,
          priceMinor: item.priceMinor,
          currency: item.currency,
          createdAt: now,
        })),
      });

      await transaction.paymentAttempt.create({
        data: {
          orderId: order.id,
          provider: options.provider,
          providerIdempotencyKey: generateProviderIdempotencyKey(),
          status: "CREATED",
          amountMinor: total.totalMinor,
          currency: total.currency,
          createdAt: now,
          updatedAt: now,
        },
      });

      await enqueueInventoryEvent(transaction, {
        eventType: "CHECKOUT_CREATED",
        sessionId: hold.sessionId,
        aggregateId: order.id,
        deduplicationKey: `checkout-created:${order.id}`,
        now,
      });

      return { orderId: order.id, publicReference: order.publicReference, replayed: false };
    },
    { timeout: 20_000 },
  );
}

export interface PaymentIntentResult {
  attemptId: string;
  intent: ProviderPaymentIntent;
  replayed: boolean;
}

/**
 * Call the provider outside a database transaction. The stable provider
 * idempotency key exists before the call, so retries after a crash cannot create
 * a second provider intent. A success status returned here is never financial
 * authority; only a later verified webhook can mark the order paid.
 */
export async function ensurePaymentIntent(
  database: PrismaClient,
  provider: PaymentProvider,
  orderId: string,
  now = new Date(),
): Promise<PaymentIntentResult> {
  const attempt = await database.paymentAttempt.findFirst({
    where: { orderId, provider: provider.name },
    include: { order: true },
  });
  if (!attempt) throw new CheckoutConflictError("Payment attempt is missing.");
  if (attempt.providerIntentId) {
    return {
      attemptId: attempt.id,
      replayed: true,
      intent: {
        providerIntentId: attempt.providerIntentId,
        status: attempt.status,
        providerStatus: attempt.lastProviderStatus ?? attempt.status.toLowerCase(),
        checkoutUrl: null,
      },
    };
  }
  if (now >= attempt.order.checkoutExpiresAt) {
    throw new CheckoutEligibilityError("This checkout has expired.", "CHECKOUT_EXPIRED");
  }

  let intent: ProviderPaymentIntent;
  try {
    intent = await provider.createPaymentIntent({
      orderReference: attempt.order.publicReference,
      amountMinor: attempt.amountMinor,
      currency: attempt.currency,
      idempotencyKey: attempt.providerIdempotencyKey,
      expiresAt: attempt.order.checkoutExpiresAt,
    });
  } catch {
    throw new PaymentProviderError();
  }

  return runInTransaction(database, async (transaction) => {
    await transaction.$queryRaw(Prisma.sql`
      SELECT "id" FROM "PaymentAttempt" WHERE "id" = ${attempt.id} FOR UPDATE
    `);
    const current = await transaction.paymentAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
      include: { order: true },
    });
    if (current.providerIntentId) {
      return {
        attemptId: current.id,
        replayed: true,
        intent: {
          providerIntentId: current.providerIntentId,
          status: current.status,
          providerStatus: current.lastProviderStatus ?? current.status.toLowerCase(),
          checkoutUrl: null,
        },
      };
    }

    await transaction.paymentAttempt.update({
      where: { id: current.id },
      data: {
        providerIntentId: intent.providerIntentId,
        status: "PENDING",
        lastProviderStatus: intent.providerStatus.slice(0, 80),
        updatedAt: now,
      },
    });
    if (current.order.status === "PENDING") {
      await transaction.checkoutOrder.update({
        where: { id: current.orderId },
        data: { status: "PAYMENT_PENDING", version: { increment: 1 }, updatedAt: now },
      });
    }
    await enqueueInventoryEvent(transaction, {
      eventType: "PAYMENT_INTENT_CREATED",
      sessionId: current.order.sessionId,
      aggregateId: current.id,
      deduplicationKey: `payment-intent-created:${current.id}`,
      now,
    });
    return { attemptId: current.id, intent, replayed: false };
  });
}

export async function createCheckoutAndPayment(
  database: PrismaClient,
  provider: PaymentProvider,
  actor: CheckoutActor,
  rawInput: unknown,
  now = new Date(),
) {
  const order = await createCheckoutOrder(database, actor, rawInput, {
    now,
    provider: provider.name,
  });
  const payment = await ensurePaymentIntent(database, provider, order.orderId, now);
  return { order, payment };
}
