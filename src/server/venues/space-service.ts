import type { PrismaClient } from "@/generated/prisma/client";
import {
  createResourceSlug,
  spaceInputSchema,
  type SpaceInput,
} from "@/features/venues/schema";
import { findAuthorizedSpace, findAuthorizedVenue } from "@/server/authorization/venue-resources";
import {
  isUniqueConstraintError,
  VenueManagementAuthorizationError,
  VenueManagementConflictError,
  VenueManagementLifecycleError,
} from "@/server/venues/errors";

interface SpaceScope {
  userId: string;
  organizationSlug: string;
  venueSlug: string;
}

function assertVenueOperational(status: "DRAFT" | "ACTIVE" | "ARCHIVED") {
  if (status === "ARCHIVED") {
    throw new VenueManagementLifecycleError(
      "Restore the venue before changing its spaces.",
    );
  }
}

export async function createSpace(
  database: PrismaClient,
  scope: SpaceScope,
  rawInput: SpaceInput,
) {
  const access = await findAuthorizedVenue(database, { ...scope, minimumRole: "ADMIN" });

  if (!access) throw new VenueManagementAuthorizationError();
  assertVenueOperational(access.venue.status);

  const input = spaceInputSchema.parse(rawInput);

  try {
    return await database.space.create({
      data: {
        venueId: access.venue.id,
        name: input.name,
        slug: input.slug ?? createResourceSlug(input.name),
        description: input.description,
        type: input.type,
        status: input.status,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new VenueManagementConflictError("A space in this venue already uses that slug.");
    }

    throw error;
  }
}

export async function updateSpace(
  database: PrismaClient,
  scope: SpaceScope & { spaceSlug: string },
  rawInput: SpaceInput,
) {
  const access = await findAuthorizedSpace(database, { ...scope, minimumRole: "ADMIN" });

  if (!access) throw new VenueManagementAuthorizationError();
  assertVenueOperational(access.space.venue.status);
  if (access.space.status === "ARCHIVED") {
    throw new VenueManagementLifecycleError("Restore this space before editing it.");
  }

  const input = spaceInputSchema.parse(rawInput);

  try {
    return await database.space.update({
      where: { id: access.space.id },
      data: {
        name: input.name,
        slug: input.slug ?? createResourceSlug(input.name),
        description: input.description,
        type: input.type,
        status: input.status,
        archivedAt: null,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new VenueManagementConflictError("A space in this venue already uses that slug.");
    }

    throw error;
  }
}

export async function archiveSpace(
  database: PrismaClient,
  scope: SpaceScope & { spaceSlug: string },
) {
  const access = await findAuthorizedSpace(database, { ...scope, minimumRole: "ADMIN" });

  if (!access) throw new VenueManagementAuthorizationError();
  assertVenueOperational(access.space.venue.status);
  if (access.space.status === "ARCHIVED") return access.space;

  return database.space.update({
    where: { id: access.space.id },
    data: { status: "ARCHIVED", archivedAt: new Date() },
  });
}

export async function restoreSpace(
  database: PrismaClient,
  scope: SpaceScope & { spaceSlug: string },
) {
  const access = await findAuthorizedSpace(database, { ...scope, minimumRole: "ADMIN" });

  if (!access) throw new VenueManagementAuthorizationError();
  assertVenueOperational(access.space.venue.status);
  if (access.space.status !== "ARCHIVED") return access.space;

  return database.space.update({
    where: { id: access.space.id },
    data: { status: "ACTIVE", archivedAt: null },
  });
}
