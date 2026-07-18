import type { PrismaClient } from "@/generated/prisma/client";
import type { MembershipRole } from "@/generated/prisma/enums";
import { findAuthorizedOrganizationMembership } from "@/server/authorization/organization-membership";

interface OrganizerAccessInput {
  userId: string;
  organizationSlug: string;
  minimumRole?: MembershipRole;
}

export async function findAuthorizedOrganizerOrganization(
  database: PrismaClient,
  input: OrganizerAccessInput,
) {
  return findAuthorizedOrganizationMembership(database, {
    userId: input.userId,
    organizationSlug: input.organizationSlug,
    kind: "ORGANIZER",
    minimumRole: input.minimumRole ?? "MEMBER",
  });
}

type EventIdentifier =
  | { eventId: string; eventSlug?: never }
  | { eventId?: never; eventSlug: string };

export async function findAuthorizedEvent(
  database: PrismaClient,
  input: OrganizerAccessInput & EventIdentifier,
) {
  const membership = await findAuthorizedOrganizerOrganization(database, input);
  if (!membership) return null;

  const event = await database.event.findFirst({
    where: {
      organizerOrganizationId: membership.organizationId,
      ...(input.eventId ? { id: input.eventId } : { slug: input.eventSlug }),
    },
  });

  return event ? { membership, event } : null;
}

export async function findAuthorizedEventSession(
  database: PrismaClient,
  input: OrganizerAccessInput & EventIdentifier & { sessionId: string },
) {
  const access = await findAuthorizedEvent(database, input);
  if (!access) return null;

  const eventSession = await database.eventSession.findFirst({
    where: { id: input.sessionId, eventId: access.event.id },
    include: {
      venue: true,
      space: true,
      seatMap: true,
    },
  });

  return eventSession ? { ...access, eventSession } : null;
}

export async function findAuthorizedPriceTier(
  database: PrismaClient,
  input: OrganizerAccessInput &
    EventIdentifier & { sessionId: string; priceTierId: string },
) {
  const access = await findAuthorizedEventSession(database, input);
  if (!access) return null;

  const priceTier = await database.sessionPriceTier.findFirst({
    where: { id: input.priceTierId, sessionId: access.eventSession.id },
  });

  return priceTier ? { ...access, priceTier } : null;
}
