"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { ROUTES } from "@/config/site";
import { requireAuth } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";
import {
  HoldAuthenticationError,
  HoldAuthorizationError,
  HoldConflictError,
  HoldEligibilityError,
  HoldValidationError,
} from "@/server/holds/errors";
import { acquireSeatHold, releaseSeatHold } from "@/server/holds/hold-service";

export interface HoldActionState {
  message?: string;
}

function holdErrorMessage(error: unknown) {
  if (error instanceof HoldValidationError) return error.issues.join(" ");
  if (
    error instanceof HoldConflictError ||
    error instanceof HoldEligibilityError ||
    error instanceof HoldAuthorizationError ||
    error instanceof HoldAuthenticationError
  ) {
    return error.message;
  }
  return "SeatFlow could not complete that request. Availability may have changed — please refresh and try again.";
}

interface SeatSelectionScope {
  publicSlug: string;
  sessionId: string;
}

export async function createHoldAction(
  scope: SeatSelectionScope,
  _state: HoldActionState,
  formData: FormData,
): Promise<HoldActionState> {
  const seatsPath = ROUTES.eventSessionSeats(scope.publicSlug, scope.sessionId);
  const session = await requireAuth(seatsPath);

  const seatIds = formData.getAll("seatIds").map((value) => String(value));
  const idempotencyKey = String(formData.get("idempotencyKey") ?? "");

  let publicToken: string;
  try {
    const { hold } = await acquireSeatHold(
      getDatabase(),
      { userId: session.user.id },
      { sessionId: scope.sessionId, seatIds, idempotencyKey },
    );
    publicToken = hold.publicToken;
  } catch (error) {
    return { message: holdErrorMessage(error) };
  }

  revalidatePath(seatsPath);
  redirect(ROUTES.customerHold(publicToken));
}

export async function releaseHoldAction(publicToken: string) {
  const holdPath = ROUTES.customerHold(publicToken);
  const session = await requireAuth(holdPath);

  try {
    await releaseSeatHold(
      getDatabase(),
      { userId: session.user.id },
      { publicToken },
    );
  } catch (error) {
    redirect(`${holdPath}?error=${encodeURIComponent(holdErrorMessage(error))}`);
  }

  revalidatePath(holdPath);
  revalidatePath(ROUTES.customerDashboard);
  redirect(`${holdPath}?released=1`);
}
