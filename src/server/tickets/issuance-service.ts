import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import {
  deriveTicketCredential,
  generateTicketPublicReference,
  hashTicketCredential,
} from "@/features/tickets/credential";
import { sanitizeNotificationError } from "@/features/notifications/delivery";
import { runInTransaction } from "@/server/database/run-in-transaction";

export interface TicketIssuanceConfiguration {
  batchSize: number;
  maximumAttempts: number;
  backoffBaseMs: number;
  backoffMaximumMs: number;
}

function calculateBackoff(attempt: number, baseMs: number, maximumMs: number) {
  return Math.min(maximumMs, baseMs * 2 ** Math.min(Math.max(attempt - 1, 0), 30));
}

export async function enqueueTicketIssuance(
  transaction: Prisma.TransactionClient,
  bookingId: string,
  now = new Date(),
) {
  return transaction.ticketIssuanceRequest.upsert({
    where: { bookingId },
    create: {
      bookingId,
      status: "PENDING",
      availableAt: now,
      createdAt: now,
      updatedAt: now,
    },
    update: {},
  });
}

async function issueBookingTicketsInTransaction(
  transaction: Prisma.TransactionClient,
  input: { bookingId: string; credentialSecret: string; now: Date },
) {
  const booking = await transaction.booking.findUniqueOrThrow({
    where: { id: input.bookingId },
    include: { seats: { orderBy: { id: "asc" } } },
  });
  if (booking.status !== "CONFIRMED" || booking.seats.length === 0) {
    throw new Error("TICKET_ISSUANCE_BOOKING_NOT_CONFIRMED");
  }

  let issued = 0;
  let credentialsCreated = 0;
  for (const seat of booking.seats) {
    let ticket = await transaction.ticket.findUnique({ where: { bookingSeatId: seat.id } });
    if (!ticket) {
      ticket = await transaction.ticket.create({
        data: {
          publicReference: generateTicketPublicReference(),
          bookingId: booking.id,
          bookingSeatId: seat.id,
          userId: booking.userId,
          organizationId: booking.organizationId,
          eventId: booking.eventId,
          sessionId: booking.sessionId,
          status: "ACTIVE",
          issuedAt: input.now,
          createdAt: input.now,
          updatedAt: input.now,
        },
      });
      await transaction.ticketAuditEvent.create({
        data: { ticketId: ticket.id, action: "ISSUED", createdAt: input.now },
      });
      issued += 1;
    }

    const activeCredential = await transaction.ticketCredential.findFirst({
      where: { ticketId: ticket.id, status: "ACTIVE" },
      select: { id: true },
    });
    if (!activeCredential && ticket.status === "ACTIVE") {
      const latest = await transaction.ticketCredential.findFirst({
        where: { ticketId: ticket.id },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const version = (latest?.version ?? 0) + 1;
      const credential = deriveTicketCredential({
        ticketReference: ticket.publicReference,
        version,
        secret: input.credentialSecret,
      });
      await transaction.ticketCredential.create({
        data: {
          ticketId: ticket.id,
          version,
          credentialHash: hashTicketCredential(credential, input.credentialSecret),
          hashAlgorithm: "HMAC-SHA256-V1",
          status: "ACTIVE",
          issuedAt: input.now,
          createdAt: input.now,
        },
      });
      credentialsCreated += 1;
    }
  }

  const [ticketCount, credentialCount] = await Promise.all([
    transaction.ticket.count({ where: { bookingId: booking.id } }),
    transaction.ticketCredential.count({
      where: { ticket: { bookingId: booking.id }, status: "ACTIVE" },
    }),
  ]);
  if (ticketCount !== booking.seats.length || credentialCount !== booking.seats.length) {
    throw new Error("TICKET_ISSUANCE_INCOMPLETE");
  }

  await transaction.notificationOutbox.upsert({
    where: { deduplicationKey: `booking-tickets-ready:${booking.id}:v1` },
    create: {
      notificationType: "BOOKING_TICKETS_READY",
      recipientUserId: booking.userId,
      bookingId: booking.id,
      templateVersion: 1,
      locale: "en",
      payload: { kind: "booking-tickets-ready", version: 1 },
      deduplicationKey: `booking-tickets-ready:${booking.id}:v1`,
      status: "PENDING",
      availableAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    },
    update: {},
  });
  return { bookingId: booking.id, total: ticketCount, issued, credentialsCreated };
}

export async function processTicketIssuanceForBooking(
  database: PrismaClient,
  input: { bookingId: string; credentialSecret: string; now?: Date },
) {
  const now = input.now ?? new Date();
  return runInTransaction(
    database,
    async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        SELECT "id" FROM "TicketIssuanceRequest"
        WHERE "bookingId" = ${input.bookingId}
        FOR UPDATE
      `);
      const request = await transaction.ticketIssuanceRequest.findUniqueOrThrow({
        where: { bookingId: input.bookingId },
      });
      if (request.status === "COMPLETED") {
        return { bookingId: input.bookingId, total: 0, issued: 0, credentialsCreated: 0 };
      }
      if (request.status === "DEAD_LETTER") {
        throw new Error("TICKET_ISSUANCE_DEAD_LETTER");
      }
      const result = await issueBookingTicketsInTransaction(transaction, {
        bookingId: input.bookingId,
        credentialSecret: input.credentialSecret,
        now,
      });
      await transaction.ticketIssuanceRequest.update({
        where: { id: request.id },
        data: {
          status: "COMPLETED",
          processedAt: now,
          lastError: null,
          updatedAt: now,
        },
      });
      return result;
    },
    { timeout: 30_000 },
  );
}

export async function attemptImmediateTicketIssuance(
  database: PrismaClient,
  input: { bookingId: string; credentialSecret: string; now?: Date },
) {
  try {
    return await processTicketIssuanceForBooking(database, input);
  } catch {
    // Confirmed booking correctness is independent of post-commit issuance.
    return null;
  }
}

export async function processTicketIssuanceBatch(
  database: PrismaClient,
  input: {
    credentialSecret: string;
    configuration: TicketIssuanceConfiguration;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const result = { claimed: 0, completed: 0, failed: 0, deadLettered: 0 };
  for (let index = 0; index < input.configuration.batchSize; index += 1) {
    let attemptedRequest: { id: string } | null = null;
    const claimed = await runInTransaction(database, async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{ id: string; bookingId: string }>>(Prisma.sql`
        SELECT "id", "bookingId"
        FROM "TicketIssuanceRequest"
        WHERE "status" = 'PENDING' AND "availableAt" <= ${now}
        ORDER BY "createdAt" ASC, "id" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);
      const row = rows[0];
      if (!row) return null;
      attemptedRequest = { id: row.id };
      const issued = await issueBookingTicketsInTransaction(transaction, {
        bookingId: row.bookingId,
        credentialSecret: input.credentialSecret,
        now,
      });
      await transaction.ticketIssuanceRequest.update({
        where: { id: row.id },
        data: { status: "COMPLETED", processedAt: now, lastError: null, updatedAt: now },
      });
      return issued;
    }).catch(async (error) => {
      const failedRequest = attemptedRequest;
      if (!failedRequest) return { failed: true as const, deadLettered: false };
      return runInTransaction(database, async (transaction) => {
        await transaction.$queryRaw(Prisma.sql`
          SELECT "id" FROM "TicketIssuanceRequest"
          WHERE "id" = ${failedRequest.id}
          FOR UPDATE
        `);
        const due = await transaction.ticketIssuanceRequest.findUnique({
          where: { id: failedRequest.id },
          select: { status: true, availableAt: true, attemptCount: true },
        });
        if (!due || due.status !== "PENDING" || due.availableAt > now) {
          return { failed: true as const, deadLettered: false };
        }
        const nextAttempt = due.attemptCount + 1;
        const deadLettered = nextAttempt >= input.configuration.maximumAttempts;
        await transaction.ticketIssuanceRequest.update({
          where: { id: failedRequest.id },
          data: {
            status: deadLettered ? "DEAD_LETTER" : "PENDING",
            attemptCount: nextAttempt,
            lastError: sanitizeNotificationError(error),
            availableAt: new Date(
              now.getTime() +
                calculateBackoff(
                  nextAttempt,
                  input.configuration.backoffBaseMs,
                  input.configuration.backoffMaximumMs,
                ),
            ),
            deadLetterAt: deadLettered ? now : null,
            updatedAt: now,
          },
        });
        return { failed: true as const, deadLettered };
      });
    });
    if (!claimed) break;
    result.claimed += 1;
    if ("failed" in claimed) {
      result.failed += 1;
      if (claimed.deadLettered) result.deadLettered += 1;
    } else {
      result.completed += 1;
    }
  }
  return result;
}

export async function retryTicketIssuanceRequest(
  database: PrismaClient,
  input: { requestId: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const updated = await database.ticketIssuanceRequest.updateMany({
    where: { id: input.requestId, status: "DEAD_LETTER" },
    data: {
      status: "PENDING",
      availableAt: now,
      attemptCount: 0,
      processedAt: null,
      lastError: null,
      deadLetterAt: null,
      updatedAt: now,
    },
  });
  return updated.count;
}

export async function getTicketIssuanceBacklog(database: PrismaClient) {
  const [pending, deadLetters, missingTickets, missingCredentials] = await Promise.all([
    database.ticketIssuanceRequest.count({ where: { status: "PENDING" } }),
    database.ticketIssuanceRequest.count({ where: { status: "DEAD_LETTER" } }),
    database.bookingSeat.count({ where: { ticket: null, booking: { status: "CONFIRMED" } } }),
    database.ticket.count({ where: { status: "ACTIVE", credentials: { none: { status: "ACTIVE" } } } }),
  ]);
  return { pending, deadLetters, missingTickets, missingCredentials };
}
