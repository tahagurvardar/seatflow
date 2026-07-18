"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { ROUTES } from "@/config/site";
import {
  organizationSlugSchema,
  venueAccessRevocationSchema,
} from "@/features/organizations/schema";
import { requireAuth } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";
import {
  EventAuthorizationError,
  EventConflictError,
  EventLifecycleError,
  EventValidationError,
} from "@/server/events/errors";
import {
  grantVenueAccess,
  revokeVenueAccess,
} from "@/server/venue-access/venue-access-service";

export interface VenueAccessActionState {
  message?: string;
}

interface VenueAccessScope {
  organizationSlug: string;
  venueSlug: string;
}

function message(error: unknown) {
  if (error instanceof EventValidationError) return error.issues.join(" ");
  if (
    error instanceof EventAuthorizationError ||
    error instanceof EventConflictError ||
    error instanceof EventLifecycleError
  ) {
    return error.message;
  }
  return "SeatFlow could not update venue access. Please try again.";
}

export async function grantVenueAccessAction(
  scope: VenueAccessScope,
  _state: VenueAccessActionState,
  formData: FormData,
): Promise<VenueAccessActionState> {
  const path = ROUTES.venueOperatorVenueAccess(
    scope.organizationSlug,
    scope.venueSlug,
  );
  const session = await requireAuth(path);
  const organizerSlug = organizationSlugSchema.safeParse(
    formData.get("organizerSlug"),
  );
  if (!organizerSlug.success) {
    return { message: organizerSlug.error.issues[0]?.message };
  }

  try {
    await grantVenueAccess(
      getDatabase(),
      { userId: session.user.id, ...scope },
      organizerSlug.data,
    );
  } catch (error) {
    return { message: message(error) };
  }

  revalidatePath(path);
  redirect(`${path}?success=granted`);
}

export async function revokeVenueAccessAction(
  scope: VenueAccessScope & { grantId: string },
  formData: FormData,
) {
  const path = ROUTES.venueOperatorVenueAccess(
    scope.organizationSlug,
    scope.venueSlug,
  );
  const session = await requireAuth(path);
  const revocation = venueAccessRevocationSchema.safeParse({
    confirmation: formData.get("confirmation"),
  });
  if (!revocation.success) {
    redirect(`${path}?error=${encodeURIComponent(revocation.error.issues[0]?.message ?? "Confirm revocation before continuing.")}`);
  }

  try {
    await revokeVenueAccess(getDatabase(), {
      userId: session.user.id,
      ...scope,
    });
  } catch (error) {
    redirect(`${path}?error=${encodeURIComponent(message(error))}`);
  }

  revalidatePath(path);
  redirect(`${path}?success=revoked`);
}
