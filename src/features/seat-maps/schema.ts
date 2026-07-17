import { z } from "zod";

import { rowLabelToNumber } from "@/features/seat-maps/row-labels";

export const SEAT_MAP_LIMITS = {
  maximumSections: 20,
  maximumRowsPerSection: 60,
  maximumSeatsPerRow: 80,
  maximumSeatsPerMap: 3_000,
  maximumBulkRows: 30,
  minimumCoordinate: 0,
  maximumCoordinate: 10_000,
  maximumSpacing: 200,
} as const;

const compactText = (minimum: number, maximum: number) =>
  z
    .string()
    .trim()
    .transform((value) => value.replace(/\s+/g, " "))
    .pipe(z.string().min(minimum).max(maximum));

export const seatMapInputSchema = z.object({
  name: compactText(2, 120),
});

export const sectionInputSchema = z.object({
  name: compactText(1, 80),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(1)
    .max(20)
    .regex(/^[A-Z0-9]+(?:[-_][A-Z0-9]+)*$/, "Use letters, numbers, hyphens, or underscores."),
});

export const rowInputSchema = z.object({
  label: z.string().trim().toUpperCase().min(1).max(12),
});

export const seatInputSchema = z.object({
  label: z.string().trim().toUpperCase().min(1).max(12),
  x: z.coerce.number().int().min(SEAT_MAP_LIMITS.minimumCoordinate).max(SEAT_MAP_LIMITS.maximumCoordinate),
  y: z.coerce.number().int().min(SEAT_MAP_LIMITS.minimumCoordinate).max(SEAT_MAP_LIMITS.maximumCoordinate),
  type: z.enum(["STANDARD", "ACCESSIBLE", "COMPANION", "PREMIUM"]),
  state: z.enum(["ACTIVE", "BLOCKED"]),
});

export const bulkSeatGenerationSchema = z
  .object({
    startRowLabel: z.string().trim().toUpperCase().regex(/^[A-Z]{1,3}$/, "Use a letter label such as A or AA."),
    rowCount: z.coerce.number().int().min(1).max(SEAT_MAP_LIMITS.maximumBulkRows),
    seatsPerRow: z.coerce.number().int().min(1).max(SEAT_MAP_LIMITS.maximumSeatsPerRow),
    startSeatNumber: z.coerce.number().int().min(1).max(9_999),
    horizontalSpacing: z.coerce.number().int().min(1).max(SEAT_MAP_LIMITS.maximumSpacing),
    verticalSpacing: z.coerce.number().int().min(1).max(SEAT_MAP_LIMITS.maximumSpacing),
  })
  .superRefine((value, context) => {
    if (rowLabelToNumber(value.startRowLabel) + value.rowCount - 1 > 18_278) {
      context.addIssue({
        code: "custom",
        path: ["rowCount"],
        message: "The generated row labels must not extend beyond ZZZ.",
      });
    }

    if (value.startSeatNumber + value.seatsPerRow - 1 > 9_999) {
      context.addIssue({
        code: "custom",
        path: ["startSeatNumber"],
        message: "The generated seat labels must not exceed 9999.",
      });
    }

    if ((value.seatsPerRow - 1) * value.horizontalSpacing > SEAT_MAP_LIMITS.maximumCoordinate) {
      context.addIssue({
        code: "custom",
        path: ["horizontalSpacing"],
        message: "Horizontal spacing places seats outside the editor canvas.",
      });
    }
  });

export const moveDirectionSchema = z.enum(["up", "down"]);

export type SeatMapInput = z.infer<typeof seatMapInputSchema>;
export type SectionInput = z.infer<typeof sectionInputSchema>;
export type RowInput = z.infer<typeof rowInputSchema>;
export type SeatInput = z.infer<typeof seatInputSchema>;
export type BulkSeatGenerationInput = z.infer<typeof bulkSeatGenerationSchema>;
