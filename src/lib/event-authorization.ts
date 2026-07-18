import "server-only";

import { forbidden } from "next/navigation";

import type { MembershipRole } from "@/generated/prisma/enums";
import { requireAuth } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";
import {
  findAuthorizedEvent,
  findAuthorizedEventSession,
  findAuthorizedOrganizerOrganization,
} from "@/server/authorization/event-resources";

export async function requireOrganizerOrganizationAccess(
  organizationSlug: string,
  redirectPath: string,
  minimumRole: MembershipRole = "MEMBER",
) {
  const session = await requireAuth(redirectPath);
  const membership = await findAuthorizedOrganizerOrganization(getDatabase(), {
    userId: session.user.id,
    organizationSlug,
    minimumRole,
  });
  if (!membership) forbidden();
  return { session, membership };
}

export async function requireEventAccess(
  input: { organizationSlug: string; eventSlug: string },
  redirectPath: string,
  minimumRole: MembershipRole = "MEMBER",
) {
  const session = await requireAuth(redirectPath);
  const access = await findAuthorizedEvent(getDatabase(), {
    userId: session.user.id,
    ...input,
    minimumRole,
  });
  if (!access) forbidden();
  return { session, ...access };
}

export async function requireEventSessionAccess(
  input: {
    organizationSlug: string;
    eventSlug: string;
    sessionId: string;
  },
  redirectPath: string,
  minimumRole: MembershipRole = "MEMBER",
) {
  const session = await requireAuth(redirectPath);
  const access = await findAuthorizedEventSession(getDatabase(), {
    userId: session.user.id,
    ...input,
    minimumRole,
  });
  if (!access) forbidden();
  return { session, ...access };
}
