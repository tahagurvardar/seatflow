import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { NotificationEnvironment } from "@/env/schema";
import {
  calculateNotificationBackoffMs,
  sanitizeNotificationError,
  shouldDeadLetterNotification,
} from "@/features/notifications/delivery";
import { runInTransaction } from "@/server/database/run-in-transaction";
import { createSafeTicketEmail } from "@/server/notifications/email-view";
import type {
  NotificationProvider,
  NotificationSendResult,
} from "@/server/notifications/notification-provider";
import { createBookingPdfGrant } from "@/server/tickets/download-grant-service";

interface ClaimedNotificationRow {
  id: string;
}

export interface NotificationDispatcherConfiguration {
  batchSize: number;
  maximumAttempts: number;
  backoffBaseMs: number;
  backoffMaximumMs: number;
  downloadGrantTtlMinutes: number;
  applicationBaseUrl: string;
  credentialSecret: string;
}

export function getNotificationDispatcherConfiguration(
  notification: NotificationEnvironment,
  input: {
    applicationBaseUrl: string;
    credentialSecret: string;
    downloadGrantTtlMinutes: number;
  },
): NotificationDispatcherConfiguration {
  return {
    batchSize: notification.NOTIFICATION_DISPATCH_BATCH_SIZE,
    maximumAttempts: notification.NOTIFICATION_DISPATCH_MAX_ATTEMPTS,
    backoffBaseMs: notification.NOTIFICATION_DISPATCH_BACKOFF_BASE_MS,
    backoffMaximumMs: notification.NOTIFICATION_DISPATCH_BACKOFF_MAX_MS,
    ...input,
  };
}

async function loadNotificationBooking(
  transaction: Prisma.TransactionClient,
  outboxId: string,
) {
  const outbox = await transaction.notificationOutbox.findUniqueOrThrow({
    where: { id: outboxId },
    include: {
      recipient: { select: { email: true } },
      ticket: { select: { bookingId: true } },
    },
  });
  const bookingId = outbox.bookingId ?? outbox.ticket?.bookingId;
  if (!bookingId) throw new Error("PERMANENT_NOTIFICATION_RESOURCE_MISSING");
  const booking = await transaction.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: {
      event: { select: { title: true } },
      session: {
        include: {
          venue: { select: { name: true, timeZone: true } },
        },
      },
      seats: {
        orderBy: [{ sectionCode: "asc" }, { rowLabel: "asc" }, { seatLabel: "asc" }],
        select: { sectionName: true, rowLabel: true, seatLabel: true },
      },
    },
  });
  if (booking.userId !== outbox.recipientUserId) {
    throw new Error("PERMANENT_NOTIFICATION_RECIPIENT_MISMATCH");
  }
  return { outbox, booking };
}

function safeProviderFailure(error: unknown): NotificationSendResult {
  const safe = sanitizeNotificationError(error).toUpperCase().replace(/[^A-Z0-9_:-]/g, "_").slice(0, 80);
  return {
    status: safe.startsWith("PERMANENT_") ? "PERMANENT_FAILURE" : "RETRYABLE_FAILURE",
    safeErrorCode: safe || "NOTIFICATION_PROVIDER_FAILURE",
  };
}

export async function dispatchNotificationBatch(
  database: PrismaClient,
  provider: NotificationProvider,
  configuration: NotificationDispatcherConfiguration,
  now = new Date(),
) {
  const result = { claimed: 0, processed: 0, failed: 0, deadLettered: 0 };
  for (let index = 0; index < configuration.batchSize; index += 1) {
    const dispatched = await runInTransaction(database, async (transaction) => {
      const rows = await transaction.$queryRaw<ClaimedNotificationRow[]>(Prisma.sql`
        SELECT "id" FROM "NotificationOutbox"
        WHERE "status" = 'PENDING' AND "availableAt" <= ${now}
        ORDER BY "createdAt" ASC, "id" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);
      if (!rows[0]) return null;
      const { outbox, booking } = await loadNotificationBooking(transaction, rows[0].id);
      const nextAttemptCount = outbox.attemptCount + 1;
      const deliveryAttemptKey = `${outbox.id}:attempt:${nextAttemptCount}`;
      const grant = await createBookingPdfGrant(transaction, {
        userId: outbox.recipientUserId,
        bookingId: booking.id,
        credentialSecret: configuration.credentialSecret,
        ttlMinutes: configuration.downloadGrantTtlMinutes,
        idempotencySubject: deliveryAttemptKey,
        now,
      });
      if (!grant) throw new Error("PERMANENT_NOTIFICATION_GRANT_FAILED");
      const retrievalUrl = new URL(
        `/api/tickets/download/${encodeURIComponent(grant.token)}`,
        configuration.applicationBaseUrl,
      ).toString();
      const sessionLabel = new Intl.DateTimeFormat("en", {
        dateStyle: "full",
        timeStyle: "short",
        timeZone: booking.session.venue.timeZone,
      }).format(booking.session.startAt);
      const message = createSafeTicketEmail({
        type: outbox.notificationType,
        recipientEmail: outbox.recipient.email,
        eventTitle: booking.event.title,
        sessionLabel,
        venueName: booking.session.venue.name,
        seats: booking.seats,
        retrievalUrl,
        idempotencyKey: deliveryAttemptKey,
      });
      let sendResult: NotificationSendResult;
      try {
        sendResult = await provider.send(message);
      } catch (error) {
        sendResult = safeProviderFailure(error);
      }
      const completedAt = now;
      await transaction.notificationDeliveryAttempt.create({
        data: {
          notificationOutboxId: outbox.id,
          provider: provider.name,
          providerMessageId: sendResult.status === "SUCCEEDED" ? sendResult.providerMessageId : null,
          status: sendResult.status,
          attemptNumber: nextAttemptCount,
          startedAt: now,
          completedAt,
          safeErrorCode: sendResult.status === "SUCCEEDED" ? null : sendResult.safeErrorCode,
          createdAt: now,
        },
      });
      if (sendResult.status === "SUCCEEDED") {
        await transaction.notificationOutbox.update({
          where: { id: outbox.id },
          data: {
            status: "PROCESSED",
            attemptCount: nextAttemptCount,
            processedAt: completedAt,
            lastError: null,
            updatedAt: completedAt,
          },
        });
        return { processed: true, deadLettered: false };
      }
      const deadLettered = shouldDeadLetterNotification({
        status: sendResult.status,
        nextAttemptCount,
        maximumAttempts: configuration.maximumAttempts,
      });
      await transaction.notificationOutbox.update({
        where: { id: outbox.id },
        data: {
          status: deadLettered ? "DEAD_LETTER" : "PENDING",
          attemptCount: nextAttemptCount,
          lastError: sendResult.safeErrorCode,
          availableAt: new Date(
            now.getTime() +
              calculateNotificationBackoffMs(
                nextAttemptCount,
                configuration.backoffBaseMs,
                configuration.backoffMaximumMs,
              ),
          ),
          deadLetterAt: deadLettered ? completedAt : null,
          updatedAt: completedAt,
        },
      });
      return { processed: false, deadLettered };
    }, { timeout: 30_000 });
    if (!dispatched) break;
    result.claimed += 1;
    if (dispatched.processed) result.processed += 1;
    else result.failed += 1;
    if (dispatched.deadLettered) result.deadLettered += 1;
  }
  return result;
}

export async function getNotificationDeliveryHealth(database: PrismaClient) {
  const [pending, deadLetters, attempts, delivered] = await Promise.all([
    database.notificationOutbox.count({ where: { status: "PENDING" } }),
    database.notificationOutbox.count({ where: { status: "DEAD_LETTER" } }),
    database.notificationDeliveryAttempt.count(),
    database.notificationOutbox.count({ where: { status: "PROCESSED" } }),
  ]);
  return { pending, deadLetters, attempts, delivered };
}

export async function retryPendingNotifications(
  database: PrismaClient,
  input: { outboxId?: string; now?: Date },
) {
  const updated = await database.notificationOutbox.updateMany({
    where: { status: "PENDING", ...(input.outboxId ? { id: input.outboxId } : {}) },
    data: { availableAt: input.now ?? new Date(), updatedAt: input.now ?? new Date() },
  });
  return updated.count;
}
