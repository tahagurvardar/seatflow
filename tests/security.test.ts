import { describe, expect, it } from "vitest";

import { registrationSchema } from "@/features/auth/schema";
import {
  createOrganizationSlug,
  organizationOnboardingSchema,
} from "@/features/organizations/schema";
import { readSafeTestDatabaseUrl } from "@/env/schema";
import { getSafeRedirectPath } from "@/lib/safe-redirect";
import { hasMinimumMembershipRole } from "@/server/authorization/organization-membership";

describe("security boundaries", () => {
  it("accepts only local redirect destinations", () => {
    expect(getSafeRedirectPath("/customer/dashboard?tab=account", "/")).toBe(
      "/customer/dashboard?tab=account",
    );
    expect(getSafeRedirectPath("https://attacker.example", "/safe")).toBe(
      "/safe",
    );
    expect(getSafeRedirectPath("//attacker.example/path", "/safe")).toBe(
      "/safe",
    );
  });

  it("strips client-supplied registration fields outside the account contract", () => {
    const parsed = registrationSchema.parse({
      name: "Alex Morgan",
      email: "ALEX@example.com",
      password: "correct-horse-battery-staple",
      platformRole: "ADMIN",
    });

    expect(parsed).toEqual({
      name: "Alex Morgan",
      email: "alex@example.com",
      password: "correct-horse-battery-staple",
    });
    expect(parsed).not.toHaveProperty("platformRole");
  });

  it("enforces the organization membership hierarchy", () => {
    expect(hasMinimumMembershipRole("OWNER", "ADMIN")).toBe(true);
    expect(hasMinimumMembershipRole("ADMIN", "MEMBER")).toBe(true);
    expect(hasMinimumMembershipRole("MEMBER", "ADMIN")).toBe(false);
  });

  it("normalizes organization identity inputs", () => {
    const organization = organizationOnboardingSchema.parse({
      name: "  Northstar   Live  ",
    });

    expect(organization.name).toBe("Northstar Live");
    expect(createOrganizationSlug("Şəhər Gecəsi Live")).toBe(
      "s-h-r-gec-si-live",
    );
  });

  it("refuses ambiguous or shared test database URLs", () => {
    expect(() =>
      readSafeTestDatabaseUrl({
        TEST_DATABASE_URL: "postgresql://localhost/seatflow",
      }),
    ).toThrow(/not clearly marked as a test database/i);
    expect(() =>
      readSafeTestDatabaseUrl({
        TEST_DATABASE_URL: "postgresql://localhost/seatflow_test",
        DATABASE_URL: "postgresql://localhost/seatflow_test",
      }),
    ).toThrow(/matches DATABASE_URL/i);
  });
});
