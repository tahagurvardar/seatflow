import type { PrismaClient } from "@/generated/prisma/client";
import { createOrganizationWithOwner } from "@/server/organizations/create-organization-with-owner";

export async function createVenueOperatorOrganization(
  database: PrismaClient,
  input: { userId: string; name: string },
) {
  return createOrganizationWithOwner(database, {
    ...input,
    kind: "VENUE_OPERATOR",
  });
}
