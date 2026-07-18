import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { TicketRedemptionOutcome } from "@/generated/prisma/enums";
import {
  compareTicketCredentialHash,
  hashTicketCredential,
  parseTicketCredential,
} from "@/features/tickets/credential";
import { decideEntryWindow } from "@/features/tickets/lifecycle";
import { runInTransaction } from "@/server/database/run-in-transaction";
import { findAuthorizedScannerSession } from "@/server/tickets/scanner-authorization";

interface LockedCredentialRow {
  id: string;
  ticketId: string;
  credentialHash: string;
}

export interface TicketScanResult {
  outcome: TicketRedemptionOutcome;
  accepted: boolean;
  ticket?: {
    reference: string;
    eventTitle: string;
    venueName: string;
    startAt: string;
    timeZone: string;
    sectionName: string;
    rowLabel: string;
    seatLabel: string;
  };
}

function safeReason(outcome: TicketRedemptionOutcome) {
  return outcome === "ACCEPTED" ? null : outcome;
}

export async function validateTicketEntry(
  database: PrismaClient,
  input: {
    scannerUserId: string;
    sessionId: string;
    credential: string;
    credentialSecret: string;
    earlyMinutes: number;
    lateMinutes: number;
    scannerIdentifier?: string;
    idempotencyKey?: string;
  },
): Promise<TicketScanResult> {
  const target = await database.eventSession.findUnique({
    where: { id: input.sessionId },
    select: { id: true, eventId: true, event: { select: { organizerOrganizationId: true } } },
  });
  if (!target) return { outcome: "UNAUTHORIZED_SCANNER", accepted: false };
  const scannerAccess = await findAuthorizedScannerSession(database, {
    userId: input.scannerUserId,
    sessionId: input.sessionId,
  });
  if (!scannerAccess) {
    await database.ticketRedemptionEvent.create({
      data: {
        organizationId: target.event.organizerOrganizationId,
        eventId: target.eventId,
        sessionId: target.id,
        scannerUserId: input.scannerUserId,
        outcome: "UNAUTHORIZED_SCANNER",
        scannedAt: new Date(),
        scannerIdentifier: input.scannerIdentifier,
        rejectionReason: "UNAUTHORIZED_SCANNER",
        idempotencyKey: input.idempotencyKey,
      },
    }).catch(() => undefined);
    return { outcome: "UNAUTHORIZED_SCANNER", accepted: false };
  }

  return runInTransaction(database, async (transaction) => {
    if (input.idempotencyKey) {
      const existing = await transaction.ticketRedemptionEvent.findUnique({
        where: {
          scannerUserId_idempotencyKey: {
            scannerUserId: input.scannerUserId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        select: { outcome: true },
      });
      if (existing) return { outcome: existing.outcome, accepted: existing.outcome === "ACCEPTED" };
    }

    const [{ epochMilliseconds }] = await transaction.$queryRaw<Array<{ epochMilliseconds: string }>>(Prisma.sql`
      SELECT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint)::text AS "epochMilliseconds"
    `);
    const now = new Date(Number(epochMilliseconds));
    const parsed = parseTicketCredential(input.credential);
    if (!parsed) {
      await transaction.ticketRedemptionEvent.create({
        data: {
          organizationId: target.event.organizerOrganizationId,
          eventId: target.eventId,
          sessionId: target.id,
          scannerUserId: input.scannerUserId,
          outcome: "INVALID",
          scannedAt: now,
          scannerIdentifier: input.scannerIdentifier,
          rejectionReason: "INVALID",
          idempotencyKey: input.idempotencyKey,
        },
      });
      return { outcome: "INVALID", accepted: false };
    }
    const suppliedHash = hashTicketCredential(parsed.credential, input.credentialSecret);
    const rows = await transaction.$queryRaw<LockedCredentialRow[]>(Prisma.sql`
      SELECT "id", "ticketId", "credentialHash"
      FROM "TicketCredential"
      WHERE "credentialHash" = ${suppliedHash}
      FOR UPDATE
    `);
    const locked = rows[0];
    if (!locked || !compareTicketCredentialHash(locked.credentialHash, suppliedHash)) {
      await transaction.ticketRedemptionEvent.create({
        data: {
          organizationId: target.event.organizerOrganizationId,
          eventId: target.eventId,
          sessionId: target.id,
          scannerUserId: input.scannerUserId,
          outcome: "INVALID",
          scannedAt: now,
          scannerIdentifier: input.scannerIdentifier,
          rejectionReason: "INVALID",
          idempotencyKey: input.idempotencyKey,
        },
      });
      return { outcome: "INVALID", accepted: false };
    }
    await transaction.$queryRaw(Prisma.sql`
      SELECT "id" FROM "Ticket" WHERE "id" = ${locked.ticketId} FOR UPDATE
    `);
    const credential = await transaction.ticketCredential.findUniqueOrThrow({
      where: { id: locked.id },
    });
    const ticket = await transaction.ticket.findUniqueOrThrow({
      where: { id: locked.ticketId },
      include: {
        booking: { select: { status: true } },
        bookingSeat: true,
        event: { select: { title: true } },
        session: { include: { venue: true } },
      },
    });

    let outcome: TicketRedemptionOutcome = "ACCEPTED";
    if (ticket.sessionId !== input.sessionId || ticket.eventId !== target.eventId) outcome = "WRONG_SESSION";
    else if (credential.status === "USED" || ticket.status === "USED") outcome = "ALREADY_USED";
    else if (["REVOKED", "REPLACED"].includes(credential.status) || ticket.status === "REVOKED") outcome = "REVOKED";
    else if (ticket.booking.status !== "CONFIRMED") outcome = "REVOKED";
    else {
      const window = decideEntryWindow({
        sessionStatus: ticket.session.status,
        startAt: ticket.session.startAt,
        endAt: ticket.session.endAt,
        now,
        earlyMinutes: input.earlyMinutes,
        lateMinutes: input.lateMinutes,
      });
      if (window !== "OPEN") outcome = window;
    }

    await transaction.ticketRedemptionEvent.create({
      data: {
        ticketId: ticket.id,
        ticketCredentialId: credential.id,
        organizationId: target.event.organizerOrganizationId,
        eventId: target.eventId,
        sessionId: target.id,
        scannerUserId: input.scannerUserId,
        outcome,
        scannedAt: now,
        scannerIdentifier: input.scannerIdentifier,
        rejectionReason: safeReason(outcome),
        idempotencyKey: input.idempotencyKey,
      },
    });
    if (outcome === "ACCEPTED") {
      await transaction.ticketCredential.update({
        where: { id: credential.id },
        data: { status: "USED", usedAt: now },
      });
      await transaction.ticket.update({
        where: { id: ticket.id },
        data: { status: "USED", updatedAt: now },
      });
    }

    const canShowDetails = outcome === "ACCEPTED" || outcome === "ALREADY_USED" || outcome === "REVOKED";
    return {
      outcome,
      accepted: outcome === "ACCEPTED",
      ...(canShowDetails
        ? {
            ticket: {
              reference: ticket.publicReference,
              eventTitle: ticket.event.title,
              venueName: ticket.session.venue.name,
              startAt: ticket.session.startAt.toISOString(),
              timeZone: ticket.session.venue.timeZone,
              sectionName: ticket.bookingSeat.sectionName,
              rowLabel: ticket.bookingSeat.rowLabel,
              seatLabel: ticket.bookingSeat.seatLabel,
            },
          }
        : {}),
    };
  }, { timeout: 15_000 });
}
