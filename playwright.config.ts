import { config as loadEnvironment } from "dotenv";
import { defineConfig, devices } from "@playwright/test";

loadEnvironment();

/**
 * Browser verification.
 *
 * Two properties matter more than convenience here:
 *
 *  - **The application under test is pointed at `seatflow_test`.** The dev
 *    server's `.env` would otherwise resolve `DATABASE_URL` to the development
 *    `seatflow` database, and a browser suite that signs up users and requests
 *    refunds must never touch it. Next.js does not override an
 *    already-set `process.env` value, so the explicit assignment below wins.
 *  - **Verification runs against a production build.** The dev server injects a
 *    hot-reload WebSocket and always renders the Next.js dev-tools portal, so
 *    "no console errors" and "no framework overlay" are unverifiable there.
 *
 * Nothing is exposed beyond loopback.
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL must be set. The browser suite refuses to run against the development database.",
  );
}

export default defineConfig({
  testDir: "./tests/browser",
  globalSetup: "./tests/browser/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "off",
    // Off by default: a captured page could contain a customer email or a
    // booking reference.
    screenshot: "off",
    video: "off",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile-390x844",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } },
      // The refund lifecycle is stateful against one seeded booking, so it runs
      // once on desktop only. Running it again here would collide with its own
      // fixture rather than test anything about this viewport.
      testIgnore: /phase-5c2a-refund-e2e\.spec\.ts$/,
    },
  ],
  webServer: {
    command: "npm run build && npm run start -- --hostname 127.0.0.1 --port 3000",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      // The whole point: the served application reads and writes the
      // disposable test database only.
      DATABASE_URL: testDatabaseUrl,
      DIRECT_URL: testDatabaseUrl,
      BETTER_AUTH_URL: "http://127.0.0.1:3000",
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
      NODE_ENV: "production",
      // Permits the simulated LOCAL_SIGNED provider under a production build.
      // The flag alone grants nothing: `evaluateIsolatedE2EMode` additionally
      // requires a test-marked database that is not the protected one, loopback
      // origins, a synthetic local secret, and the absence of any real provider
      // credential. `production:check` rejects this flag outright.
      SEATFLOW_E2E_TEST_MODE: "true",
      PAYMENT_PROVIDER: "LOCAL_SIGNED",
      // Names the database this harness must never be pointed at.
      SEATFLOW_PROTECTED_DATABASE_URL: process.env.DATABASE_URL ?? "",
    },
  },
});
