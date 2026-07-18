import { z } from "zod";

import { CURRENCY_VALUES } from "@/config/site";

const normalizedText = (minimum: number, maximum: number) =>
  z
    .string()
    .trim()
    .transform((value) => value.replace(/\s+/g, " "))
    .pipe(z.string().min(minimum).max(maximum));

const optionalText = (maximum: number) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().trim().max(maximum).optional(),
  );

export function createEventSlug(value: string) {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");

  return slug || "event";
}

export function createPublicEventSlug(
  organizationSlug: string,
  eventSlug: string,
) {
  return `${organizationSlug}--${eventSlug}`;
}

const optionalSlug = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z
    .string()
    .trim()
    .toLowerCase()
    .min(2, "Use at least 2 characters.")
    .max(80, "Use no more than 80 characters.")
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "Use lowercase letters, numbers, and single hyphens.",
    )
    .optional(),
);

const imagePath = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z
    .string()
    .trim()
    .regex(
      /^\/events\/[A-Za-z0-9][A-Za-z0-9_-]*\.(?:svg|png|webp|jpe?g)$/,
      "Use a safe local /events image path.",
    )
    .optional(),
);

export const eventInputSchema = z.object({
  title: normalizedText(3, 160),
  slug: optionalSlug,
  shortDescription: normalizedText(10, 280),
  description: z.string().trim().min(30).max(10_000),
  category: z.enum(["CONCERT", "CINEMA", "THEATRE", "SPORT", "OTHER"]),
  imagePath,
});

const identifier = z.string().trim().min(1).max(191);
const localDateTime = z
  .string()
  .trim()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/,
    "Use a valid local date and time.",
  );

export const eventSessionInputSchema = z.object({
  venueId: identifier,
  spaceId: identifier,
  seatMapId: identifier,
  startLocal: localDateTime,
  endLocal: localDateTime,
  salesStartLocal: localDateTime,
  salesEndLocal: localDateTime,
});

export const sessionDateRangeSchema = z
  .object({
    startAt: z.date(),
    endAt: z.date(),
    salesStartAt: z.date(),
    salesEndAt: z.date(),
  })
  .superRefine((value, context) => {
    if (value.endAt <= value.startAt) {
      context.addIssue({
        code: "custom",
        path: ["endAt"],
        message: "Session end time must be after its start time.",
      });
    }

    if (value.salesStartAt >= value.salesEndAt) {
      context.addIssue({
        code: "custom",
        path: ["salesEndAt"],
        message: "Sales end time must be after sales start time.",
      });
    }

    if (value.salesEndAt > value.startAt) {
      context.addIssue({
        code: "custom",
        path: ["salesEndAt"],
        message: "Sales must end no later than the session start time.",
      });
    }
  });

export const priceTierInputSchema = z.object({
  name: normalizedText(1, 80),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(1)
    .max(20)
    .regex(
      /^[A-Z0-9]+(?:[-_][A-Z0-9]+)*$/,
      "Use letters, numbers, hyphens, or underscores.",
    ),
  priceMinor: z.number().int().nonnegative().max(2_147_483_647),
  currency: z.enum(CURRENCY_VALUES),
  description: optionalText(500),
});

export const priceTierFormSchema = priceTierInputSchema.omit({
  priceMinor: true,
}).extend({
  price: z
    .string()
    .trim()
    .regex(/^\d+(?:\.\d{1,2})?$/, "Use a non-negative amount with up to 2 decimals."),
});

export const sectionPricingInputSchema = z.object({
  assignments: z.array(
    z.object({
      sectionId: identifier,
      priceTierId: identifier,
    }),
  ),
});

const lifecycleIntent = z.enum([
  "publish",
  "cancel",
  "archive",
  "restore",
  "delete",
  "pause",
  "resume",
]);

export const lifecycleConfirmationSchema = z
  .object({
    intent: lifecycleIntent,
    confirmation: lifecycleIntent,
  })
  .superRefine((value, context) => {
    if (value.intent !== value.confirmation) {
      context.addIssue({
        code: "custom",
        path: ["confirmation"],
        message: `Confirm ${value.intent} before continuing.`,
      });
    }
  });

export type EventInput = z.infer<typeof eventInputSchema>;
export type EventSessionInput = z.infer<typeof eventSessionInputSchema>;
export type SessionDateRange = z.infer<typeof sessionDateRangeSchema>;
export type PriceTierInput = z.infer<typeof priceTierInputSchema>;
export type SectionPricingInput = z.infer<typeof sectionPricingInputSchema>;
