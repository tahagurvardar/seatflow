import type { PrismaClient } from "@/generated/prisma/client";
import type { EventStatus } from "@/generated/prisma/enums";
import { canEditSessionPricing } from "@/features/events/lifecycle";
import {
  priceTierInputSchema,
  sectionPricingInputSchema,
  type PriceTierInput,
  type SectionPricingInput,
} from "@/features/events/schema";
import {
  findAuthorizedEventSession,
  findAuthorizedPriceTier,
} from "@/server/authorization/event-resources";
import { withSerializableRetry } from "@/server/database/serializable-transaction";
import {
  EventAuthorizationError,
  EventConflictError,
  EventLifecycleError,
  EventValidationError,
  isPrismaUniqueConstraintError,
} from "@/server/events/errors";

interface SessionScope {
  userId: string;
  organizationSlug: string;
  eventSlug: string;
  sessionId: string;
}

function assertDraftPricing(status: Parameters<typeof canEditSessionPricing>[0]) {
  if (!canEditSessionPricing(status)) {
    throw new EventLifecycleError("Pricing can only be changed on a draft session.");
  }
}

function assertEventAllowsPricing(status: EventStatus) {
  if (!["DRAFT", "PUBLISHED"].includes(status)) {
    throw new EventLifecycleError(
      "Restore an archived event before changing session pricing.",
    );
  }
}

export async function createSessionPriceTier(
  database: PrismaClient,
  scope: SessionScope,
  rawInput: PriceTierInput,
) {
  const access = await findAuthorizedEventSession(database, {
    ...scope,
    minimumRole: "ADMIN",
  });
  if (!access) throw new EventAuthorizationError();
  assertEventAllowsPricing(access.event.status);
  assertDraftPricing(access.eventSession.status);
  const input = priceTierInputSchema.parse(rawInput);

  try {
    return await withSerializableRetry(database, async (transaction) => {
      const eventSession = await transaction.eventSession.findFirst({
        where: {
          id: access.eventSession.id,
          eventId: access.event.id,
          status: "DRAFT",
        },
      });
      if (!eventSession) {
        throw new EventLifecycleError("Pricing can only be changed on a draft session.");
      }

      const last = await transaction.sessionPriceTier.findFirst({
        where: { sessionId: eventSession.id },
        orderBy: { displayOrder: "desc" },
        select: { displayOrder: true },
      });
      return transaction.sessionPriceTier.create({
        data: {
          sessionId: eventSession.id,
          ...input,
          displayOrder: (last?.displayOrder ?? -1) + 1,
        },
      });
    });
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      throw new EventConflictError("This session already has a tier with that code.");
    }
    throw error;
  }
}

export async function updateSessionPriceTier(
  database: PrismaClient,
  scope: SessionScope & { priceTierId: string },
  rawInput: PriceTierInput,
) {
  const access = await findAuthorizedPriceTier(database, {
    ...scope,
    minimumRole: "ADMIN",
  });
  if (!access) throw new EventAuthorizationError();
  assertEventAllowsPricing(access.event.status);
  assertDraftPricing(access.eventSession.status);
  const input = priceTierInputSchema.parse(rawInput);

  try {
    return await database.sessionPriceTier.update({
      where: { id: access.priceTier.id },
      data: input,
    });
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      throw new EventConflictError("This session already has a tier with that code.");
    }
    throw error;
  }
}

export async function deleteUnusedSessionPriceTier(
  database: PrismaClient,
  scope: SessionScope & { priceTierId: string },
) {
  const access = await findAuthorizedPriceTier(database, {
    ...scope,
    minimumRole: "ADMIN",
  });
  if (!access) throw new EventAuthorizationError();
  assertEventAllowsPricing(access.event.status);
  assertDraftPricing(access.eventSession.status);

  const assignments = await database.sessionSectionPricing.count({
    where: { priceTierId: access.priceTier.id },
  });
  if (assignments > 0) {
    throw new EventLifecycleError("Unassign this tier from all sections before deleting it.");
  }

  return database.sessionPriceTier.delete({
    where: { id: access.priceTier.id },
  });
}

export async function moveSessionPriceTier(
  database: PrismaClient,
  scope: SessionScope & {
    priceTierId: string;
    direction: "up" | "down";
  },
) {
  const access = await findAuthorizedPriceTier(database, {
    ...scope,
    minimumRole: "ADMIN",
  });
  if (!access) throw new EventAuthorizationError();
  assertEventAllowsPricing(access.event.status);
  assertDraftPricing(access.eventSession.status);

  return withSerializableRetry(database, async (transaction) => {
    const tiers = await transaction.sessionPriceTier.findMany({
      where: { sessionId: access.eventSession.id },
      orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
    });
    const index = tiers.findIndex((tier) => tier.id === access.priceTier.id);
    const current = tiers[index];
    const target = tiers[scope.direction === "up" ? index - 1 : index + 1];
    if (!current || !target) return access.priceTier;

    await transaction.sessionPriceTier.update({
      where: { id: current.id },
      data: { displayOrder: target.displayOrder },
    });
    await transaction.sessionPriceTier.update({
      where: { id: target.id },
      data: { displayOrder: current.displayOrder },
    });

    return { ...current, displayOrder: target.displayOrder };
  });
}

export async function assignSessionSectionPricing(
  database: PrismaClient,
  scope: SessionScope,
  rawInput: SectionPricingInput,
) {
  const access = await findAuthorizedEventSession(database, {
    ...scope,
    minimumRole: "ADMIN",
  });
  if (!access) throw new EventAuthorizationError();
  assertEventAllowsPricing(access.event.status);
  assertDraftPricing(access.eventSession.status);
  const input = sectionPricingInputSchema.parse(rawInput);

  const sectionIds = input.assignments.map((assignment) => assignment.sectionId);
  if (new Set(sectionIds).size !== sectionIds.length) {
    throw new EventValidationError([
      "A seat-map section can be assigned only once per session.",
    ]);
  }

  return withSerializableRetry(database, async (transaction) => {
    const eventSession = await transaction.eventSession.findFirst({
      where: {
        id: access.eventSession.id,
        eventId: access.event.id,
        status: "DRAFT",
      },
      include: {
        seatMap: { include: { sections: { select: { id: true } } } },
        priceTiers: { select: { id: true } },
      },
    });
    if (!eventSession) {
      throw new EventLifecycleError("Pricing can only be changed on a draft session.");
    }

    const allowedSections = new Set(
      eventSession.seatMap.sections.map((section) => section.id),
    );
    const allowedTiers = new Set(eventSession.priceTiers.map((tier) => tier.id));
    for (const assignment of input.assignments) {
      if (!allowedSections.has(assignment.sectionId)) {
        throw new EventAuthorizationError();
      }
      if (!allowedTiers.has(assignment.priceTierId)) {
        throw new EventAuthorizationError();
      }
    }

    await transaction.sessionSectionPricing.deleteMany({
      where: { sessionId: eventSession.id },
    });
    if (input.assignments.length > 0) {
      await transaction.sessionSectionPricing.createMany({
        data: input.assignments.map((assignment) => ({
          sessionId: eventSession.id,
          ...assignment,
        })),
      });
    }

    return transaction.sessionSectionPricing.findMany({
      where: { sessionId: eventSession.id },
      orderBy: { sectionId: "asc" },
    });
  });
}
