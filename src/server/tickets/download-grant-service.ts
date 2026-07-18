import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import {
  compareTicketCredentialHash,
  deriveDownloadGrantToken,
  deriveTicketCredential,
  generateDownloadGrantToken,
  hashDownloadGrantToken,
  hashTicketCredential,
} from "@/features/tickets/credential";
import { isDownloadGrantUsable } from "@/features/tickets/lifecycle";
import type { TicketPdfView } from "@/features/tickets/pdf";
import { runInTransaction } from "@/server/database/run-in-transaction";
import { renderBookingTicketPdf } from "@/server/tickets/pdf-service";

export async function createBookingPdfGrant(
  database: PrismaClient | Prisma.TransactionClient,
  input: {
    userId: string;
    bookingReference?: string;
    bookingId?: string;
    credentialSecret: string;
    ttlMinutes: number;
    idempotencySubject?: string;
    now?: Date;
  },
) {
  if (Boolean(input.bookingReference) === Boolean(input.bookingId)) {
    throw new Error("Exactly one booking identifier is required.");
  }
  const booking = await database.booking.findFirst({
    where: {
      ...(input.bookingId ? { id: input.bookingId } : { publicReference: input.bookingReference }),
      userId: input.userId,
      status: "CONFIRMED",
    },
    select: { id: true },
  });
  if (!booking) return null;
  const now = input.now ?? new Date();
  const token = input.idempotencySubject
    ? deriveDownloadGrantToken({
        idempotencySubject: input.idempotencySubject,
        secret: input.credentialSecret,
      })
    : generateDownloadGrantToken();
  const grant = await database.ticketDownloadGrant.create({
    data: {
      bookingId: booking.id,
      userId: input.userId,
      tokenHash: hashDownloadGrantToken(token, input.credentialSecret),
      purpose: "BOOKING_PDF",
      expiresAt: new Date(now.getTime() + input.ttlMinutes * 60_000),
      createdAt: now,
    },
  });
  return { id: grant.id, token, expiresAt: grant.expiresAt };
}

function buildPdfView(
  booking: Awaited<ReturnType<typeof loadBookingForPdf>>,
  credentialSecret: string,
): TicketPdfView {
  if (!booking) throw new Error("BOOKING_PDF_NOT_FOUND");
  return {
    bookingReference: booking.publicReference,
    eventTitle: booking.event.title,
    startAt: booking.session.startAt,
    timeZone: booking.session.venue.timeZone,
    venueName: booking.session.venue.name,
    venueCity: booking.session.venue.city,
    spaceName: booking.session.space.name,
    tickets: booking.tickets.map((ticket) => {
      const stored = ticket.credentials[0];
      let credential: string | undefined;
      if (ticket.status === "ACTIVE") {
        if (!stored) throw new Error("TICKET_CREDENTIAL_NOT_AVAILABLE");
        credential = deriveTicketCredential({
          ticketReference: ticket.publicReference,
          version: stored.version,
          secret: credentialSecret,
        });
        const actualHash = hashTicketCredential(credential, credentialSecret);
        if (!compareTicketCredentialHash(stored.credentialHash, actualHash)) {
          throw new Error("TICKET_CREDENTIAL_INTEGRITY_FAILURE");
        }
      }
      return {
        ticketReference: ticket.publicReference,
        sectionName: ticket.bookingSeat.sectionName,
        sectionCode: ticket.bookingSeat.sectionCode,
        rowLabel: ticket.bookingSeat.rowLabel,
        seatLabel: ticket.bookingSeat.seatLabel,
        tierName: ticket.bookingSeat.tierName,
        status: ticket.status,
        credential,
      };
    }),
  };
}

function loadBookingForPdf(transaction: Prisma.TransactionClient, bookingId: string) {
  return transaction.booking.findUnique({
    where: { id: bookingId },
    include: {
      event: { select: { title: true } },
      session: {
        include: {
          venue: { select: { name: true, city: true, timeZone: true } },
          space: { select: { name: true } },
        },
      },
      tickets: {
        orderBy: { bookingSeat: { seatLabel: "asc" } },
        include: {
          bookingSeat: true,
          credentials: { where: { status: "ACTIVE" }, orderBy: { version: "desc" }, take: 1 },
        },
      },
    },
  });
}

export async function consumeBookingPdfGrant(
  database: PrismaClient,
  input: { userId: string; token: string; credentialSecret: string },
) {
  const tokenHash = hashDownloadGrantToken(input.token, input.credentialSecret);
  return runInTransaction(database, async (transaction) => {
    const candidate = await transaction.ticketDownloadGrant.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true },
    });
    if (!candidate || candidate.userId !== input.userId) return null;
    const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "TicketDownloadGrant"
      WHERE "id" = ${candidate.id}
        AND "userId" = ${input.userId}
      FOR UPDATE
    `);
    if (!rows[0]) return null;
    const [{ epochMilliseconds }] = await transaction.$queryRaw<Array<{ epochMilliseconds: string }>>(Prisma.sql`
      SELECT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint)::text AS "epochMilliseconds"
    `);
    const now = new Date(Number(epochMilliseconds));
    const grant = await transaction.ticketDownloadGrant.findUniqueOrThrow({ where: { id: rows[0].id } });
    if (grant.purpose !== "BOOKING_PDF" || !isDownloadGrantUsable({ ...grant, now })) {
      return null;
    }
    const booking = await loadBookingForPdf(transaction, grant.bookingId);
    if (!booking || booking.userId !== input.userId || booking.status !== "CONFIRMED") return null;
    const view = buildPdfView(booking, input.credentialSecret);
    const bytes = await renderBookingTicketPdf(view);
    await transaction.ticketDownloadGrant.update({
      where: { id: grant.id },
      data: { usedAt: now },
    });
    return { bytes, view };
  }, { timeout: 30_000 });
}
