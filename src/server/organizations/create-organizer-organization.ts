import type { PrismaClient } from "@/generated/prisma/client";
import {
  createOrganizationWithOwner,
  OrganizationSlugConflictError,
} from "@/server/organizations/create-organization-with-owner";

export { OrganizationSlugConflictError };

export async function createOrganizerOrganization(
  database: PrismaClient,
  input: { userId: string; name: string },
) {
  return createOrganizationWithOwner(database, { ...input, kind: "ORGANIZER" });
}
