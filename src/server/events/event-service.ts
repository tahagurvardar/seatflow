import type { PrismaClient } from "@/generated/prisma/client";
import {
  canArchiveEvent,
  canCancelEvent,
  canEditEvent,
  canPublishEvent,
  canRestoreEvent,
} from "@/features/events/lifecycle";
import {
  createEventSlug,
  createPublicEventSlug,
  eventInputSchema,
  type EventInput,
} from "@/features/events/schema";
import {
  findAuthorizedEvent,
  findAuthorizedOrganizerOrganization,
} from "@/server/authorization/event-resources";
import { withSerializableRetry } from "@/server/database/serializable-transaction";
import {
  EventAuthorizationError,
  EventConflictError,
  EventLifecycleError,
  EventValidationError,
  isPrismaUniqueConstraintError,
} from "@/server/events/errors";
import {
  eventSessionDetailInclude,
  getSessionPricingCoverage,
} from "@/server/events/event-session-service";

interface OrganizerScope {
  userId: string;
  organizationSlug: string;
}

interface EventScope extends OrganizerScope {
  eventSlug: string;
}

export async function createEvent(
  database: PrismaClient,
  scope: OrganizerScope,
  rawInput: EventInput,
) {
  const membership = await findAuthorizedOrganizerOrganization(database, {
    ...scope,
    minimumRole: "ADMIN",
  });
  if (!membership) throw new EventAuthorizationError();

  const input = eventInputSchema.parse(rawInput);
  const slug = input.slug ?? createEventSlug(input.title);

  try {
    return await database.event.create({
      data: {
        organizerOrganizationId: membership.organizationId,
        title: input.title,
        slug,
        publicSlug: createPublicEventSlug(membership.organization.slug, slug),
        shortDescription: input.shortDescription,
        description: input.description,
        category: input.category,
        imagePath: input.imagePath,
      },
    });
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      throw new EventConflictError(
        "An event in this organizer workspace already uses that slug.",
      );
    }
    throw error;
  }
}

export async function updateEvent(
  database: PrismaClient,
  scope: EventScope,
  rawInput: EventInput,
) {
  const access = await findAuthorizedEvent(database, {
    ...scope,
    minimumRole: "ADMIN",
  });
  if (!access) throw new EventAuthorizationError();
  if (!canEditEvent(access.event.status)) {
    throw new EventLifecycleError("Only draft event content can be edited.");
  }

  const input = eventInputSchema.parse(rawInput);
  const slug = input.slug ?? createEventSlug(input.title);

  try {
    return await database.event.update({
      where: { id: access.event.id },
      data: {
        title: input.title,
        slug,
        publicSlug: createPublicEventSlug(
          access.membership.organization.slug,
          slug,
        ),
        shortDescription: input.shortDescription,
        description: input.description,
        category: input.category,
        imagePath: input.imagePath,
      },
    });
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      throw new EventConflictError(
        "An event in this organizer workspace already uses that slug.",
      );
    }
    throw error;
  }
}

export async function publishEvent(database: PrismaClient, scope: EventScope) {
  const access = await findAuthorizedEvent(database, {
    ...scope,
    minimumRole: "ADMIN",
  });
  if (!access) throw new EventAuthorizationError();
  if (!canPublishEvent(access.event.status)) {
    throw new EventLifecycleError("This event cannot be published from its current state.");
  }

  return withSerializableRetry(database, async (transaction) => {
    const event = await transaction.event.findFirst({
      where: {
        id: access.event.id,
        organizerOrganizationId: access.membership.organizationId,
      },
    });
    if (!event) throw new EventAuthorizationError();
    if (event.status === "PUBLISHED") return event;
    if (event.status !== "DRAFT") {
      throw new EventLifecycleError("This event cannot be published from its current state.");
    }

    const now = new Date();
    const eligibleSessions = await transaction.eventSession.findMany({
      where: {
        eventId: event.id,
        publishedAt: { not: null },
        status: { in: ["SCHEDULED", "ON_SALE", "SALES_PAUSED"] },
        startAt: { gt: now },
      },
      include: eventSessionDetailInclude,
    });
    const hasValidSession = eligibleSessions.some((eventSession) => {
      const coverage = getSessionPricingCoverage(eventSession);
      return (
        coverage.issues.length === 0 &&
        coverage.totalSellable > 0 &&
        eventSession.priceTiers.length > 0
      );
    });
    if (!hasValidSession) {
      throw new EventValidationError([
        "Publish at least one future session with complete pricing before publishing the event.",
      ]);
    }

    return transaction.event.update({
      where: { id: event.id },
      data: { status: "PUBLISHED", publishedAt: now },
    });
  });
}

export async function cancelEvent(database: PrismaClient, scope: EventScope) {
  const access = await findAuthorizedEvent(database, {
    ...scope,
    minimumRole: "ADMIN",
  });
  if (!access) throw new EventAuthorizationError();
  if (access.event.status === "CANCELLED") return access.event;
  if (!canCancelEvent(access.event.status)) {
    throw new EventLifecycleError("This event cannot be cancelled from its current state.");
  }

  return withSerializableRetry(database, async (transaction) => {
    const event = await transaction.event.findFirst({
      where: {
        id: access.event.id,
        organizerOrganizationId: access.membership.organizationId,
      },
    });
    if (!event) throw new EventAuthorizationError();
    if (event.status === "CANCELLED") return event;
    if (!canCancelEvent(event.status)) {
      throw new EventLifecycleError("This event cannot be cancelled from its current state.");
    }

    const cancelledAt = new Date();
    await transaction.eventSession.updateMany({
      where: {
        eventId: event.id,
        status: { notIn: ["CANCELLED", "COMPLETED"] },
      },
      data: { status: "CANCELLED", cancelledAt },
    });

    return transaction.event.update({
      where: { id: event.id },
      data: { status: "CANCELLED", cancelledAt },
    });
  });
}

export async function archiveEvent(database: PrismaClient, scope: EventScope) {
  const access = await findAuthorizedEvent(database, {
    ...scope,
    minimumRole: "ADMIN",
  });
  if (!access) throw new EventAuthorizationError();
  if (access.event.status === "ARCHIVED") return access.event;
  if (!canArchiveEvent(access.event.status)) {
    throw new EventLifecycleError("This event cannot be archived.");
  }

  return database.event.update({
    where: { id: access.event.id },
    data: {
      preArchiveStatus: access.event.status,
      status: "ARCHIVED",
      archivedAt: new Date(),
    },
  });
}

export async function restoreEvent(database: PrismaClient, scope: EventScope) {
  const access = await findAuthorizedEvent(database, {
    ...scope,
    minimumRole: "ADMIN",
  });
  if (!access) throw new EventAuthorizationError();
  if (!canRestoreEvent(access.event.status, access.event.preArchiveStatus)) {
    throw new EventLifecycleError(
      "Only events archived from draft or published state can be restored.",
    );
  }

  const restoreStatus = access.event.preArchiveStatus;
  if (restoreStatus !== "DRAFT" && restoreStatus !== "PUBLISHED") {
    throw new EventLifecycleError("This archived event is not eligible for restore.");
  }

  return database.event.update({
    where: { id: access.event.id },
    data: {
      status: restoreStatus,
      preArchiveStatus: null,
      archivedAt: null,
    },
  });
}

export async function deleteEmptyDraftEvent(
  database: PrismaClient,
  scope: EventScope,
) {
  const access = await findAuthorizedEvent(database, {
    ...scope,
    minimumRole: "ADMIN",
  });
  if (!access) throw new EventAuthorizationError();
  if (access.event.status !== "DRAFT") {
    throw new EventLifecycleError("Only an empty draft event can be deleted.");
  }

  const sessionCount = await database.eventSession.count({
    where: { eventId: access.event.id },
  });
  if (sessionCount > 0) {
    throw new EventLifecycleError("Remove draft sessions before deleting this draft event.");
  }

  return database.event.delete({ where: { id: access.event.id } });
}
