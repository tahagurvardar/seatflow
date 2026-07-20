import "dotenv/config";

import { readApplicationEnvironment, readSafeTestDatabaseUrl } from "../../src/env/schema";
import { createSeatFlowAuth } from "../../src/server/auth/create-seatflow-auth";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Deterministic browser-test fixtures.
 *
 * Safety properties this file is built around:
 *
 *  - It refuses to run against anything but a clearly-marked test database.
 *    `readSafeTestDatabaseUrl` rejects a URL whose database name is not marked
 *    as a test database, and rejects one equal to DATABASE_URL/DIRECT_URL, so
 *    the development `seatflow` database can never be seeded or reset here.
 *  - Users are created through Better Auth's own server API, so real password
 *    hashing and the real session mechanism are used. Nothing forges a session,
 *    stubs a cookie, or fakes a logged-in front-end state, and Playwright signs
 *    in through the real login form.
 *  - Credentials are synthetic, defined here, and never logged. No password,
 *    token, cookie, or auth row is ever printed.
 */

/** Synthetic accounts. Not secrets: they exist only in a disposable test DB. */
export const BROWSER_TEST_ACCOUNTS = {
  customer: {
    email: "browser-customer@seatflow.invalid",
    password: "BrowserCustomer!2026",
    name: "Browser Customer",
  },
  otherCustomer: {
    email: "browser-other-customer@seatflow.invalid",
    password: "BrowserOther!2026",
    name: "Browser Other Customer",
  },
  organizer: {
    email: "browser-organizer@seatflow.invalid",
    password: "BrowserOrganizer!2026",
    name: "Browser Organizer",
  },
  foreignOrganizer: {
    email: "browser-foreign-organizer@seatflow.invalid",
    password: "BrowserForeign!2026",
    name: "Browser Foreign Organizer",
  },
  admin: {
    email: "browser-admin@seatflow.invalid",
    password: "BrowserAdmin!2026",
    name: "Browser Administrator",
  },
} as const;

export type BrowserAccountKey = keyof typeof BROWSER_TEST_ACCOUNTS;

export function createBrowserTestDatabase() {
  // Throws unless the target is a clearly disposable test database.
  const url = readSafeTestDatabaseUrl(process.env, { allowRuntimeAlias: true });
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

/**
 * Create the synthetic accounts if they do not already exist. Idempotent: a
 * repeated run reuses the existing user rather than failing or duplicating.
 */
async function ensureAccount(
  auth: ReturnType<typeof createSeatFlowAuth>,
  database: PrismaClient,
  account: { email: string; password: string; name: string },
) {
  const existing = await database.user.findUnique({ where: { email: account.email } });
  if (existing) return existing.id;

  // Better Auth's own sign-up path: real hashing, real account row.
  await auth.api.signUpEmail({
    body: { email: account.email, password: account.password, name: account.name },
  });
  const created = await database.user.findUniqueOrThrow({ where: { email: account.email } });
  return created.id;
}

export interface BrowserSeedResult {
  customerId: string;
  otherCustomerId: string;
  organizerId: string;
  foreignOrganizerId: string;
  adminId: string;
  organizationSlug: string;
  foreignOrganizationSlug: string;
}

/**
 * Seed accounts and organization membership.
 *
 * Booking and refund fixtures are created by the integration-style helper the
 * spec calls, so the browser suite exercises the same real services rather than
 * a parallel set of hand-written rows.
 */
export async function seedBrowserAccounts(): Promise<BrowserSeedResult> {
  const database = createBrowserTestDatabase();
  try {
    const environment = readApplicationEnvironment({
      ...process.env,
      // Better Auth needs an absolute base URL; the browser suite serves from
      // loopback and never issues external redirects.
      BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000",
    });
    const auth = createSeatFlowAuth(environment, database);

    const [customerId, otherCustomerId, organizerId, foreignOrganizerId, adminId] =
      await Promise.all([
        ensureAccount(auth, database, BROWSER_TEST_ACCOUNTS.customer),
        ensureAccount(auth, database, BROWSER_TEST_ACCOUNTS.otherCustomer),
        ensureAccount(auth, database, BROWSER_TEST_ACCOUNTS.organizer),
        ensureAccount(auth, database, BROWSER_TEST_ACCOUNTS.foreignOrganizer),
        ensureAccount(auth, database, BROWSER_TEST_ACCOUNTS.admin),
      ]);

    // Platform role is granted the same way the documented bootstrap command
    // does it: a direct, deliberate database update, never a web control.
    await database.user.update({
      where: { id: adminId },
      data: { platformRole: "ADMIN" },
    });

    const organization = await database.organization.upsert({
      where: { slug: "browser-organizer-tenant" },
      update: {},
      create: {
        name: "Browser Organizer Tenant",
        slug: "browser-organizer-tenant",
        kind: "ORGANIZER",
      },
    });
    const foreignOrganization = await database.organization.upsert({
      where: { slug: "browser-foreign-tenant" },
      update: {},
      create: {
        name: "Browser Foreign Tenant",
        slug: "browser-foreign-tenant",
        kind: "ORGANIZER",
      },
    });

    for (const [userId, organizationId] of [
      [organizerId, organization.id],
      [foreignOrganizerId, foreignOrganization.id],
    ] as const) {
      await database.membership.upsert({
        where: { userId_organizationId: { userId, organizationId } },
        update: {},
        create: { userId, organizationId, role: "ADMIN" },
      });
    }

    return {
      customerId,
      otherCustomerId,
      organizerId,
      foreignOrganizerId,
      adminId,
      organizationSlug: organization.slug,
      foreignOrganizationSlug: foreignOrganization.slug,
    };
  } finally {
    await database.$disconnect();
  }
}
