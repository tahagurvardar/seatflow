"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { ROUTES } from "@/config/site";
import { organizationOnboardingSchema } from "@/features/organizations/schema";
import {
  bulkSeatGenerationSchema,
  rowInputSchema,
  seatInputSchema,
  seatMapInputSchema,
  sectionInputSchema,
} from "@/features/seat-maps/schema";
import { spaceInputSchema, venueInputSchema } from "@/features/venues/schema";
import { requireAuth } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";
import {
  bulkGenerateRows,
  clonePublishedSeatMap,
  createDraftSeatMap,
  createRow,
  createSeat,
  createSection,
  deleteRow,
  deleteSeat,
  deleteSection,
  moveRow,
  moveSection,
  publishSeatMap,
  updateDraftSeatMap,
  updateRow,
  updateSeat,
  updateSection,
} from "@/server/seat-maps/seat-map-service";
import { createVenueOperatorOrganization } from "@/server/organizations/create-venue-operator-organization";
import { OrganizationSlugConflictError } from "@/server/organizations/create-organization-with-owner";
import {
  archiveSpace,
  createSpace,
  restoreSpace,
  updateSpace,
} from "@/server/venues/space-service";
import {
  SeatMapValidationError,
  VenueManagementAuthorizationError,
  VenueManagementConflictError,
  VenueManagementLifecycleError,
} from "@/server/venues/errors";
import {
  archiveVenue,
  createVenue,
  restoreVenue,
  updateVenue,
} from "@/server/venues/venue-service";

export interface ManagementActionState {
  fieldErrors?: Record<string, string>;
  message?: string;
}

export interface VenueScope {
  organizationSlug: string;
  venueSlug: string;
}

export interface SpaceScope extends VenueScope {
  spaceSlug: string;
}

export interface MapScope extends SpaceScope {
  seatMapId: string;
  version: number;
}

function fieldErrors(error: z.ZodError) {
  return error.issues.reduce<Record<string, string>>((errors, issue) => {
    const field = issue.path[0];
    if (typeof field === "string" && !errors[field]) errors[field] = issue.message;
    return errors;
  }, {});
}

function errorMessage(error: unknown) {
  if (error instanceof SeatMapValidationError) return error.issues.join(" ");
  if (
    error instanceof VenueManagementAuthorizationError ||
    error instanceof VenueManagementConflictError ||
    error instanceof VenueManagementLifecycleError
  ) {
    return error.message;
  }
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Check the submitted values.";
  return "SeatFlow could not save that change. Please try again.";
}

function stringValue(formData: FormData, name: string) {
  const value = formData.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new z.ZodError([
      { code: "custom", path: [name], message: `${name} is required.` },
    ]);
  }
  return value;
}

function venueValues(formData: FormData) {
  return {
    name: formData.get("name"),
    slug: formData.get("slug"),
    description: formData.get("description"),
    addressLine1: formData.get("addressLine1"),
    addressLine2: formData.get("addressLine2"),
    city: formData.get("city"),
    countryCode: formData.get("countryCode"),
    postalCode: formData.get("postalCode"),
    timeZone: formData.get("timeZone"),
    status: formData.get("status"),
  };
}

function spaceValues(formData: FormData) {
  return {
    name: formData.get("name"),
    slug: formData.get("slug"),
    description: formData.get("description"),
    type: formData.get("type"),
    status: formData.get("status"),
  };
}

export async function createVenueOperatorOrganizationAction(
  _state: ManagementActionState,
  formData: FormData,
): Promise<ManagementActionState> {
  const session = await requireAuth(ROUTES.venueOperatorOnboarding);
  const parsed = organizationOnboardingSchema.safeParse({ name: formData.get("name") });

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  let organization;
  try {
    organization = await createVenueOperatorOrganization(getDatabase(), {
      userId: session.user.id,
      name: parsed.data.name,
    });
  } catch (error) {
    if (error instanceof OrganizationSlugConflictError) {
      return { fieldErrors: { name: "That organization name is already in use." } };
    }
    return { message: "SeatFlow could not create the venue-operator workspace." };
  }

  revalidatePath(ROUTES.customerDashboard);
  revalidatePath(ROUTES.venueOperatorDashboard);
  redirect(ROUTES.venueOperatorVenues(organization.slug));
}

export async function createVenueAction(
  organizationSlug: string,
  _state: ManagementActionState,
  formData: FormData,
): Promise<ManagementActionState> {
  const path = ROUTES.venueOperatorNewVenue(organizationSlug);
  const session = await requireAuth(path);
  const parsed = venueInputSchema.safeParse(venueValues(formData));

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  let venue;
  try {
    venue = await createVenue(
      getDatabase(),
      { userId: session.user.id, organizationSlug },
      parsed.data,
    );
  } catch (error) {
    return { message: errorMessage(error) };
  }

  revalidatePath(ROUTES.venueOperatorVenues(organizationSlug));
  redirect(ROUTES.venueOperatorVenue(organizationSlug, venue.slug));
}

export async function updateVenueAction(
  scope: VenueScope,
  _state: ManagementActionState,
  formData: FormData,
): Promise<ManagementActionState> {
  const path = ROUTES.venueOperatorVenueEdit(scope.organizationSlug, scope.venueSlug);
  const session = await requireAuth(path);
  const parsed = venueInputSchema.safeParse(venueValues(formData));

  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  let venue;
  try {
    venue = await updateVenue(getDatabase(), { userId: session.user.id, ...scope }, parsed.data);
  } catch (error) {
    return { message: errorMessage(error) };
  }

  revalidatePath(ROUTES.venueOperatorVenues(scope.organizationSlug));
  redirect(ROUTES.venueOperatorVenue(scope.organizationSlug, venue.slug));
}

export async function archiveVenueAction(scope: VenueScope, formData: FormData) {
  const path = ROUTES.venueOperatorVenue(scope.organizationSlug, scope.venueSlug);
  const session = await requireAuth(path);
  if (formData.get("confirmation") !== "archive") {
    redirect(`${path}?error=${encodeURIComponent("Confirm the venue archive operation.")}`);
  }

  try {
    await archiveVenue(getDatabase(), { userId: session.user.id, ...scope });
  } catch (error) {
    redirect(`${path}?error=${encodeURIComponent(errorMessage(error))}`);
  }

  revalidatePath(path);
  revalidatePath(ROUTES.venueOperatorVenues(scope.organizationSlug));
  redirect(`${path}?success=archived`);
}

export async function restoreVenueAction(scope: VenueScope) {
  const path = ROUTES.venueOperatorVenue(scope.organizationSlug, scope.venueSlug);
  const session = await requireAuth(path);
  try {
    await restoreVenue(getDatabase(), { userId: session.user.id, ...scope });
  } catch (error) {
    redirect(`${path}?error=${encodeURIComponent(errorMessage(error))}`);
  }
  revalidatePath(path);
  revalidatePath(ROUTES.venueOperatorVenues(scope.organizationSlug));
  redirect(`${path}?success=restored`);
}

export async function createSpaceAction(
  scope: VenueScope,
  _state: ManagementActionState,
  formData: FormData,
): Promise<ManagementActionState> {
  const path = ROUTES.venueOperatorNewSpace(scope.organizationSlug, scope.venueSlug);
  const session = await requireAuth(path);
  const parsed = spaceInputSchema.safeParse(spaceValues(formData));
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  let space;
  try {
    space = await createSpace(getDatabase(), { userId: session.user.id, ...scope }, parsed.data);
  } catch (error) {
    return { message: errorMessage(error) };
  }

  revalidatePath(ROUTES.venueOperatorVenue(scope.organizationSlug, scope.venueSlug));
  redirect(ROUTES.venueOperatorSpace(scope.organizationSlug, scope.venueSlug, space.slug));
}

export async function updateSpaceAction(
  scope: SpaceScope,
  _state: ManagementActionState,
  formData: FormData,
): Promise<ManagementActionState> {
  const path = ROUTES.venueOperatorSpaceEdit(scope.organizationSlug, scope.venueSlug, scope.spaceSlug);
  const session = await requireAuth(path);
  const parsed = spaceInputSchema.safeParse(spaceValues(formData));
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  let space;
  try {
    space = await updateSpace(getDatabase(), { userId: session.user.id, ...scope }, parsed.data);
  } catch (error) {
    return { message: errorMessage(error) };
  }

  revalidatePath(ROUTES.venueOperatorVenue(scope.organizationSlug, scope.venueSlug));
  redirect(ROUTES.venueOperatorSpace(scope.organizationSlug, scope.venueSlug, space.slug));
}

export async function archiveSpaceAction(scope: SpaceScope, formData: FormData) {
  const path = ROUTES.venueOperatorSpace(scope.organizationSlug, scope.venueSlug, scope.spaceSlug);
  const session = await requireAuth(path);
  if (formData.get("confirmation") !== "archive") {
    redirect(`${path}?error=${encodeURIComponent("Confirm the space archive operation.")}`);
  }
  try {
    await archiveSpace(getDatabase(), { userId: session.user.id, ...scope });
  } catch (error) {
    redirect(`${path}?error=${encodeURIComponent(errorMessage(error))}`);
  }
  revalidatePath(path);
  redirect(`${path}?success=archived`);
}

export async function restoreSpaceAction(scope: SpaceScope) {
  const path = ROUTES.venueOperatorSpace(scope.organizationSlug, scope.venueSlug, scope.spaceSlug);
  const session = await requireAuth(path);
  try {
    await restoreSpace(getDatabase(), { userId: session.user.id, ...scope });
  } catch (error) {
    redirect(`${path}?error=${encodeURIComponent(errorMessage(error))}`);
  }
  revalidatePath(path);
  redirect(`${path}?success=restored`);
}

export async function createSeatMapAction(
  scope: SpaceScope,
  _state: ManagementActionState,
  formData: FormData,
): Promise<ManagementActionState> {
  const path = ROUTES.venueOperatorNewSeatMap(scope.organizationSlug, scope.venueSlug, scope.spaceSlug);
  const session = await requireAuth(path);
  const parsed = seatMapInputSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  let seatMap;
  try {
    seatMap = await createDraftSeatMap(getDatabase(), { userId: session.user.id, ...scope }, parsed.data);
  } catch (error) {
    return { message: errorMessage(error) };
  }

  revalidatePath(ROUTES.venueOperatorSpace(scope.organizationSlug, scope.venueSlug, scope.spaceSlug));
  redirect(
    ROUTES.venueOperatorSeatMap(
      scope.organizationSlug,
      scope.venueSlug,
      scope.spaceSlug,
      seatMap.version,
    ),
  );
}

export async function seatMapEditorAction(scope: MapScope, formData: FormData) {
  const path = ROUTES.venueOperatorSeatMap(
    scope.organizationSlug,
    scope.venueSlug,
    scope.spaceSlug,
    scope.version,
  );
  const session = await requireAuth(path);
  const databaseScope = { userId: session.user.id, ...scope };

  try {
    const intent = stringValue(formData, "intent");
    switch (intent) {
      case "update-map":
        await updateDraftSeatMap(getDatabase(), databaseScope, {
          name: stringValue(formData, "name"),
        });
        break;
      case "create-section":
        await createSection(getDatabase(), databaseScope, sectionInputSchema.parse({
          name: formData.get("name"),
          code: formData.get("code"),
        }));
        break;
      case "update-section":
        await updateSection(
          getDatabase(),
          { ...databaseScope, sectionId: stringValue(formData, "sectionId") },
          sectionInputSchema.parse({ name: formData.get("name"), code: formData.get("code") }),
        );
        break;
      case "delete-section":
        if (formData.get("confirmation") !== "delete") {
          throw new VenueManagementLifecycleError("Confirm deletion before removing the section.");
        }
        await deleteSection(getDatabase(), {
          ...databaseScope,
          sectionId: stringValue(formData, "sectionId"),
        });
        break;
      case "create-row":
        await createRow(
          getDatabase(),
          { ...databaseScope, sectionId: stringValue(formData, "sectionId") },
          rowInputSchema.parse({ label: formData.get("label") }),
        );
        break;
      case "update-row":
        await updateRow(
          getDatabase(),
          {
            ...databaseScope,
            sectionId: stringValue(formData, "sectionId"),
            rowId: stringValue(formData, "rowId"),
          },
          rowInputSchema.parse({ label: formData.get("label") }),
        );
        break;
      case "delete-row":
        if (formData.get("confirmation") !== "delete") {
          throw new VenueManagementLifecycleError("Confirm deletion before removing the row.");
        }
        await deleteRow(getDatabase(), {
          ...databaseScope,
          sectionId: stringValue(formData, "sectionId"),
          rowId: stringValue(formData, "rowId"),
        });
        break;
      case "create-seat":
        await createSeat(
          getDatabase(),
          {
            ...databaseScope,
            sectionId: stringValue(formData, "sectionId"),
            rowId: stringValue(formData, "rowId"),
          },
          seatInputSchema.parse({
            label: formData.get("label"),
            x: formData.get("x"),
            y: formData.get("y"),
            type: formData.get("type"),
            state: formData.get("state"),
          }),
        );
        break;
      case "update-seat":
        await updateSeat(
          getDatabase(),
          {
            ...databaseScope,
            sectionId: stringValue(formData, "sectionId"),
            rowId: stringValue(formData, "rowId"),
            seatId: stringValue(formData, "seatId"),
          },
          seatInputSchema.parse({
            label: formData.get("label"),
            x: formData.get("x"),
            y: formData.get("y"),
            type: formData.get("type"),
            state: formData.get("state"),
          }),
        );
        break;
      case "delete-seat":
        if (formData.get("confirmation") !== "delete") {
          throw new VenueManagementLifecycleError("Confirm deletion before removing the seat.");
        }
        await deleteSeat(getDatabase(), {
          ...databaseScope,
          sectionId: stringValue(formData, "sectionId"),
          rowId: stringValue(formData, "rowId"),
          seatId: stringValue(formData, "seatId"),
        });
        break;
      case "bulk-generate":
        await bulkGenerateRows(
          getDatabase(),
          { ...databaseScope, sectionId: stringValue(formData, "sectionId") },
          bulkSeatGenerationSchema.parse({
            startRowLabel: formData.get("startRowLabel"),
            rowCount: formData.get("rowCount"),
            seatsPerRow: formData.get("seatsPerRow"),
            startSeatNumber: formData.get("startSeatNumber"),
            horizontalSpacing: formData.get("horizontalSpacing"),
            verticalSpacing: formData.get("verticalSpacing"),
          }),
        );
        break;
      case "move-section":
        await moveSection(getDatabase(), {
          ...databaseScope,
          sectionId: stringValue(formData, "sectionId"),
          direction: stringValue(formData, "direction") as "up" | "down",
        });
        break;
      case "move-row":
        await moveRow(getDatabase(), {
          ...databaseScope,
          sectionId: stringValue(formData, "sectionId"),
          rowId: stringValue(formData, "rowId"),
          direction: stringValue(formData, "direction") as "up" | "down",
        });
        break;
      default:
        throw new VenueManagementLifecycleError("Unknown seat-map editor operation.");
    }
  } catch (error) {
    redirect(`${path}?error=${encodeURIComponent(errorMessage(error))}`);
  }

  revalidatePath(path);
  redirect(`${path}?success=saved`);
}

export async function publishSeatMapAction(scope: MapScope, formData: FormData) {
  const path = ROUTES.venueOperatorSeatMap(
    scope.organizationSlug,
    scope.venueSlug,
    scope.spaceSlug,
    scope.version,
  );
  const session = await requireAuth(path);
  if (formData.get("confirmation") !== "publish") {
    redirect(`${path}?error=${encodeURIComponent("Confirm publication before continuing.")}`);
  }
  try {
    await publishSeatMap(getDatabase(), { userId: session.user.id, ...scope });
  } catch (error) {
    redirect(`${path}?error=${encodeURIComponent(errorMessage(error))}`);
  }
  revalidatePath(path);
  revalidatePath(ROUTES.venueOperatorSpace(scope.organizationSlug, scope.venueSlug, scope.spaceSlug));
  redirect(`${path}?success=published`);
}

export async function cloneSeatMapAction(scope: MapScope) {
  const path = ROUTES.venueOperatorSeatMap(
    scope.organizationSlug,
    scope.venueSlug,
    scope.spaceSlug,
    scope.version,
  );
  const session = await requireAuth(path);
  let clone;
  try {
    clone = await clonePublishedSeatMap(getDatabase(), { userId: session.user.id, ...scope });
  } catch (error) {
    redirect(`${path}?error=${encodeURIComponent(errorMessage(error))}`);
  }
  revalidatePath(ROUTES.venueOperatorSpace(scope.organizationSlug, scope.venueSlug, scope.spaceSlug));
  redirect(
    ROUTES.venueOperatorSeatMap(
      scope.organizationSlug,
      scope.venueSlug,
      scope.spaceSlug,
      clone.version,
    ),
  );
}
