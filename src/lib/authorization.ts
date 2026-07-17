import "server-only";

import { cache } from "react";
import { forbidden, redirect } from "next/navigation";

import type {
  MembershipRole,
  OrganizationKind,
} from "@/generated/prisma/enums";
import { ROUTES } from "@/config/site";
import { getDatabase } from "@/lib/database";
import { getSafeRedirectPath } from "@/lib/safe-redirect";
import { getCurrentSession } from "@/lib/session";
import {
  findAuthorizedOrganizationMembership,
  hasMinimumMembershipRole,
} from "@/server/authorization/organization-membership";

export { hasMinimumMembershipRole };

export async function requireAuth(
  redirectPath: string = ROUTES.customerDashboard,
) {
  const session = await getCurrentSession();

  if (!session) {
    const destination = getSafeRedirectPath(
      redirectPath,
      ROUTES.customerDashboard,
    );
    redirect(`${ROUTES.login}?redirectTo=${encodeURIComponent(destination)}`);
  }

  return session;
}

export async function requirePlatformAdmin(redirectPath = ROUTES.admin) {
  const session = await requireAuth(redirectPath);
  const user = await getDatabase().user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      name: true,
      email: true,
      platformRole: true,
      createdAt: true,
    },
  });

  if (!user || user.platformRole !== "ADMIN") {
    forbidden();
  }

  return { session, user };
}

export const getUserMemberships = cache(async (userId: string) =>
  getDatabase().membership.findMany({
    where: { userId },
    include: { organization: true },
    orderBy: [
      { organization: { createdAt: "asc" } },
      { organization: { slug: "asc" } },
    ],
  }),
);

interface OrganizationMembershipRequirement {
  organizationId?: string;
  organizationSlug?: string;
  kind?: OrganizationKind;
  minimumRole?: MembershipRole;
  redirectPath?: string;
}

export async function requireOrganizationMembership({
  organizationId,
  organizationSlug,
  kind,
  minimumRole = "MEMBER",
  redirectPath = ROUTES.organizerDashboard,
}: OrganizationMembershipRequirement) {
  const session = await requireAuth(redirectPath);
  const membership = await findAuthorizedOrganizationMembership(getDatabase(), {
    userId: session.user.id,
    organizationId,
    organizationSlug,
    kind,
    minimumRole,
  });

  if (!membership) {
    forbidden();
  }

  return { session, membership };
}

export function forbiddenJson(message = "You do not have access to this resource.") {
  return Response.json({ error: message }, { status: 403 });
}

export function unauthorizedJson(message = "Authentication is required.") {
  return Response.json({ error: message }, { status: 401 });
}
