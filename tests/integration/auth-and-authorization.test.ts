import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ApplicationEnvironment } from "../../src/env/schema";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { createDatabaseClient } from "../../src/lib/database";
import { createSeatFlowAuth } from "../../src/server/auth/create-seatflow-auth";
import { findAuthorizedOrganizationMembership } from "../../src/server/authorization/organization-membership";
import {
  createOrganizerOrganization,
  OrganizationSlugConflictError,
} from "../../src/server/organizations/create-organizer-organization";
import { resetIntegrationDatabase } from "./reset-database";

const authEnvironment: ApplicationEnvironment = {
  DATABASE_URL: process.env.DATABASE_URL!,
  DIRECT_URL: process.env.DIRECT_URL,
  BETTER_AUTH_SECRET: "integration-test-secret-that-is-at-least-32-characters",
  BETTER_AUTH_URL: "http://localhost:3000",
};
let database: PrismaClient;
let auth: ReturnType<typeof createSeatFlowAuth>;

async function callAuth(
  path: string,
  init: { body?: Record<string, unknown>; cookie?: string; method?: string } = {},
) {
  const headers = new Headers({ Origin: authEnvironment.BETTER_AUTH_URL });

  if (init.body) {
    headers.set("Content-Type", "application/json");
  }

  if (init.cookie) {
    headers.set("Cookie", init.cookie);
  }

  return auth.handler(
    new Request(`${authEnvironment.BETTER_AUTH_URL}/api/auth${path}`, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
    }),
  );
}

beforeEach(async () => {
  database = createDatabaseClient();
  auth = createSeatFlowAuth(authEnvironment, database);
  await resetIntegrationDatabase(database);
});

afterEach(async () => {
  await database.$disconnect();
});

describe("Better Auth persistence", () => {
  it("registers a USER, ignores an injected ADMIN role, and resolves its server session", async () => {
    const response = await callAuth("/sign-up/email", {
      body: {
        name: "Alex Morgan",
        email: "alex@example.com",
        password: "correct-horse-battery-staple",
        platformRole: "ADMIN",
      },
    });

    expect(response.status).toBe(200);
    const user = await database.user.findUniqueOrThrow({
      where: { email: "alex@example.com" },
    });
    expect(user.platformRole).toBe("USER");
    expect(await database.account.count({ where: { userId: user.id } })).toBe(1);

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    const cookie = setCookie!.split(";")[0];
    const sessionResponse = await callAuth("/get-session", { cookie });
    const session = (await sessionResponse.json()) as {
      user?: { id: string; email: string; platformRole: string };
    };

    expect(sessionResponse.status).toBe(200);
    expect(session.user).toMatchObject({
      id: user.id,
      email: user.email,
      platformRole: "USER",
    });
  });

  it("does not create a second account for a duplicate registration", async () => {
    const body = {
      name: "Alex Morgan",
      email: "alex@example.com",
      password: "correct-horse-battery-staple",
    };

    expect((await callAuth("/sign-up/email", { body })).status).toBe(200);
    expect((await callAuth("/sign-up/email", { body })).ok).toBe(false);
    expect(await database.user.count()).toBe(1);
  });
});

describe("tenant authorization persistence", () => {
  it("creates an organizer and OWNER membership atomically and handles duplicate slugs", async () => {
    const user = await database.user.create({
      data: {
        name: "Owner",
        email: "owner@example.com",
      },
    });

    const organization = await createOrganizerOrganization(database, {
      userId: user.id,
      name: "  Northstar   Live ",
    });

    expect(organization).toMatchObject({
      name: "Northstar Live",
      slug: "northstar-live",
      kind: "ORGANIZER",
    });
    expect(organization.memberships).toHaveLength(1);
    expect(organization.memberships[0]).toMatchObject({
      userId: user.id,
      role: "OWNER",
    });

    await expect(
      createOrganizerOrganization(database, {
        userId: user.id,
        name: "Northstar Live",
      }),
    ).rejects.toBeInstanceOf(OrganizationSlugConflictError);
    expect(await database.organization.findMany()).toHaveLength(1);
    expect(await database.membership.findMany()).toHaveLength(1);
  });

  it("scopes membership checks to the current user and minimum tenant role", async () => {
    const owner = await database.user.create({
      data: { name: "Owner", email: "owner@example.com" },
    });
    const outsider = await database.user.create({
      data: { name: "Outsider", email: "outsider@example.com" },
    });
    const organization = await createOrganizerOrganization(database, {
      userId: owner.id,
      name: "Northstar Live",
    });

    await expect(
      findAuthorizedOrganizationMembership(database, {
        userId: owner.id,
        organizationId: organization.id,
        minimumRole: "ADMIN",
      }),
    ).resolves.toMatchObject({ role: "OWNER" });
    await expect(
      findAuthorizedOrganizationMembership(database, {
        userId: outsider.id,
        organizationId: organization.id,
        minimumRole: "MEMBER",
      }),
    ).resolves.toBeNull();
  });

  it("cascades user memberships while preserving the tenant record", async () => {
    const user = await database.user.create({
      data: { name: "Owner", email: "owner@example.com" },
    });
    const organization = await createOrganizerOrganization(database, {
      userId: user.id,
      name: "Northstar Live",
    });

    await database.user.delete({ where: { id: user.id } });

    expect(
      await database.membership.count({
        where: { organizationId: organization.id },
      }),
    ).toBe(0);
    expect(
      await database.organization.count({ where: { id: organization.id } }),
    ).toBe(1);
  });
});
