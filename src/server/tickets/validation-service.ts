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

/**
 * An idempotency key was reused for a scan of a different session or
 * credential. The recorded result belongs to another request, so it is never
 * replayed and the new request is never evaluated under the spent key.
 */
export class TicketScanIdempotencyConflictError extends Error {
  constructor() {
    super("TICKET_SCAN_IDEMPOTENCY_CONFLICT");
    this.name = "TicketScanIdempotencyConflictError";
  }
}

const DETAIL_OUTCOMES: ReadonlySet<TicketRedemptionOutcome> = new Set([
  "ACCEPTED",
  "ALREADY_USED",
  "REVOKED",
]);

type ScanClient = PrismaClient | Prisma.TransactionClient;

function isIdempotencyUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String((error as { code: unknown }).code) === "P2002"
  );
}

/**
 * Return the recorded result for a retried scan, or null when the key is new.
 *
 * A replay is bound to the original request: the same session and the same
 * credential. Ticket details are rebuilt from the recorded ticket under the
 * same disclosure rule as a first evaluation, so a retry neither reveals more
 * nor less than the original response did.
 */
async function replayRecordedScan(
  client: ScanClient,
  input: { scannerUserId: string; sessionId: string; idempotencyKey: string },
  suppliedHash: string | null,
): Promise<TicketScanResult | null> {
  const existing = await client.ticketRedemptionEvent.findUnique({
    where: {
      scannerUserId_idempotencyKey: {
        scannerUserId: input.scannerUserId,
        idempotencyKey: input.idempotencyKey,
      },
    },
    select: {
      outcome: true,
      sessionId: true,
      credential: { select: { credentialHash: true } },
      ticket: {
        select: {
          publicReference: true,
          sessionId: true,
          bookingSeat: { select: { sectionName: true, rowLabel: true, seatLabel: true } },
          event: { select: { title: true } },
          session: { select: { startAt: true, venue: { select: { name: true, timeZone: true } } } },
        },
      },
    },
  });
  if (!existing) return null;

  if (existing.sessionId !== input.sessionId) throw new TicketScanIdempotencyConflictError();
  if (existing.credential) {
    if (!suppliedHash || !compareTicketCredentialHash(existing.credential.credentialHash, suppliedHash)) {
      throw new TicketScanIdempotencyConflictError();
    }
  } else if (suppliedHash) {
    // The original matched no credential. A key reused for a credential that
    // does resolve is a different scan.
    const resolves = await client.ticketCredential.findUnique({
      where: { credentialHash: suppliedHash },
      select: { id: true },
    });
    if (resolves) throw new TicketScanIdempotencyConflictError();
  }

  const ticket = existing.ticket;
  return {
    outcome: existing.outcome,
    accepted: existing.outcome === "ACCEPTED",
    ...(ticket && DETAIL_OUTCOMES.has(existing.outcome) && ticket.sessionId === input.sessionId
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
}

function suppliedCredentialHash(credential: string, secret: string) {
  const parsed = parseTicketCredential(credential);
  return parsed ? hashTicketCredential(parsed.credential, secret) : null;
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

  const idempotencyKey = input.idempotencyKey;
  try {
    return await evaluateScan(database, input, target);
  } catch (error) {
    // Defence in depth: the advisory lock below serializes same-key scans, but
    // if a duplicate insert still loses the unique race, answer with the
    // winner's recorded result instead of surfacing a 500.
    if (!idempotencyKey || !isIdempotencyUniqueViolation(error)) throw error;
    const replay = await replayRecordedScan(
      database,
      { scannerUserId: input.scannerUserId, sessionId: input.sessionId, idempotencyKey },
      suppliedCredentialHash(input.credential, input.credentialSecret),
    );
    if (!replay) throw error;
    return replay;
  }
}

async function evaluateScan(
  database: PrismaClient,
  input: Parameters<typeof validateTicketEntry>[1],
  target: { id: string; eventId: string; event: { organizerOrganizationId: string } },
): Promise<TicketScanResult> {
  return runInTransaction(database, async (transaction) => {
    if (input.idempotencyKey) {
      // Serialize every scan that shares this scanner's key. A concurrent retry
      // waits here, then reads the committed result instead of racing the
      // first request into the unique index.
      await transaction.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`ticket-scan:${input.scannerUserId}:${input.idempotencyKey}`}, 0)
        )
      `);
      const replay = await replayRecordedScan(
        transaction,
        {
          scannerUserId: input.scannerUserId,
          sessionId: input.sessionId,
          idempotencyKey: input.idempotencyKey,
        },
        suppliedCredentialHash(input.credential, input.credentialSecret),
      );
      if (replay) return replay;
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

    const canShowDetails = DETAIL_OUTCOMES.has(outcome);
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
