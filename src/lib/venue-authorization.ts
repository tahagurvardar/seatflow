import "server-only";

import { forbidden } from "next/navigation";

import type { MembershipRole } from "@/generated/prisma/enums";
import { requireAuth } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";
import {
  findAuthorizedSeatMap,
  findAuthorizedSpace,
  findAuthorizedVenue,
  findAuthorizedVenueOperatorOrganization,
} from "@/server/authorization/venue-resources";

export async function requireVenueOperatorOrganizationAccess(
  organizationSlug: string,
  redirectPath: string,
  minimumRole: MembershipRole = "MEMBER",
) {
  const session = await requireAuth(redirectPath);
  const membership = await findAuthorizedVenueOperatorOrganization(getDatabase(), {
    userId: session.user.id,
    organizationSlug,
    minimumRole,
  });
  if (!membership) forbidden();
  return { session, membership };
}

export async function requireVenueAccess(
  input: { organizationSlug: string; venueSlug: string },
  redirectPath: string,
  minimumRole: MembershipRole = "MEMBER",
) {
  const session = await requireAuth(redirectPath);
  const access = await findAuthorizedVenue(getDatabase(), {
    userId: session.user.id,
    ...input,
    minimumRole,
  });
  if (!access) forbidden();
  return { session, ...access };
}

export async function requireSpaceAccess(
  input: { organizationSlug: string; venueSlug: string; spaceSlug: string },
  redirectPath: string,
  minimumRole: MembershipRole = "MEMBER",
) {
  const session = await requireAuth(redirectPath);
  const access = await findAuthorizedSpace(getDatabase(), {
    userId: session.user.id,
    ...input,
    minimumRole,
  });
  if (!access) forbidden();
  return { session, ...access };
}

export async function requireSeatMapAccess(
  input: {
    organizationSlug: string;
    venueSlug: string;
    spaceSlug: string;
    version: number;
  },
  redirectPath: string,
  minimumRole: MembershipRole = "MEMBER",
) {
  const session = await requireAuth(redirectPath);
  const access = await findAuthorizedSeatMap(getDatabase(), {
    userId: session.user.id,
    ...input,
    minimumRole,
  });
  if (!access) forbidden();
  return { session, ...access };
}
