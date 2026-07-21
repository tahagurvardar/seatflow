import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import dotenv from "dotenv";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";
import { toVenueLocalInputValue } from "../src/features/events/date-time";
import { isWeakSecret } from "../src/features/operations/production-check";
import { createSeatFlowAuth } from "../src/server/auth/create-seatflow-auth";
import {
  createEventSession,
  publishEventSession,
} from "../src/server/events/event-session-service";
import { createEvent, publishEvent } from "../src/server/events/event-service";
import {
  assignSessionSectionPricing,
  createSessionPriceTier,
} from "../src/server/events/pricing-service";
import { createOrganizerOrganization } from "../src/server/organizations/create-organizer-organization";
import { createVenueOperatorOrganization } from "../src/server/organizations/create-venue-operator-organization";
import {
  bulkGenerateRows,
  createDraftSeatMap,
  createSection,
  publishSeatMap,
} from "../src/server/seat-maps/seat-map-service";
import { createSpace } from "../src/server/venues/space-service";
import { createVenue } from "../src/server/venues/venue-service";
import { grantVenueAccess } from "../src/server/venue-access/venue-access-service";

/**
 * `npm run staging:seed -- [--yes]`
 *
 * Idempotent demo content for the staging environment.
 *
 * Idempotent means genuinely re-runnable: every step looks for what it would
 * create and reuses it. A second run adds nothing and removes nothing. There is
 * no path here that deletes, truncates, resets, or rewrites anything — in
 * particular, nothing touches booking, payment, refund, dispute, ledger, or
 * ticket history, which stays append-only exactly as in production.
 *
 * Identities are deterministic and synthetic. The only real address that can
 * appear anywhere in this environment is `RESEND_TEST_RECIPIENT`, and it is
 * used solely so the demo customer's mail lands somewhere the operator can see.
 *
 * Passwords are **not** generated here and are never committed. They come from
 * `.env.staging.local`, so the person who owns the environment chooses them and
 * this file never learns a value it could print.
 */

const STAGING_ENV_FILE = ".env.staging.local";

const args = process.argv.slice(2);
const assumeYes = args.includes("--yes");

const envPath = resolve(process.cwd(), STAGING_ENV_FILE);
if (!existsSync(envPath)) {
  console.error(`${STAGING_ENV_FILE} does not exist. Create it from .env.staging.example first.`);
  process.exit(1);
}
const parsed = dotenv.parse(readFileSync(envPath));

const PASSWORD_VARIABLES = [
  "STAGING_SEED_ADMIN_PASSWORD",
  "STAGING_SEED_ORGANIZER_PASSWORD",
  "STAGING_SEED_OPERATOR_PASSWORD",
  "STAGING_SEED_CUSTOMER_PASSWORD",
] as const;

const missing = PASSWORD_VARIABLES.filter((name) => !parsed[name]);
if (missing.length > 0) {
  console.error("Missing seed password variable(s):");
  for (const name of missing) console.error(`  ${name}`);
  console.error("");
  console.error("Generate each one locally and add it to .env.staging.local:");
  console.error("  openssl rand -base64 24");
  console.error("");
  console.error("These are demo credentials for synthetic accounts, but they still");
  console.error("guard an internet-reachable environment. Do not reuse a real password.");
  process.exit(1);
}

const weak = PASSWORD_VARIABLES.filter((name) => isWeakSecret(parsed[name], 16));
if (weak.length > 0) {
  console.error(`Seed password(s) too weak or placeholder: ${weak.join(", ")}.`);
  process.exit(1);
}

if (!parsed.DATABASE_URL) {
  console.error("DATABASE_URL is not set in .env.staging.local.");
  process.exit(1);
}
const databaseHost = (() => {
  try {
    return new URL(parsed.DATABASE_URL!).hostname.toLowerCase();
  } catch {
    return "";
  }
})();
if (
  databaseHost === "localhost" ||
  databaseHost === "127.0.0.1" ||
  databaseHost === "::1"
) {
  console.error("Refusing to seed: DATABASE_URL points at a local database, not hosted staging.");
  process.exit(1);
}

/** Stable identifiers, so a rerun finds exactly what the last run created. */
const SEED = {
  adminEmail: "demo-admin@seatflow.example",
  organizerEmail: "demo-organizer@seatflow.example",
  operatorEmail: "demo-operator@seatflow.example",
  customerEmail: parsed.RESEND_TEST_RECIPIENT ?? "demo-customer@seatflow.example",
  operatorOrganization: "SeatFlow Demo Venues",
  organizerOrganization: "SeatFlow Demo Presents",
  venueName: "Demo Concert Hall",
  spaceName: "Main Auditorium",
  seatMapName: "Demo layout",
  eventTitle: "SeatFlow Demo Concert",
} as const;

async function confirm(question: string) {
  if (assumeYes) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

console.log("SeatFlow staging seed");
console.log(`Target host: ${databaseHost.split(".").slice(1).join(".") || "[hidden]"}`);
console.log("");
console.log("Creates synthetic demo content. Idempotent: a rerun changes nothing.");
console.log("Never deletes, truncates, or rewrites existing data.");
console.log("");

if (!(await confirm('Type "yes" to seed the staging database: '))) {
  console.log("Aborted. Nothing was written.");
  process.exit(0);
}

const database = new PrismaClient({
  adapter: new PrismaPg({ connectionString: parsed.DATABASE_URL! }),
});
const auth = createSeatFlowAuth(
  {
    DATABASE_URL: parsed.DATABASE_URL!,
    BETTER_AUTH_SECRET: parsed.BETTER_AUTH_SECRET!,
    BETTER_AUTH_URL: parsed.BETTER_AUTH_URL!,
  },
  database,
);

/** Reuses an existing account rather than failing or duplicating. */
async function ensureAccount(input: { email: string; password: string; name: string }) {
  const existing = await database.user.findUnique({ where: { email: input.email } });
  if (existing) return { id: existing.id, created: false };
  await auth.api.signUpEmail({
    body: { email: input.email, password: input.password, name: input.name },
  });
  const created = await database.user.findUniqueOrThrow({ where: { email: input.email } });
  return { id: created.id, created: true };
}

const summary: Record<string, string | number> = {};

try {
  // ---- Accounts ----------------------------------------------------------
  const admin = await ensureAccount({
    email: SEED.adminEmail,
    password: parsed.STAGING_SEED_ADMIN_PASSWORD!,
    name: "Demo Platform Admin",
  });
  // Promoting an existing ADMIN again is a no-op, so this stays idempotent.
  await database.user.update({
    where: { id: admin.id },
    data: { platformRole: "ADMIN" },
  });

  const operatorOwner = await ensureAccount({
    email: SEED.operatorEmail,
    password: parsed.STAGING_SEED_OPERATOR_PASSWORD!,
    name: "Demo Venue Operator",
  });
  const organizerOwner = await ensureAccount({
    email: SEED.organizerEmail,
    password: parsed.STAGING_SEED_ORGANIZER_PASSWORD!,
    name: "Demo Organizer",
  });
  const customer = await ensureAccount({
    email: SEED.customerEmail,
    password: parsed.STAGING_SEED_CUSTOMER_PASSWORD!,
    name: "Demo Customer",
  });
  summary.accountsCreated = [admin, operatorOwner, organizerOwner, customer].filter(
    (account) => account.created,
  ).length;

  // ---- Venue -------------------------------------------------------------
  let operator = await database.organization.findFirst({
    where: { name: SEED.operatorOrganization, kind: "VENUE_OPERATOR" },
  });
  operator ??= await createVenueOperatorOrganization(database, {
    userId: operatorOwner.id,
    name: SEED.operatorOrganization,
  });

  let venue = await database.venue.findFirst({
    where: { organizationId: operator.id, name: SEED.venueName },
  });
  venue ??= await createVenue(
    database,
    { userId: operatorOwner.id, organizationSlug: operator.slug },
    {
      name: SEED.venueName,
      addressLine1: "1 Demonstration Street",
      city: "Baku",
      countryCode: "AZ",
      timeZone: "Asia/Baku",
      status: "ACTIVE",
    },
  );

  let space = await database.space.findFirst({
    where: { venueId: venue.id, name: SEED.spaceName },
  });
  space ??= await createSpace(
    database,
    { userId: operatorOwner.id, organizationSlug: operator.slug, venueSlug: venue.slug },
    { name: SEED.spaceName, type: "THEATRE", status: "ACTIVE" },
  );

  const mapScope = {
    userId: operatorOwner.id,
    organizationSlug: operator.slug,
    venueSlug: venue.slug,
    spaceSlug: space.slug,
  };
  let seatMap = await database.seatMap.findFirst({
    where: { spaceId: space.id, status: "PUBLISHED" },
    orderBy: { version: "desc" },
  });
  if (!seatMap) {
    const draft = await createDraftSeatMap(database, mapScope, { name: SEED.seatMapName });
    const section = await createSection(
      database,
      { ...mapScope, seatMapId: draft.id },
      { name: "Stalls", code: "STALLS" },
    );
    await bulkGenerateRows(
      database,
      { ...mapScope, seatMapId: draft.id, sectionId: section.id },
      {
        startRowLabel: "A",
        rowCount: 6,
        seatsPerRow: 12,
        startSeatNumber: 1,
        horizontalSpacing: 40,
        verticalSpacing: 40,
      },
    );
    await publishSeatMap(database, { ...mapScope, seatMapId: draft.id });
    seatMap = await database.seatMap.findFirstOrThrow({
      where: { spaceId: space.id, status: "PUBLISHED" },
      orderBy: { version: "desc" },
    });
  }
  summary.seats = await database.seat.count({
    where: { row: { section: { seatMapId: seatMap.id } } },
  });

  // ---- Organizer ---------------------------------------------------------
  let organizer = await database.organization.findFirst({
    where: { name: SEED.organizerOrganization, kind: "ORGANIZER" },
  });
  organizer ??= await createOrganizerOrganization(database, {
    userId: organizerOwner.id,
    name: SEED.organizerOrganization,
  });

  const existingGrant = await database.venueAccessGrant.findFirst({
    where: {
      venueId: venue.id,
      organizerOrganizationId: organizer.id,
      status: "ACTIVE",
    },
  });
  if (!existingGrant) {
    await grantVenueAccess(
      database,
      { userId: operatorOwner.id, organizationSlug: operator.slug, venueSlug: venue.slug },
      organizer.slug,
    );
  }

  // ---- Event and session -------------------------------------------------
  let event = await database.event.findFirst({
    where: { organizerOrganizationId: organizer.id, title: SEED.eventTitle },
  });
  const organizerScope = {
    userId: organizerOwner.id,
    organizationSlug: organizer.slug,
    eventSlug: "",
  };
  if (!event) {
    event = await createEvent(
      database,
      { userId: organizerOwner.id, organizationSlug: organizer.slug },
      {
        title: SEED.eventTitle,
        shortDescription: "A synthetic event used to demonstrate SeatFlow.",
        description:
          "This event exists only to demonstrate seat selection, holds, simulated checkout, and ticket issuance. No performance takes place and no payment is real.",
        category: "CONCERT",
        imagePath: "/events/aurora-room.svg",
      },
    );
  }
  organizerScope.eventSlug = event.slug;

  const existingSession = await database.eventSession.findFirst({
    where: { eventId: event.id },
    orderBy: { startAt: "desc" },
  });

  if (!existingSession) {
    const minute = 60 * 1_000;
    const start = new Date(Date.now() + 14 * 24 * 60 * minute);
    const session = await createEventSession(database, organizerScope, {
      venueId: venue.id,
      spaceId: space.id,
      seatMapId: seatMap.id,
      startLocal: toVenueLocalInputValue(start, venue.timeZone),
      endLocal: toVenueLocalInputValue(new Date(start.getTime() + 120 * minute), venue.timeZone),
      salesStartLocal: toVenueLocalInputValue(new Date(Date.now() - 60 * minute), venue.timeZone),
      salesEndLocal: toVenueLocalInputValue(new Date(start.getTime() - minute), venue.timeZone),
    });
    const sessionScope = { ...organizerScope, sessionId: session.id };
    const tier = await createSessionPriceTier(database, sessionScope, {
      name: "Standard",
      code: "STD",
      priceMinor: 5_000,
      currency: "AZN",
    });
    const sections = await database.seatSection.findMany({
      where: { seatMapId: seatMap.id },
      select: { id: true },
    });
    await assignSessionSectionPricing(database, sessionScope, {
      assignments: sections.map((section) => ({
        sectionId: section.id,
        priceTierId: tier.id,
      })),
    });
    await publishEventSession(database, sessionScope);
    summary.sessionCreated = 1;
  } else {
    summary.sessionCreated = 0;
  }

  if (event.status !== "PUBLISHED") {
    await publishEvent(database, organizerScope);
  }

  summary.events = await database.event.count({
    where: { organizerOrganizationId: organizer.id },
  });
  summary.sessions = await database.eventSession.count({ where: { eventId: event.id } });
} finally {
  await database.$disconnect();
}

console.log("");
console.log("Staging seed complete.");
for (const [key, value] of Object.entries(summary)) {
  console.log(`  ${key}: ${value}`);
}
console.log("");
console.log("Demo sign-in addresses (passwords are the ones you set locally):");
console.log(`  admin      ${SEED.adminEmail}`);
console.log(`  organizer  ${SEED.organizerEmail}`);
console.log(`  operator   ${SEED.operatorEmail}`);
console.log(`  customer   ${SEED.customerEmail}`);
console.log("");
console.log("No booking, payment, refund, or ticket history was created or removed.");
