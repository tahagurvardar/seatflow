import { z } from "zod";

export const organizationOnboardingSchema = z.object({
  name: z
    .string()
    .trim()
    .transform((value) => value.replace(/\s+/g, " "))
    .pipe(
      z
        .string()
        .min(2, "Enter at least 2 characters.")
        .max(100, "Enter no more than 100 characters."),
    ),
});

export const organizationSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, "Enter an organizer organization slug.")
  .max(64, "Enter no more than 64 characters.")
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Use lowercase letters, numbers, and single hyphens.",
  );

export const venueAccessRevocationSchema = z.object({
  confirmation: z.literal("revoke", {
    error: "Confirm revocation before continuing.",
  }),
});

export function createOrganizationSlug(name: string) {
  const normalized = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");

  return normalized || "organization";
}
