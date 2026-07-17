import type { PrismaClient } from "@/generated/prisma/client";
import type { MembershipRole } from "@/generated/prisma/enums";
import { findAuthorizedOrganizationMembership } from "@/server/authorization/organization-membership";

interface OrganizationAccessInput {
  userId: string;
  organizationSlug: string;
  minimumRole?: MembershipRole;
}

export async function findAuthorizedVenueOperatorOrganization(
  database: PrismaClient,
  input: OrganizationAccessInput,
) {
  return findAuthorizedOrganizationMembership(database, {
    userId: input.userId,
    organizationSlug: input.organizationSlug,
    kind: "VENUE_OPERATOR",
    minimumRole: input.minimumRole ?? "MEMBER",
  });
}

export async function findAuthorizedVenue(
  database: PrismaClient,
  input: OrganizationAccessInput & { venueSlug: string },
) {
  const membership = await findAuthorizedVenueOperatorOrganization(database, input);

  if (!membership) return null;

  const venue = await database.venue.findFirst({
    where: {
      organizationId: membership.organizationId,
      slug: input.venueSlug,
    },
  });

  return venue ? { membership, venue } : null;
}

export async function findAuthorizedSpace(
  database: PrismaClient,
  input: OrganizationAccessInput & { venueSlug: string; spaceSlug: string },
) {
  const membership = await findAuthorizedVenueOperatorOrganization(database, input);

  if (!membership) return null;

  const space = await database.space.findFirst({
    where: {
      slug: input.spaceSlug,
      venue: {
        slug: input.venueSlug,
        organizationId: membership.organizationId,
      },
    },
    include: { venue: true },
  });

  return space ? { membership, space } : null;
}

type SeatMapIdentifier =
  | { seatMapId: string; version?: never }
  | { seatMapId?: never; version: number };

export async function findAuthorizedSeatMap(
  database: PrismaClient,
  input: OrganizationAccessInput &
    { venueSlug: string; spaceSlug: string } & SeatMapIdentifier,
) {
  const membership = await findAuthorizedVenueOperatorOrganization(database, input);

  if (!membership) return null;

  const seatMap = await database.seatMap.findFirst({
    where: {
      ...(input.seatMapId ? { id: input.seatMapId } : { version: input.version }),
      space: {
        slug: input.spaceSlug,
        venue: {
          slug: input.venueSlug,
          organizationId: membership.organizationId,
        },
      },
    },
    include: { space: { include: { venue: true } } },
  });

  return seatMap ? { membership, seatMap } : null;
}

export async function findAuthorizedSection(
  database: PrismaClient,
  input: OrganizationAccessInput & {
    venueSlug: string;
    spaceSlug: string;
    seatMapId: string;
    sectionId: string;
  },
) {
  const access = await findAuthorizedSeatMap(database, input);

  if (!access) return null;

  const section = await database.seatSection.findFirst({
    where: { id: input.sectionId, seatMapId: access.seatMap.id },
  });

  return section ? { ...access, section } : null;
}

export async function findAuthorizedRow(
  database: PrismaClient,
  input: OrganizationAccessInput & {
    venueSlug: string;
    spaceSlug: string;
    seatMapId: string;
    sectionId: string;
    rowId: string;
  },
) {
  const access = await findAuthorizedSection(database, input);

  if (!access) return null;

  const row = await database.seatRow.findFirst({
    where: { id: input.rowId, sectionId: access.section.id },
  });

  return row ? { ...access, row } : null;
}

export async function findAuthorizedSeat(
  database: PrismaClient,
  input: OrganizationAccessInput & {
    venueSlug: string;
    spaceSlug: string;
    seatMapId: string;
    sectionId: string;
    rowId: string;
    seatId: string;
  },
) {
  const access = await findAuthorizedRow(database, input);

  if (!access) return null;

  const seat = await database.seat.findFirst({
    where: { id: input.seatId, rowId: access.row.id },
  });

  return seat ? { ...access, seat } : null;
}
