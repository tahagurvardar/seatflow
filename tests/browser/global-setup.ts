import { chromium, type FullConfig } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { ensureRefundFixture } from "./refund-fixture";
import { BROWSER_TEST_ACCOUNTS, seedBrowserAccounts, type BrowserAccountKey } from "./seed";

/**
 * Playwright global setup.
 *
 * Seeding is idempotent, so a repeated run reuses existing fixtures. The
 * database target is guarded inside `seed.ts`: it resolves through
 * `readSafeTestDatabaseUrl`, which refuses anything that is not a clearly
 * marked test database and refuses a URL equal to DATABASE_URL/DIRECT_URL, so
 * the development `seatflow` database is unreachable from this path.
 *
 * Each role signs in **once**, through the real login form, and the resulting
 * session is saved as storage state for the suite to reuse. Signing in per test
 * would hammer the Phase 5C1 login rate limiter and produce timeouts that look
 * like authorization failures but are really throttling. Nothing is forged: the
 * saved state is a genuine session obtained through the real flow.
 */

export const STORAGE_STATE_DIRECTORY = path.join(process.cwd(), "tests", "browser", ".auth");

export function storageStatePath(role: BrowserAccountKey) {
  return path.join(STORAGE_STATE_DIRECTORY, `${role}.json`);
}

const ROLES: BrowserAccountKey[] = [
  "customer",
  "otherCustomer",
  "organizer",
  "foreignOrganizer",
  "admin",
];

export default async function globalSetup(config: FullConfig) {
  const seeded = await seedBrowserAccounts();
  // Identifiers only. No password, session token, cookie, or auth row is
  // logged, here or anywhere else in the browser suite.
  process.env.BROWSER_ORGANIZATION_SLUG = seeded.organizationSlug;
  process.env.BROWSER_FOREIGN_ORGANIZATION_SLUG = seeded.foreignOrganizationSlug;

  // A genuinely paid, ticketed booking for the refund lifecycle test, built by
  // driving the real Phase 5A path rather than by writing rows.
  const refundFixture = await ensureRefundFixture(seeded.customerId);
  process.env.BROWSER_BOOKING_REFERENCE = refundFixture.bookingReference;
  process.env.BROWSER_PROVIDER_INTENT_ID = refundFixture.providerIntentId;
  process.env.BROWSER_SESSION_ID = refundFixture.sessionId;
  process.env.BROWSER_USED_TICKET_REFERENCE = refundFixture.usedTicketReference;
  process.env.BROWSER_PAID_MINOR = String(refundFixture.paidMinor);
  process.env.BROWSER_CURRENCY = refundFixture.currency;

  await mkdir(STORAGE_STATE_DIRECTORY, { recursive: true });
  const baseURL =
    config.projects[0]?.use?.baseURL ?? "http://127.0.0.1:3000";

  const browser = await chromium.launch();
  try {
    for (const role of ROLES) {
      const account = BROWSER_TEST_ACCOUNTS[role];
      const context = await browser.newContext({ baseURL });
      const page = await context.newPage();
      try {
        // The `auth.login` policy allows 10 attempts per 5 minutes per IP, and
        // it is a real protection that is deliberately NOT disabled for tests.
        // A throttled attempt is retried with backoff long enough to clear the
        // window; only genuine credential failures then surface as errors.
        let signedIn = false;
        let lastError: unknown;
        for (let attempt = 1; attempt <= 4 && !signedIn; attempt += 1) {
          try {
            await page.goto("/login", { waitUntil: "networkidle" });
            await page.fill("#email", account.email);
            await page.fill("#password", account.password);
            await Promise.all([
              page.waitForURL((url) => !url.pathname.startsWith("/login"), {
                timeout: 20_000,
              }),
              page.click('button[type="submit"]'),
            ]);
            signedIn = true;
          } catch (error) {
            lastError = error;
            if (attempt < 4) {
              // Long enough for the 300-second window to drain.
              await new Promise((resolve) => setTimeout(resolve, 90_000));
            }
          }
        }
        if (!signedIn) {
          throw new Error(
            `Browser fixture sign-in failed for role "${role}" after retries. ` +
              `Last error: ${lastError instanceof Error ? lastError.message : "unknown"}`,
          );
        }
        await context.storageState({ path: storageStatePath(role) });
      } finally {
        await context.close();
      }
      // A gap between sign-ins keeps the suite comfortably inside the policy.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  } finally {
    await browser.close();
  }
}
