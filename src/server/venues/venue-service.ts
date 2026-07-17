import type { PrismaClient } from "@/generated/prisma/client";
import {
  createResourceSlug,
  venueInputSchema,
  type VenueInput,
} from "@/features/venues/schema";
import {
  findAuthorizedVenue,
  findAuthorizedVenueOperatorOrganization,
} from "@/server/authorization/venue-resources";
import {
  isUniqueConstraintError,
  VenueManagementAuthorizationError,
  VenueManagementConflictError,
  VenueManagementLifecycleError,
} from "@/server/venues/errors";

interface VenueScope {
  userId: string;
  organizationSlug: string;
}

export async function createVenue(
  database: PrismaClient,
  scope: VenueScope,
  rawInput: VenueInput,
) {
  const membership = await findAuthorizedVenueOperatorOrganization(database, {
    ...scope,
    minimumRole: "ADMIN",
  });

  if (!membership) throw new VenueManagementAuthorizationError();

  const input = venueInputSchema.parse(rawInput);

  try {
    return await database.venue.create({
      data: {
        organizationId: membership.organizationId,
        name: input.name,
        slug: input.slug ?? createResourceSlug(input.name),
        description: input.description,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2,
        city: input.city,
        countryCode: input.countryCode,
        postalCode: input.postalCode,
        timeZone: input.timeZone,
        status: input.status,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new VenueManagementConflictError("A venue in this organization already uses that slug.");
    }

    throw error;
  }
}

export async function updateVenue(
  database: PrismaClient,
  scope: VenueScope & { venueSlug: string },
  rawInput: VenueInput,
) {
  const access = await findAuthorizedVenue(database, {
    ...scope,
    minimumRole: "ADMIN",
  });

  if (!access) throw new VenueManagementAuthorizationError();
  if (access.venue.status === "ARCHIVED") {
    throw new VenueManagementLifecycleError("Restore this venue before editing it.");
  }

  const input = venueInputSchema.parse(rawInput);

  try {
    return await database.venue.update({
      where: { id: access.venue.id },
      data: {
        name: input.name,
        slug: input.slug ?? createResourceSlug(input.name),
        description: input.description,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2,
        city: input.city,
        countryCode: input.countryCode,
        postalCode: input.postalCode,
        timeZone: input.timeZone,
        status: input.status,
        archivedAt: null,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new VenueManagementConflictError("A venue in this organization already uses that slug.");
    }

    throw error;
  }
}

export async function archiveVenue(
  database: PrismaClient,
  scope: VenueScope & { venueSlug: string },
) {
  const access = await findAuthorizedVenue(database, { ...scope, minimumRole: "ADMIN" });

  if (!access) throw new VenueManagementAuthorizationError();
  if (access.venue.status === "ARCHIVED") return access.venue;

  return database.venue.update({
    where: { id: access.venue.id },
    data: { status: "ARCHIVED", archivedAt: new Date() },
  });
}

export async function restoreVenue(
  database: PrismaClient,
  scope: VenueScope & { venueSlug: string },
) {
  const access = await findAuthorizedVenue(database, { ...scope, minimumRole: "ADMIN" });

  if (!access) throw new VenueManagementAuthorizationError();
  if (access.venue.status !== "ARCHIVED") return access.venue;

  return database.venue.update({
    where: { id: access.venue.id },
    data: { status: "ACTIVE", archivedAt: null },
  });
}
