import { z } from "zod";

const normalizedText = (minimum: number, maximum: number) =>
  z
    .string()
    .trim()
    .transform((value) => value.replace(/\s+/g, " "))
    .pipe(z.string().min(minimum).max(maximum));

const optionalText = (maximum: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(maximum).optional(),
  );

export function createResourceSlug(value: string) {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");

  return slug || "resource";
}

const optionalSlug = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .string()
    .trim()
    .toLowerCase()
    .min(2, "Use at least 2 characters.")
    .max(64, "Use no more than 64 characters.")
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and single hyphens.")
    .optional(),
);

const timeZone = z.string().trim().refine(
  (value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  },
  "Enter a valid IANA time zone, such as Asia/Baku.",
);

export const venueInputSchema = z.object({
  name: normalizedText(2, 120),
  slug: optionalSlug,
  description: optionalText(1_000),
  addressLine1: normalizedText(2, 160),
  addressLine2: optionalText(160),
  city: normalizedText(2, 100),
  countryCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Use a two-letter country code."),
  postalCode: optionalText(24),
  timeZone,
  status: z.enum(["DRAFT", "ACTIVE"]).default("DRAFT"),
});

export const spaceInputSchema = z.object({
  name: normalizedText(2, 120),
  slug: optionalSlug,
  description: optionalText(1_000),
  type: z.enum(["CINEMA", "THEATRE", "CONCERT_HALL", "STADIUM", "ARENA", "GENERAL"]),
  status: z.enum(["DRAFT", "ACTIVE"]).default("DRAFT"),
});

export type VenueInput = z.infer<typeof venueInputSchema>;
export type SpaceInput = z.infer<typeof spaceInputSchema>;
