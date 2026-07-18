import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import {
  deriveTicketCredential,
  hashTicketCredential,
} from "@/features/tickets/credential";
import { canRotateTicket } from "@/features/tickets/lifecycle";
import { ticketRevocationReasonSchema } from "@/features/tickets/schema";
import { runInTransaction } from "@/server/database/run-in-transaction";
import { hasMinimumMembershipRole } from "@/server/authorization/organization-membership";

export async function canManageTicket(
  database: PrismaClient,
  input: { actorUserId: string; ticketReference: string },
) {
  const [actor, ticket] = await Promise.all([
    database.user.findUnique({ where: { id: input.actorUserId }, select: { platformRole: true } }),
    database.ticket.findUnique({
      where: { publicReference: input.ticketReference },
      select: { organizationId: true },
    }),
  ]);
  if (!ticket || !actor) return false;
  if (actor.platformRole === "ADMIN") return true;
  const membership = await database.membership.findUnique({
    where: {
      userId_organizationId: {
        userId: input.actorUserId,
        organizationId: ticket.organizationId,
      },
    },
    select: { role: true },
  });
  return Boolean(membership && hasMinimumMembershipRole(membership.role, "ADMIN"));
}

export async function rotateTicketCredential(
  database: PrismaClient,
  input: {
    actorUserId: string;
    ticketReference: string;
    credentialSecret: string;
    now?: Date;
  },
) {
  if (!(await canManageTicket(database, input))) throw new Error("TICKET_MANAGEMENT_FORBIDDEN");
  const now = input.now ?? new Date();
  return runInTransaction(database, async (transaction) => {
    const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "Ticket" WHERE "publicReference" = ${input.ticketReference} FOR UPDATE
    `);
    if (!rows[0]) throw new Error("TICKET_NOT_FOUND");
    const ticket = await transaction.ticket.findUniqueOrThrow({ where: { id: rows[0].id } });
    if (!canRotateTicket(ticket.status)) throw new Error("TICKET_CREDENTIAL_ROTATION_FORBIDDEN");
    const credential = await transaction.ticketCredential.findFirstOrThrow({
      where: { ticketId: ticket.id, status: "ACTIVE" },
      orderBy: { version: "desc" },
    });
    await transaction.$queryRaw(Prisma.sql`
      SELECT "id" FROM "TicketCredential" WHERE "id" = ${credential.id} FOR UPDATE
    `);
    const nextVersion = credential.version + 1;
    const plaintext = deriveTicketCredential({
      ticketReference: ticket.publicReference,
      version: nextVersion,
      secret: input.credentialSecret,
    });
    await transaction.ticketCredential.update({
      where: { id: credential.id },
      data: { status: "REPLACED", replacedAt: now },
    });
    const replacement = await transaction.ticketCredential.create({
      data: {
        ticketId: ticket.id,
        version: nextVersion,
        credentialHash: hashTicketCredential(plaintext, input.credentialSecret),
        hashAlgorithm: "HMAC-SHA256-V1",
        status: "ACTIVE",
        issuedAt: now,
        createdAt: now,
      },
    });
    await transaction.ticketCredential.update({
      where: { id: credential.id },
      data: { replacementCredentialId: replacement.id },
    });
    await transaction.ticket.update({
      where: { id: ticket.id },
      data: { lastCredentialRotationAt: now, updatedAt: now },
    });
    await transaction.ticketAuditEvent.create({
      data: {
        ticketId: ticket.id,
        actorUserId: input.actorUserId,
        action: "CREDENTIAL_ROTATED",
        createdAt: now,
      },
    });
    await transaction.notificationOutbox.upsert({
      where: { deduplicationKey: `ticket-credential-rotated:${ticket.id}:v${nextVersion}` },
      create: {
        notificationType: "CREDENTIAL_ROTATED",
        recipientUserId: ticket.userId,
        ticketId: ticket.id,
        templateVersion: 1,
        locale: "en",
        payload: { kind: "ticket-credential-rotated", version: nextVersion },
        deduplicationKey: `ticket-credential-rotated:${ticket.id}:v${nextVersion}`,
        status: "PENDING",
        availableAt: now,
        createdAt: now,
        updatedAt: now,
      },
      update: {},
    });
    return { ticketReference: ticket.publicReference, credentialVersion: nextVersion };
  });
}

export async function revokeTicket(
  database: PrismaClient,
  input: { actorUserId: string; ticketReference: string; reason: string; now?: Date },
) {
  if (!(await canManageTicket(database, input))) throw new Error("TICKET_MANAGEMENT_FORBIDDEN");
  const reason = ticketRevocationReasonSchema.parse(input.reason);
  const now = input.now ?? new Date();
  return runInTransaction(database, async (transaction) => {
    const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "Ticket" WHERE "publicReference" = ${input.ticketReference} FOR UPDATE
    `);
    if (!rows[0]) throw new Error("TICKET_NOT_FOUND");
    const ticket = await transaction.ticket.findUniqueOrThrow({ where: { id: rows[0].id } });
    if (ticket.status === "REVOKED") return { ticketReference: ticket.publicReference, duplicate: true };
    if (ticket.status === "USED") throw new Error("USED_TICKET_CANNOT_BE_REVOKED");
    const activeCredential = await transaction.ticketCredential.findFirst({
      where: { ticketId: ticket.id, status: "ACTIVE" },
    });
    if (activeCredential) {
      await transaction.$queryRaw(Prisma.sql`
        SELECT "id" FROM "TicketCredential" WHERE "id" = ${activeCredential.id} FOR UPDATE
      `);
      await transaction.ticketCredential.update({
        where: { id: activeCredential.id },
        data: { status: "REVOKED", revokedAt: now },
      });
    }
    await transaction.ticket.update({
      where: { id: ticket.id },
      data: {
        status: "REVOKED",
        revokedAt: now,
        revocationReason: reason,
        revokedByUserId: input.actorUserId,
        updatedAt: now,
      },
    });
    await transaction.ticketAuditEvent.create({
      data: {
        ticketId: ticket.id,
        actorUserId: input.actorUserId,
        action: "REVOKED",
        safeReason: reason,
        createdAt: now,
      },
    });
    await transaction.notificationOutbox.upsert({
      where: { deduplicationKey: `ticket-revoked:${ticket.id}` },
      create: {
        notificationType: "TICKET_REVOKED",
        recipientUserId: ticket.userId,
        ticketId: ticket.id,
        templateVersion: 1,
        locale: "en",
        payload: { kind: "ticket-revoked", reason },
        deduplicationKey: `ticket-revoked:${ticket.id}`,
        status: "PENDING",
        availableAt: now,
        createdAt: now,
        updatedAt: now,
      },
      update: {},
    });
    return { ticketReference: ticket.publicReference, duplicate: false };
  });
}
