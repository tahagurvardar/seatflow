import type { PrismaClient } from "@/generated/prisma/client";
import { findAuthorizedOrganizerOrganization } from "@/server/authorization/event-resources";
import { findAuthorizedVenue } from "@/server/authorization/venue-resources";
import { withSerializableRetry } from "@/server/database/serializable-transaction";
import {
  EventAuthorizationError,
  EventConflictError,
  EventLifecycleError,
  EventValidationError,
  isPrismaUniqueConstraintError,
} from "@/server/events/errors";

interface OperatorVenueScope {
  userId: string;
  organizationSlug: string;
  venueSlug: string;
}

export async function grantVenueAccess(
  database: PrismaClient,
  scope: OperatorVenueScope,
  organizerOrganizationSlug: string,
) {
  const access = await findAuthorizedVenue(database, {
    ...scope,
    minimumRole: "ADMIN",
  });
  if (!access) throw new EventAuthorizationError();
  if (access.venue.status === "ARCHIVED") {
    throw new EventLifecycleError("Restore the venue before granting new access.");
  }

  const organizer = await database.organization.findFirst({
    where: {
      slug: organizerOrganizationSlug.trim().toLowerCase(),
      kind: "ORGANIZER",
    },
  });
  if (!organizer) {
    throw new EventValidationError(["Enter an existing organizer organization slug."]);
  }

  try {
    return await withSerializableRetry(database, async (transaction) => {
      const existing = await transaction.venueAccessGrant.findFirst({
        where: {
          organizerOrganizationId: organizer.id,
          venueId: access.venue.id,
          status: "ACTIVE",
        },
      });
      if (existing) return existing;

      return transaction.venueAccessGrant.create({
        data: {
          organizerOrganizationId: organizer.id,
          operatorOrganizationId: access.membership.organizationId,
          venueId: access.venue.id,
          grantedByUserId: scope.userId,
          status: "ACTIVE",
        },
      });
    });
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      throw new EventConflictError("This organizer already has active venue access.");
    }
    throw error;
  }
}

export async function revokeVenueAccess(
  database: PrismaClient,
  scope: OperatorVenueScope & { grantId: string },
) {
  const access = await findAuthorizedVenue(database, {
    ...scope,
    minimumRole: "ADMIN",
  });
  if (!access) throw new EventAuthorizationError();

  return withSerializableRetry(database, async (transaction) => {
    const grant = await transaction.venueAccessGrant.findFirst({
      where: {
        id: scope.grantId,
        venueId: access.venue.id,
        operatorOrganizationId: access.membership.organizationId,
      },
    });
    if (!grant) throw new EventAuthorizationError();
    if (grant.status === "REVOKED") return grant;

    return transaction.venueAccessGrant.update({
      where: { id: grant.id },
      data: {
        status: "REVOKED",
        revokedAt: new Date(),
        revokedByUserId: scope.userId,
      },
    });
  });
}

export async function listApprovedVenuesForOrganizer(
  database: PrismaClient,
  scope: { userId: string; organizationSlug: string },
) {
  const membership = await findAuthorizedOrganizerOrganization(database, {
    ...scope,
    minimumRole: "MEMBER",
  });
  if (!membership) throw new EventAuthorizationError();

  return database.venueAccessGrant.findMany({
    where: { organizerOrganizationId: membership.organizationId },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: {
      venue: {
        include: {
          organization: { select: { name: true, slug: true } },
          spaces: {
            where: { status: "ACTIVE" },
            orderBy: { name: "asc" },
            include: {
              seatMaps: {
                where: { status: "PUBLISHED" },
                orderBy: { version: "desc" },
                select: {
                  id: true,
                  name: true,
                  version: true,
                  publishedAt: true,
                },
              },
            },
          },
        },
      },
    },
  });
}

export async function listActiveVenueOptionsForOrganizer(
  database: PrismaClient,
  scope: { userId: string; organizationSlug: string },
) {
  const grants = await listApprovedVenuesForOrganizer(database, scope);

  return grants
    .filter(
      (grant) => grant.status === "ACTIVE" && grant.venue.status === "ACTIVE",
    )
    .map((grant) => ({
      id: grant.venue.id,
      name: grant.venue.name,
      city: grant.venue.city,
      timeZone: grant.venue.timeZone,
      spaces: grant.venue.spaces
        .filter((space) => space.seatMaps.length > 0)
        .map((space) => ({
          id: space.id,
          name: space.name,
          seatMaps: space.seatMaps.map((seatMap) => ({
            id: seatMap.id,
            name: seatMap.name,
            version: seatMap.version,
          })),
        })),
    }))
    .filter((venue) => venue.spaces.length > 0);
}
