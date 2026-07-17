"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { ROUTES } from "@/config/site";
import { organizationOnboardingSchema } from "@/features/organizations/schema";
import { requireAuth } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";
import {
  createOrganizerOrganization,
  OrganizationSlugConflictError,
} from "@/server/organizations/create-organizer-organization";

export interface OrganizationOnboardingState {
  fieldErrors?: { name?: string };
  message?: string;
}

export async function createOrganizerOrganizationAction(
  _previousState: OrganizationOnboardingState,
  formData: FormData,
): Promise<OrganizationOnboardingState> {
  const session = await requireAuth(ROUTES.organizerOnboarding);
  const parsed = organizationOnboardingSchema.safeParse({
    name: formData.get("name"),
  });

  if (!parsed.success) {
    return {
      fieldErrors: {
        name: parsed.error.issues[0]?.message ?? "Enter an organization name.",
      },
    };
  }

  let organization;

  try {
    organization = await createOrganizerOrganization(getDatabase(), {
      userId: session.user.id,
      name: parsed.data.name,
    });
  } catch (error) {
    if (error instanceof OrganizationSlugConflictError) {
      return {
        fieldErrors: {
          name: "That organization name is already in use. Choose a more distinctive name.",
        },
      };
    }

    return {
      message: "SeatFlow could not create the organization. Please try again.",
    };
  }

  revalidatePath(ROUTES.customerDashboard);
  revalidatePath(ROUTES.organizerDashboard);
  redirect(
    `${ROUTES.organizerDashboard}?organization=${encodeURIComponent(organization.slug)}`,
  );
}
