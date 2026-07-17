import type { PrismaClient } from "@/generated/prisma/client";
import type {
  MembershipRole,
  OrganizationKind,
} from "@/generated/prisma/enums";

const membershipRoleRank: Record<MembershipRole, number> = {
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

export function hasMinimumMembershipRole(
  actual: MembershipRole,
  minimum: MembershipRole,
) {
  return membershipRoleRank[actual] >= membershipRoleRank[minimum];
}

interface MembershipLookup {
  userId: string;
  organizationId?: string;
  organizationSlug?: string;
  kind?: OrganizationKind;
  minimumRole?: MembershipRole;
}

export async function findAuthorizedOrganizationMembership(
  database: PrismaClient,
  {
    userId,
    organizationId,
    organizationSlug,
    kind,
    minimumRole = "MEMBER",
  }: MembershipLookup,
) {
  if (Boolean(organizationId) === Boolean(organizationSlug)) {
    throw new Error(
      "Organization authorization requires exactly one organization identifier.",
    );
  }

  const membership = await database.membership.findFirst({
    where: {
      userId,
      organization: {
        ...(organizationId ? { id: organizationId } : { slug: organizationSlug }),
        ...(kind ? { kind } : {}),
      },
    },
    include: { organization: true },
  });

  return membership && hasMinimumMembershipRole(membership.role, minimumRole)
    ? membership
    : null;
}
