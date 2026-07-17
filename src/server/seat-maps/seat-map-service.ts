import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import {
  bulkSeatGenerationSchema,
  moveDirectionSchema,
  rowInputSchema,
  seatInputSchema,
  seatMapInputSchema,
  sectionInputSchema,
  SEAT_MAP_LIMITS,
  type BulkSeatGenerationInput,
  type RowInput,
  type SeatInput,
  type SeatMapInput,
  type SectionInput,
} from "@/features/seat-maps/schema";
import {
  canCloneSeatMap,
  canEditSeatMap,
  canPublishSeatMap,
} from "@/features/seat-maps/lifecycle";
import {
  generateRowLabels,
  generateSeatLabels,
} from "@/features/seat-maps/row-labels";
import { validateSeatMapForPublication } from "@/features/seat-maps/publication-validation";
import {
  findAuthorizedRow,
  findAuthorizedSeat,
  findAuthorizedSeatMap,
  findAuthorizedSection,
  findAuthorizedSpace,
} from "@/server/authorization/venue-resources";
import { withSerializableRetry } from "@/server/database/serializable-transaction";
import {
  isUniqueConstraintError,
  SeatMapValidationError,
  VenueManagementAuthorizationError,
  VenueManagementConflictError,
  VenueManagementLifecycleError,
} from "@/server/venues/errors";

export const seatMapGraphInclude = {
  sections: {
    orderBy: [{ displayOrder: "asc" }, { code: "asc" }],
    include: {
      rows: {
        orderBy: [{ displayOrder: "asc" }, { label: "asc" }],
        include: {
          seats: {
            orderBy: [{ displayOrder: "asc" }, { label: "asc" }],
          },
        },
      },
    },
  },
} satisfies Prisma.SeatMapInclude;

interface SpaceScope {
  userId: string;
  organizationSlug: string;
  venueSlug: string;
  spaceSlug: string;
}

interface SeatMapScope extends SpaceScope {
  seatMapId: string;
}

interface SeatMapLifecycleRecord {
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  space: {
    status: "DRAFT" | "ACTIVE" | "ARCHIVED";
    venue: { status: "DRAFT" | "ACTIVE" | "ARCHIVED" };
  };
}

function lifecycleContext(seatMap: SeatMapLifecycleRecord) {
  return {
    seatMapStatus: seatMap.status,
    spaceStatus: seatMap.space.status,
    venueStatus: seatMap.space.venue.status,
  } as const;
}

function assertEditableMap(seatMap: SeatMapLifecycleRecord) {
  if (seatMap.status !== "DRAFT") {
    throw new VenueManagementLifecycleError(
      "Published and archived seat maps are read-only.",
    );
  }

  if (!canEditSeatMap(lifecycleContext(seatMap))) {
    throw new VenueManagementLifecycleError(
      "Restore the venue and space before editing this draft.",
    );
  }
}

async function requireDraftMap(database: PrismaClient, scope: SeatMapScope) {
  const access = await findAuthorizedSeatMap(database, { ...scope, minimumRole: "ADMIN" });

  if (!access) throw new VenueManagementAuthorizationError();
  assertEditableMap(access.seatMap);
  return access;
}

async function assertMapStillEditable(
  transaction: Prisma.TransactionClient,
  seatMapId: string,
) {
  const seatMap = await transaction.seatMap.findUnique({
    where: { id: seatMapId },
    select: {
      status: true,
      space: {
        select: {
          status: true,
          venue: { select: { status: true } },
        },
      },
    },
  });

  if (!seatMap) throw new VenueManagementAuthorizationError();
  assertEditableMap(seatMap);
}

async function createVersionWithRetry<Result>(operation: () => Promise<Result>) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isUniqueConstraintError(error) || attempt === 3) throw error;
    }
  }

  throw new VenueManagementConflictError("Could not allocate a seat-map version.");
}

export async function createDraftSeatMap(
  database: PrismaClient,
  scope: SpaceScope,
  rawInput: SeatMapInput,
) {
  const access = await findAuthorizedSpace(database, { ...scope, minimumRole: "ADMIN" });

  if (!access) throw new VenueManagementAuthorizationError();
  if (access.space.status === "ARCHIVED" || access.space.venue.status === "ARCHIVED") {
    throw new VenueManagementLifecycleError("Restore the venue and space before creating a seat map.");
  }

  const input = seatMapInputSchema.parse(rawInput);

  return createVersionWithRetry(() =>
    withSerializableRetry(database, async (transaction) => {
      const latest = await transaction.seatMap.aggregate({
        where: { spaceId: access.space.id },
        _max: { version: true },
      });

      return transaction.seatMap.create({
        data: {
          spaceId: access.space.id,
          name: input.name,
          version: (latest._max.version ?? 0) + 1,
        },
      });
    }),
  );
}

export async function updateDraftSeatMap(
  database: PrismaClient,
  scope: SeatMapScope,
  rawInput: SeatMapInput,
) {
  const access = await requireDraftMap(database, scope);
  const input = seatMapInputSchema.parse(rawInput);

  return database.seatMap.update({
    where: { id: access.seatMap.id },
    data: { name: input.name },
  });
}

export async function createSection(
  database: PrismaClient,
  scope: SeatMapScope,
  rawInput: SectionInput,
) {
  const access = await requireDraftMap(database, scope);
  const input = sectionInputSchema.parse(rawInput);

  try {
    return await withSerializableRetry(database, async (transaction) => {
      await assertMapStillEditable(transaction, access.seatMap.id);
      const [count, last] = await Promise.all([
        transaction.seatSection.count({
          where: { seatMapId: access.seatMap.id },
        }),
        transaction.seatSection.findFirst({
          where: { seatMapId: access.seatMap.id },
          orderBy: { displayOrder: "desc" },
          select: { displayOrder: true },
        }),
      ]);

      if (count >= SEAT_MAP_LIMITS.maximumSections) {
        throw new SeatMapValidationError([
          `A map can contain at most ${SEAT_MAP_LIMITS.maximumSections} sections.`,
        ]);
      }

      return transaction.seatSection.create({
        data: {
          seatMapId: access.seatMap.id,
          name: input.name,
          code: input.code,
          displayOrder: (last?.displayOrder ?? -1) + 1,
        },
      });
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new VenueManagementConflictError("This map already contains that section code.");
    }
    throw error;
  }
}

export async function updateSection(
  database: PrismaClient,
  scope: SeatMapScope & { sectionId: string },
  rawInput: SectionInput,
) {
  const access = await findAuthorizedSection(database, { ...scope, minimumRole: "ADMIN" });

  if (!access) throw new VenueManagementAuthorizationError();
  assertEditableMap(access.seatMap);
  const input = sectionInputSchema.parse(rawInput);

  try {
    return await database.seatSection.update({
      where: { id: access.section.id },
      data: input,
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new VenueManagementConflictError("This map already contains that section code.");
    }
    throw error;
  }
}

export async function deleteSection(
  database: PrismaClient,
  scope: SeatMapScope & { sectionId: string },
) {
  const access = await findAuthorizedSection(database, { ...scope, minimumRole: "ADMIN" });

  if (!access) throw new VenueManagementAuthorizationError();
  assertEditableMap(access.seatMap);
  return database.seatSection.delete({ where: { id: access.section.id } });
}

export async function createRow(
  database: PrismaClient,
  scope: SeatMapScope & { sectionId: string },
  rawInput: RowInput,
) {
  const access = await findAuthorizedSection(database, { ...scope, minimumRole: "ADMIN" });

  if (!access) throw new VenueManagementAuthorizationError();
  assertEditableMap(access.seatMap);
  const input = rowInputSchema.parse(rawInput);

  try {
    return await withSerializableRetry(database, async (transaction) => {
      await assertMapStillEditable(transaction, access.seatMap.id);
      const [count, last] = await Promise.all([
        transaction.seatRow.count({
          where: { sectionId: access.section.id },
        }),
        transaction.seatRow.findFirst({
          where: { sectionId: access.section.id },
          orderBy: { displayOrder: "desc" },
          select: { displayOrder: true },
        }),
      ]);

      if (count >= SEAT_MAP_LIMITS.maximumRowsPerSection) {
        throw new SeatMapValidationError([
          `A section can contain at most ${SEAT_MAP_LIMITS.maximumRowsPerSection} rows.`,
        ]);
      }

      return transaction.seatRow.create({
        data: {
          sectionId: access.section.id,
          label: input.label,
          displayOrder: (last?.displayOrder ?? -1) + 1,
        },
      });
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new VenueManagementConflictError("This section already contains that row label.");
    }
    throw error;
  }
}

export async function updateRow(
  database: PrismaClient,
  scope: SeatMapScope & { sectionId: string; rowId: string },
  rawInput: RowInput,
) {
  const access = await findAuthorizedRow(database, { ...scope, minimumRole: "ADMIN" });

  if (!access) throw new VenueManagementAuthorizationError();
  assertEditableMap(access.seatMap);
  const input = rowInputSchema.parse(rawInput);

  try {
    return await database.seatRow.update({ where: { id: access.row.id }, data: input });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new VenueManagementConflictError("This section already contains that row label.");
    }
    throw error;
  }
}

export async function deleteRow(
  database: PrismaClient,
  scope: SeatMapScope & { sectionId: string; rowId: string },
) {
  const access = await findAuthorizedRow(database, { ...scope, minimumRole: "ADMIN" });

  if (!access) throw new VenueManagementAuthorizationError();
  assertEditableMap(access.seatMap);
  return database.seatRow.delete({ where: { id: access.row.id } });
}

export async function createSeat(
  database: PrismaClient,
  scope: SeatMapScope & { sectionId: string; rowId: string },
  rawInput: SeatInput,
) {
  const access = await findAuthorizedRow(database, { ...scope, minimumRole: "ADMIN" });

  if (!access) throw new VenueManagementAuthorizationError();
  assertEditableMap(access.seatMap);
  const input = seatInputSchema.parse(rawInput);

  try {
    return await withSerializableRetry(database, async (transaction) => {
      await assertMapStillEditable(transaction, access.seatMap.id);
      const [rowSeatCount, mapSeatCount, coordinateCount, last] =
        await Promise.all([
          transaction.seat.count({ where: { rowId: access.row.id } }),
          transaction.seat.count({
            where: {
              row: { section: { seatMapId: access.seatMap.id } },
            },
          }),
          transaction.seat.count({
            where: {
              x: input.x,
              y: input.y,
              row: { sectionId: access.section.id },
            },
          }),
          transaction.seat.findFirst({
            where: { rowId: access.row.id },
            orderBy: { displayOrder: "desc" },
            select: { displayOrder: true },
          }),
        ]);

      if (rowSeatCount >= SEAT_MAP_LIMITS.maximumSeatsPerRow) {
        throw new SeatMapValidationError([
          `A row can contain at most ${SEAT_MAP_LIMITS.maximumSeatsPerRow} seats.`,
        ]);
      }
      if (mapSeatCount >= SEAT_MAP_LIMITS.maximumSeatsPerMap) {
        throw new SeatMapValidationError([
          `A map can contain at most ${SEAT_MAP_LIMITS.maximumSeatsPerMap} seats.`,
        ]);
      }
      if (coordinateCount > 0) {
        throw new VenueManagementConflictError(
          "Another seat in this section already uses those coordinates.",
        );
      }

      return transaction.seat.create({
        data: {
          rowId: access.row.id,
          ...input,
          displayOrder: (last?.displayOrder ?? -1) + 1,
        },
      });
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new VenueManagementConflictError("This row already contains that seat label.");
    }
    throw error;
  }
}

export async function updateSeat(
  database: PrismaClient,
  scope: SeatMapScope & { sectionId: string; rowId: string; seatId: string },
  rawInput: SeatInput,
) {
  const access = await findAuthorizedSeat(database, { ...scope, minimumRole: "ADMIN" });

  if (!access) throw new VenueManagementAuthorizationError();
  assertEditableMap(access.seatMap);
  const input = seatInputSchema.parse(rawInput);

  try {
    return await withSerializableRetry(database, async (transaction) => {
      await assertMapStillEditable(transaction, access.seatMap.id);
      const coordinateCount = await transaction.seat.count({
        where: {
          id: { not: access.seat.id },
          x: input.x,
          y: input.y,
          row: { sectionId: access.section.id },
        },
      });

      if (coordinateCount > 0) {
        throw new VenueManagementConflictError(
          "Another seat in this section already uses those coordinates.",
        );
      }

      return transaction.seat.update({
        where: { id: access.seat.id },
        data: input,
      });
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new VenueManagementConflictError("This row already contains that seat label.");
    }
    throw error;
  }
}

export async function deleteSeat(
  database: PrismaClient,
  scope: SeatMapScope & { sectionId: string; rowId: string; seatId: string },
) {
  const access = await findAuthorizedSeat(database, { ...scope, minimumRole: "ADMIN" });

  if (!access) throw new VenueManagementAuthorizationError();
  assertEditableMap(access.seatMap);
  return database.seat.delete({ where: { id: access.seat.id } });
}

export async function bulkGenerateRows(
  database: PrismaClient,
  scope: SeatMapScope & { sectionId: string },
  rawInput: BulkSeatGenerationInput,
) {
  const access = await findAuthorizedSection(database, { ...scope, minimumRole: "ADMIN" });

  if (!access) throw new VenueManagementAuthorizationError();
  assertEditableMap(access.seatMap);
  const input = bulkSeatGenerationSchema.parse(rawInput);
  const labels = generateRowLabels(input.startRowLabel, input.rowCount);
  const seatLabels = generateSeatLabels(
    input.startSeatNumber,
    input.seatsPerRow,
  );
  return withSerializableRetry(database, async (transaction) => {
    const draft = await transaction.seatMap.findUnique({
      where: { id: access.seatMap.id },
      select: {
        status: true,
        space: {
          select: {
            status: true,
            venue: { select: { status: true } },
          },
        },
      },
    });
    if (!draft) throw new VenueManagementAuthorizationError();
    assertEditableMap(draft);

    const [rows, mapSeatCount] = await Promise.all([
      transaction.seatRow.findMany({
        where: { sectionId: access.section.id },
        include: { seats: { select: { y: true } } },
        orderBy: { displayOrder: "asc" },
      }),
      transaction.seat.count({
        where: { row: { section: { seatMapId: access.seatMap.id } } },
      }),
    ]);
    const existingLabels = new Set(rows.map((row) => row.label.toUpperCase()));
    const conflictingLabel = labels.find((label) => existingLabels.has(label));
    const generatedSeatCount = input.rowCount * input.seatsPerRow;

    if (conflictingLabel) {
      throw new VenueManagementConflictError(`Row ${conflictingLabel} already exists in this section.`);
    }
    if (rows.length + input.rowCount > SEAT_MAP_LIMITS.maximumRowsPerSection) {
      throw new SeatMapValidationError([`A section can contain at most ${SEAT_MAP_LIMITS.maximumRowsPerSection} rows.`]);
    }
    if (mapSeatCount + generatedSeatCount > SEAT_MAP_LIMITS.maximumSeatsPerMap) {
      throw new SeatMapValidationError([`A map can contain at most ${SEAT_MAP_LIMITS.maximumSeatsPerMap} seats.`]);
    }

    const nextDisplayOrder = (rows.at(-1)?.displayOrder ?? -1) + 1;
    const maximumY = Math.max(
      -input.verticalSpacing,
      ...rows.flatMap((row) => row.seats.map((seat) => seat.y)),
    );
    const firstY = maximumY + input.verticalSpacing;
    const finalY = firstY + (input.rowCount - 1) * input.verticalSpacing;

    if (finalY > SEAT_MAP_LIMITS.maximumCoordinate) {
      throw new SeatMapValidationError(["Vertical spacing places generated rows outside the editor canvas."]);
    }

    return transaction.seatSection.update({
      where: { id: access.section.id },
      data: {
        rows: {
          create: labels.map((label, rowIndex) => ({
            label,
            displayOrder: nextDisplayOrder + rowIndex,
            seats: {
              create: seatLabels.map((label, seatIndex) => ({
                label,
                displayOrder: seatIndex,
                x: seatIndex * input.horizontalSpacing,
                y: firstY + rowIndex * input.verticalSpacing,
              })),
            },
          })),
        },
      },
      include: { rows: { include: { seats: true } } },
    });
  });
}

export async function moveSection(
  database: PrismaClient,
  scope: SeatMapScope & { sectionId: string; direction: "up" | "down" },
) {
  const access = await findAuthorizedSection(database, { ...scope, minimumRole: "ADMIN" });

  if (!access) throw new VenueManagementAuthorizationError();
  assertEditableMap(access.seatMap);
  const direction = moveDirectionSchema.parse(scope.direction);
  return withSerializableRetry(database, async (transaction) => {
    const sections = await transaction.seatSection.findMany({
      where: { seatMapId: access.seatMap.id },
      orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
    });
    const index = sections.findIndex((section) => section.id === access.section.id);
    const current = sections[index];
    const target = sections[direction === "up" ? index - 1 : index + 1];
    if (!current || !target) return access.section;

    await transaction.seatSection.update({
      where: { id: access.section.id },
      data: { displayOrder: target.displayOrder },
    });
    await transaction.seatSection.update({
      where: { id: target.id },
      data: { displayOrder: current.displayOrder },
    });
    return { ...current, displayOrder: target.displayOrder };
  });
}

export async function moveRow(
  database: PrismaClient,
  scope: SeatMapScope & {
    sectionId: string;
    rowId: string;
    direction: "up" | "down";
  },
) {
  const access = await findAuthorizedRow(database, { ...scope, minimumRole: "ADMIN" });

  if (!access) throw new VenueManagementAuthorizationError();
  assertEditableMap(access.seatMap);
  const direction = moveDirectionSchema.parse(scope.direction);
  return withSerializableRetry(database, async (transaction) => {
    const rows = await transaction.seatRow.findMany({
      where: { sectionId: access.section.id },
      orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
    });
    const index = rows.findIndex((row) => row.id === access.row.id);
    const current = rows[index];
    const target = rows[direction === "up" ? index - 1 : index + 1];
    if (!current || !target) return access.row;

    await transaction.seatRow.update({
      where: { id: access.row.id },
      data: { displayOrder: target.displayOrder },
    });
    await transaction.seatRow.update({
      where: { id: target.id },
      data: { displayOrder: current.displayOrder },
    });
    return { ...current, displayOrder: target.displayOrder };
  });
}

export async function publishSeatMap(database: PrismaClient, scope: SeatMapScope) {
  const access = await findAuthorizedSeatMap(database, { ...scope, minimumRole: "ADMIN" });

  if (!access) throw new VenueManagementAuthorizationError();
  if (access.seatMap.status === "PUBLISHED") {
    return database.seatMap.findUniqueOrThrow({
      where: { id: access.seatMap.id },
      include: seatMapGraphInclude,
    });
  }
  if (access.seatMap.status === "ARCHIVED") {
    throw new VenueManagementLifecycleError("Archived seat-map versions cannot be republished.");
  }
  if (!canPublishSeatMap(lifecycleContext(access.seatMap))) {
    throw new VenueManagementLifecycleError(
      "Restore the venue and space before publishing this draft.",
    );
  }

  return withSerializableRetry(database, async (transaction) => {
    const draft = await transaction.seatMap.findFirst({
      where: { id: access.seatMap.id, spaceId: access.seatMap.spaceId },
      include: {
        ...seatMapGraphInclude,
        space: { include: { venue: true } },
      },
    });

    if (!draft) throw new VenueManagementAuthorizationError();
    if (draft.status === "PUBLISHED") return draft;
    if (!canPublishSeatMap(lifecycleContext(draft))) {
      throw new VenueManagementLifecycleError(
        "Restore the venue and space before publishing this draft.",
      );
    }

    const issues = validateSeatMapForPublication(draft);
    if (issues.length > 0) throw new SeatMapValidationError(issues);

    await transaction.seatMap.updateMany({
      where: {
        spaceId: draft.spaceId,
        status: "PUBLISHED",
        id: { not: draft.id },
      },
      data: { status: "ARCHIVED" },
    });

    return transaction.seatMap.update({
      where: { id: draft.id },
      data: { status: "PUBLISHED", publishedAt: new Date() },
      include: seatMapGraphInclude,
    });
  });
}

export async function clonePublishedSeatMap(database: PrismaClient, scope: SeatMapScope) {
  const access = await findAuthorizedSeatMap(database, { ...scope, minimumRole: "ADMIN" });

  if (!access) throw new VenueManagementAuthorizationError();
  if (access.seatMap.status !== "PUBLISHED") {
    throw new VenueManagementLifecycleError("Only the current published seat map can be cloned.");
  }
  if (!canCloneSeatMap(lifecycleContext(access.seatMap))) {
    throw new VenueManagementLifecycleError(
      "Restore the venue and space before cloning this seat map.",
    );
  }

  return createVersionWithRetry(() =>
    withSerializableRetry(database, async (transaction) => {
      const source = await transaction.seatMap.findFirst({
        where: { id: access.seatMap.id, spaceId: access.seatMap.spaceId, status: "PUBLISHED" },
        include: {
          ...seatMapGraphInclude,
          space: { include: { venue: true } },
        },
      });

      if (!source) {
        throw new VenueManagementLifecycleError("The published source changed before it could be cloned.");
      }
      if (!canCloneSeatMap(lifecycleContext(source))) {
        throw new VenueManagementLifecycleError(
          "Restore the venue and space before cloning this seat map.",
        );
      }

      const latest = await transaction.seatMap.aggregate({
        where: { spaceId: source.spaceId },
        _max: { version: true },
      });

      return transaction.seatMap.create({
        data: {
          spaceId: source.spaceId,
          sourceSeatMapId: source.id,
          name: source.name,
          version: (latest._max.version ?? 0) + 1,
          sections: {
            create: source.sections.map((section) => ({
              name: section.name,
              code: section.code,
              displayOrder: section.displayOrder,
              rows: {
                create: section.rows.map((row) => ({
                  label: row.label,
                  displayOrder: row.displayOrder,
                  seats: {
                    create: row.seats.map((seat) => ({
                      label: seat.label,
                      displayOrder: seat.displayOrder,
                      x: seat.x,
                      y: seat.y,
                      type: seat.type,
                      state: seat.state,
                    })),
                  },
                })),
              },
            })),
          },
        },
        include: seatMapGraphInclude,
      });
    }),
  );
}

export type SeatMapGraph = Prisma.SeatMapGetPayload<{
  include: typeof seatMapGraphInclude;
}>;
