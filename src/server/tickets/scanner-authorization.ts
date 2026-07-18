import type { PrismaClient } from "@/generated/prisma/client";

export async function findAuthorizedScannerSession(
  database: PrismaClient,
  input: { userId: string; sessionId: string },
) {
  const eventSession = await database.eventSession.findUnique({
    where: { id: input.sessionId },
    include: {
      event: { select: { id: true, title: true, organizerOrganizationId: true } },
      venue: { select: { id: true, organizationId: true, name: true, timeZone: true } },
    },
  });
  if (!eventSession) return null;
  const membership = await database.membership.findFirst({
    where: {
      userId: input.userId,
      role: { in: ["OWNER", "ADMIN"] },
      organizationId: {
        in: [eventSession.event.organizerOrganizationId, eventSession.venue.organizationId],
      },
    },
    select: { organizationId: true, role: true },
  });
  return membership ? { eventSession, membership } : null;
}
