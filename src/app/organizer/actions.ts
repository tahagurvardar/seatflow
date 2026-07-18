"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { ROUTES } from "@/config/site";
import { parsePriceToMinorUnits } from "@/features/events/money";
import {
  eventInputSchema,
  eventSessionInputSchema,
  lifecycleConfirmationSchema,
  priceTierFormSchema,
} from "@/features/events/schema";
import { requireAuth } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";
import {
  archiveEvent,
  cancelEvent,
  createEvent,
  deleteEmptyDraftEvent,
  publishEvent,
  restoreEvent,
  updateEvent,
} from "@/server/events/event-service";
import {
  cancelEventSession,
  createEventSession,
  pauseEventSessionSales,
  publishEventSession,
  resumeEventSessionSales,
  updateDraftEventSession,
} from "@/server/events/event-session-service";
import {
  EventAuthorizationError,
  EventConflictError,
  EventLifecycleError,
  EventValidationError,
} from "@/server/events/errors";
import {
  assignSessionSectionPricing,
  createSessionPriceTier,
  deleteUnusedSessionPriceTier,
  moveSessionPriceTier,
  updateSessionPriceTier,
} from "@/server/events/pricing-service";

export interface OrganizerActionState {
  fieldErrors?: Record<string, string>;
  message?: string;
}

export interface OrganizerEventScope {
  organizationSlug: string;
  eventSlug: string;
}

export interface OrganizerSessionScope extends OrganizerEventScope {
  sessionId: string;
}

function zodFieldErrors(error: z.ZodError) {
  return error.issues.reduce<Record<string, string>>((errors, issue) => {
    const field = issue.path[0];
    if (typeof field === "string" && !errors[field]) errors[field] = issue.message;
    return errors;
  }, {});
}

function errorMessage(error: unknown) {
  if (error instanceof EventValidationError) return error.issues.join(" ");
  if (
    error instanceof EventAuthorizationError ||
    error instanceof EventConflictError ||
    error instanceof EventLifecycleError
  ) {
    return error.message;
  }
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Check the submitted values.";
  }
  if (error instanceof Error && error.message.startsWith("Enter a non-negative")) {
    return error.message;
  }
  return "SeatFlow could not save that change. Please try again.";
}

function eventValues(formData: FormData) {
  return {
    title: formData.get("title"),
    slug: formData.get("slug"),
    shortDescription: formData.get("shortDescription"),
    description: formData.get("description"),
    category: formData.get("category"),
    imagePath: formData.get("imagePath"),
  };
}

function sessionValues(formData: FormData) {
  return {
    venueId: formData.get("venueId"),
    spaceId: formData.get("spaceId"),
    seatMapId: formData.get("seatMapId"),
    startLocal: formData.get("startLocal"),
    endLocal: formData.get("endLocal"),
    salesStartLocal: formData.get("salesStartLocal"),
    salesEndLocal: formData.get("salesEndLocal"),
  };
}

function requiredString(formData: FormData, name: string) {
  const value = formData.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new EventValidationError([`${name} is required.`]);
  }
  return value;
}

export async function createEventAction(
  organizationSlug: string,
  _state: OrganizerActionState,
  formData: FormData,
): Promise<OrganizerActionState> {
  const path = ROUTES.organizerNewEvent(organizationSlug);
  const session = await requireAuth(path);
  const parsed = eventInputSchema.safeParse(eventValues(formData));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error) };

  let event;
  try {
    event = await createEvent(
      getDatabase(),
      { userId: session.user.id, organizationSlug },
      parsed.data,
    );
  } catch (error) {
    return { message: errorMessage(error) };
  }

  revalidatePath(ROUTES.organizerEvents(organizationSlug));
  redirect(ROUTES.organizerEvent(organizationSlug, event.slug));
}

export async function updateEventAction(
  scope: OrganizerEventScope,
  _state: OrganizerActionState,
  formData: FormData,
): Promise<OrganizerActionState> {
  const path = ROUTES.organizerEventEdit(scope.organizationSlug, scope.eventSlug);
  const session = await requireAuth(path);
  const parsed = eventInputSchema.safeParse(eventValues(formData));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error) };

  let event;
  try {
    event = await updateEvent(
      getDatabase(),
      { userId: session.user.id, ...scope },
      parsed.data,
    );
  } catch (error) {
    return { message: errorMessage(error) };
  }

  revalidatePath(ROUTES.organizerEvents(scope.organizationSlug));
  redirect(ROUTES.organizerEvent(scope.organizationSlug, event.slug));
}

export async function eventLifecycleAction(
  scope: OrganizerEventScope,
  formData: FormData,
) {
  const path = ROUTES.organizerEvent(scope.organizationSlug, scope.eventSlug);
  const session = await requireAuth(path);
  const transition = lifecycleConfirmationSchema.safeParse({
    intent: formData.get("intent"),
    confirmation: formData.get("confirmation"),
  });
  if (!transition.success) {
    redirect(`${path}?error=${encodeURIComponent(errorMessage(transition.error))}`);
  }
  const { intent } = transition.data;

  let deleted = false;
  try {
    const serviceScope = { userId: session.user.id, ...scope };
    switch (intent) {
      case "publish":
        await publishEvent(getDatabase(), serviceScope);
        break;
      case "cancel":
        await cancelEvent(getDatabase(), serviceScope);
        break;
      case "archive":
        await archiveEvent(getDatabase(), serviceScope);
        break;
      case "restore":
        await restoreEvent(getDatabase(), serviceScope);
        break;
      case "delete":
        await deleteEmptyDraftEvent(getDatabase(), serviceScope);
        deleted = true;
        break;
      default:
        throw new EventLifecycleError("Unknown event lifecycle operation.");
    }
  } catch (error) {
    redirect(`${path}?error=${encodeURIComponent(errorMessage(error))}`);
  }

  if (deleted) {
    revalidatePath(ROUTES.organizerEvents(scope.organizationSlug));
    redirect(ROUTES.organizerEvents(scope.organizationSlug));
  }

  revalidatePath(path);
  revalidatePath(ROUTES.events);
  redirect(`${path}?success=${encodeURIComponent(intent)}`);
}

export async function createSessionAction(
  scope: OrganizerEventScope,
  _state: OrganizerActionState,
  formData: FormData,
): Promise<OrganizerActionState> {
  const path = ROUTES.organizerNewSession(scope.organizationSlug, scope.eventSlug);
  const session = await requireAuth(path);
  const parsed = eventSessionInputSchema.safeParse(sessionValues(formData));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error) };

  let created;
  try {
    created = await createEventSession(
      getDatabase(),
      { userId: session.user.id, ...scope },
      parsed.data,
    );
  } catch (error) {
    return { message: errorMessage(error) };
  }

  revalidatePath(ROUTES.organizerEventSessions(scope.organizationSlug, scope.eventSlug));
  redirect(
    ROUTES.organizerSession(
      scope.organizationSlug,
      scope.eventSlug,
      created.id,
    ),
  );
}

export async function updateSessionAction(
  scope: OrganizerSessionScope,
  _state: OrganizerActionState,
  formData: FormData,
): Promise<OrganizerActionState> {
  const path = ROUTES.organizerSessionEdit(
    scope.organizationSlug,
    scope.eventSlug,
    scope.sessionId,
  );
  const session = await requireAuth(path);
  const parsed = eventSessionInputSchema.safeParse(sessionValues(formData));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error) };

  try {
    await updateDraftEventSession(
      getDatabase(),
      { userId: session.user.id, ...scope },
      parsed.data,
    );
  } catch (error) {
    return { message: errorMessage(error) };
  }

  const destination = ROUTES.organizerSession(
    scope.organizationSlug,
    scope.eventSlug,
    scope.sessionId,
  );
  revalidatePath(destination);
  redirect(destination);
}

export async function sessionLifecycleAction(
  scope: OrganizerSessionScope,
  formData: FormData,
) {
  const path = ROUTES.organizerSession(
    scope.organizationSlug,
    scope.eventSlug,
    scope.sessionId,
  );
  const session = await requireAuth(path);
  const transition = lifecycleConfirmationSchema.safeParse({
    intent: formData.get("intent"),
    confirmation: formData.get("confirmation"),
  });
  if (!transition.success) {
    redirect(`${path}?error=${encodeURIComponent(errorMessage(transition.error))}`);
  }
  const { intent } = transition.data;

  try {
    const serviceScope = { userId: session.user.id, ...scope };
    switch (intent) {
      case "publish":
        await publishEventSession(getDatabase(), serviceScope);
        break;
      case "pause":
        await pauseEventSessionSales(getDatabase(), serviceScope);
        break;
      case "resume":
        await resumeEventSessionSales(getDatabase(), serviceScope);
        break;
      case "cancel":
        await cancelEventSession(getDatabase(), serviceScope);
        break;
      default:
        throw new EventLifecycleError("Unknown session lifecycle operation.");
    }
  } catch (error) {
    redirect(`${path}?error=${encodeURIComponent(errorMessage(error))}`);
  }

  revalidatePath(path);
  revalidatePath(ROUTES.events);
  redirect(`${path}?success=${encodeURIComponent(intent)}`);
}

export async function sessionPricingAction(
  scope: OrganizerSessionScope,
  formData: FormData,
) {
  const path = ROUTES.organizerSessionPricing(
    scope.organizationSlug,
    scope.eventSlug,
    scope.sessionId,
  );
  const session = await requireAuth(path);
  const intent = requiredString(formData, "intent");
  const serviceScope = { userId: session.user.id, ...scope };

  try {
    if (intent === "assign-sections") {
      const assignments = [...formData.entries()]
        .filter(
          ([name, value]) =>
            name.startsWith("section:") && typeof value === "string" && value.length > 0,
        )
        .map(([name, value]) => ({
          sectionId: name.slice("section:".length),
          priceTierId: String(value),
        }));
      await assignSessionSectionPricing(getDatabase(), serviceScope, { assignments });
    } else if (intent === "delete-tier") {
      if (formData.get("confirmation") !== "delete") {
        throw new EventLifecycleError("Confirm deletion before removing the tier.");
      }
      await deleteUnusedSessionPriceTier(getDatabase(), {
        ...serviceScope,
        priceTierId: requiredString(formData, "priceTierId"),
      });
    } else if (intent === "move-tier") {
      const direction = requiredString(formData, "direction");
      if (direction !== "up" && direction !== "down") {
        throw new EventValidationError(["Choose a valid tier direction."]);
      }
      await moveSessionPriceTier(getDatabase(), {
        ...serviceScope,
        priceTierId: requiredString(formData, "priceTierId"),
        direction,
      });
    } else if (intent === "create-tier" || intent === "update-tier") {
      const parsed = priceTierFormSchema.parse({
        name: formData.get("name"),
        code: formData.get("code"),
        price: formData.get("price"),
        currency: formData.get("currency"),
        description: formData.get("description"),
      });
      const tierInput = {
        name: parsed.name,
        code: parsed.code,
        priceMinor: parsePriceToMinorUnits(parsed.price, parsed.currency),
        currency: parsed.currency,
        description: parsed.description,
      };
      if (intent === "create-tier") {
        await createSessionPriceTier(getDatabase(), serviceScope, tierInput);
      } else {
        await updateSessionPriceTier(
          getDatabase(),
          {
            ...serviceScope,
            priceTierId: requiredString(formData, "priceTierId"),
          },
          tierInput,
        );
      }
    } else {
      throw new EventLifecycleError("Unknown pricing operation.");
    }
  } catch (error) {
    redirect(`${path}?error=${encodeURIComponent(errorMessage(error))}`);
  }

  revalidatePath(path);
  revalidatePath(
    ROUTES.organizerSession(scope.organizationSlug, scope.eventSlug, scope.sessionId),
  );
  redirect(`${path}?success=saved`);
}
