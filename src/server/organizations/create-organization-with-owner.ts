import type { PrismaClient } from "@/generated/prisma/client";
import type { OrganizationKind } from "@/generated/prisma/enums";
import {
  createOrganizationSlug,
  organizationOnboardingSchema,
} from "@/features/organizations/schema";

export class OrganizationSlugConflictError extends Error {
  constructor() {
    super("An organization already uses this slug.");
    this.name = "OrganizationSlugConflictError";
  }
}

function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

export async function createOrganizationWithOwner(
  database: PrismaClient,
  input: { userId: string; name: string; kind: OrganizationKind },
) {
  const organizationInput = organizationOnboardingSchema.parse({ name: input.name });
  const slug = createOrganizationSlug(organizationInput.name);
  const existingOrganization = await database.organization.findUnique({
    where: { slug },
    select: { id: true },
  });

  if (existingOrganization) {
    throw new OrganizationSlugConflictError();
  }

  try {
    return await database.organization.create({
      data: {
        name: organizationInput.name,
        slug,
        kind: input.kind,
        memberships: {
          create: {
            userId: input.userId,
            role: "OWNER",
          },
        },
      },
      include: { memberships: true },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new OrganizationSlugConflictError();
    }

    throw error;
  }
}
