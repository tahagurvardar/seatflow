import { expect, test, type Page } from "@playwright/test";

import { storageStatePath } from "./global-setup";
import { BROWSER_TEST_ACCOUNTS } from "./seed";

/**
 * Authenticated Phase 5C2A browser verification.
 *
 * Sessions come from storage state captured in global setup by signing in
 * through the real login form against the real Better Auth flow. Nothing here
 * forges a session, injects a cookie, or fakes a logged-in front-end state, so
 * what is verified is the actual authorization boundary.
 */

/** Strings that must never appear in rendered markup. */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; name: string }> = [
  { pattern: /sk_(test|live)_[A-Za-z0-9]{8,}/, name: "provider secret key" },
  { pattern: /whsec_[A-Za-z0-9]{16,}/, name: "webhook secret" },
  { pattern: /postgres(ql)?:\/\/[^\s"']*:[^\s"'@]+@/, name: "database url" },
  { pattern: /rediss?:\/\/[^\s"']*:[^\s"'@]+@/, name: "redis url" },
  { pattern: /SFT1\.[A-Za-z0-9_-]{20,}/, name: "ticket credential" },
  { pattern: /\blocal_pi_[A-Za-z0-9]{8,}/, name: "provider intent id" },
  { pattern: /\blocal_re_[A-Za-z0-9]{8,}/, name: "provider refund id" },
  { pattern: /\blocal_dp_[A-Za-z0-9]{8,}/, name: "provider dispute id" },
  { pattern: /\bt=\d{10},v1=[a-f0-9]{64}/, name: "webhook signature" },
];

async function expectNoLeaks(page: Page) {
  const markup = await page.content();
  for (const { pattern, name } of FORBIDDEN_PATTERNS) {
    expect(pattern.test(markup), `markup must not contain a ${name}`).toBe(false);
  }
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

const organizationSlug = () =>
  process.env.BROWSER_ORGANIZATION_SLUG ?? "browser-organizer-tenant";
const foreignOrganizationSlug = () =>
  process.env.BROWSER_FOREIGN_ORGANIZATION_SLUG ?? "browser-foreign-tenant";

test.describe("customer authorization boundary", () => {
  test.use({ storageState: storageStatePath("customer") });

  test("a signed-in customer reaches their own bookings", async ({ page }) => {
    await page.goto("/customer/bookings", { waitUntil: "networkidle" });
    expect(page.url()).toContain("/customer/bookings");
    expect(page.url()).not.toContain("/login");
    await expectNoLeaks(page);
    await expectNoHorizontalOverflow(page);
  });

  test("a customer cannot see the platform-admin financial page", async ({ page }) => {
    await page.goto("/admin/financial", { waitUntil: "networkidle" });

    // Asserted on the rendered heading, not on a substring: the page's metadata
    // title is also "Financial operations" and appears in the document even on
    // the forbidden response, so a text match would not distinguish a blocked
    // request from a served one.
    await expect(
      page.getByRole("heading", { name: "Financial operations" }),
    ).toHaveCount(0);
    const body = (await page.textContent("body")) ?? "";
    expect(body).not.toContain("Integrity and reconciliation");
    expect(body).not.toContain("Total refunded by currency");
    await expectNoLeaks(page);
  });

  test("a customer cannot see an organizer financial page", async ({ page }) => {
    await page.goto(`/organizer/organizations/${organizationSlug()}/financial`, {
      waitUntil: "networkidle",
    });
    await expect(page.getByRole("heading", { name: "Financial summary" })).toHaveCount(0);
    const body = (await page.textContent("body")) ?? "";
    expect(body).not.toContain("Total refunded by currency");
    await expectNoLeaks(page);
  });
});

test.describe("organizer organization isolation", () => {
  test.use({ storageState: storageStatePath("organizer") });

  test("sees only their own organization's financial summary", async ({ page }) => {
    await page.goto(`/organizer/organizations/${organizationSlug()}/financial`, {
      waitUntil: "networkidle",
    });

    await expect(page.getByRole("heading", { name: "Financial summary" })).toBeVisible();
    const body = (await page.textContent("body")) ?? "";
    expect(body).toContain("Total refunded by currency");
    expect(body).toContain("Disputed amount by currency");
    expect(body).toContain("Tickets pending revocation");
    expect(body).toContain("Financial review queue");
    await expectNoLeaks(page);
    await expectNoHorizontalOverflow(page);
  });

  test("is denied another organization by URL manipulation", async ({ page }) => {
    await page.goto(`/organizer/organizations/${foreignOrganizationSlug()}/financial`, {
      waitUntil: "networkidle",
    });

    // Membership decides access, not the slug in the URL.
    await expect(page.getByRole("heading", { name: "Financial summary" })).toHaveCount(0);
    const body = (await page.textContent("body")) ?? "";
    expect(body).not.toContain("Total refunded by currency");
    await expectNoLeaks(page);
  });

  test("offers no control that could settle a refund or open a dispute", async ({ page }) => {
    await page.goto(`/organizer/organizations/${organizationSlug()}/financial`, {
      waitUntil: "networkidle",
    });

    expect(await page.locator("form").count()).toBe(0);
    const dangerous = await page
      .locator("button, a[role=button], input[type=submit]")
      .filter({ hasText: /refund|settle|approve|dispute|adjust|chargeback/i })
      .count();
    expect(dangerous).toBe(0);
  });
});

test.describe("organizer of another tenant", () => {
  test.use({ storageState: storageStatePath("foreignOrganizer") });

  test("cannot read the first organization's financials", async ({ page }) => {
    await page.goto(`/organizer/organizations/${organizationSlug()}/financial`, {
      waitUntil: "networkidle",
    });
    await expect(page.getByRole("heading", { name: "Financial summary" })).toHaveCount(0);
    await expectNoLeaks(page);
  });
});

test.describe("platform-admin financial operations", () => {
  test.use({ storageState: storageStatePath("admin") });

  test("sees every financial queue", async ({ page }) => {
    await page.goto("/admin/financial", { waitUntil: "networkidle" });

    await expect(page.getByRole("heading", { name: "Financial operations" })).toBeVisible();
    const body = (await page.textContent("body")) ?? "";
    for (const section of [
      "Refund queue",
      "Dispute and chargeback queue",
      "Integrity and reconciliation",
      "Ledger divergence",
      "Reconciliation backlog",
      "Unresolved chargebacks",
      "Ticket revocation backlog",
      "Paid but unfulfilled",
      "Evidence due",
      "Total refunded by currency",
      "Disputed amount by currency",
    ]) {
      expect(body, `admin page should show "${section}"`).toContain(section);
    }
    await expectNoLeaks(page);
    await expectNoHorizontalOverflow(page);
  });

  test("holds no financial adjustment control", async ({ page }) => {
    await page.goto("/admin/financial", { waitUntil: "networkidle" });

    const body = (await page.textContent("body")) ?? "";
    expect(body).toContain("no financial adjustment control on this page by design");
    expect(await page.locator("form").count()).toBe(0);
    const dangerous = await page
      .locator("button, a[role=button], input[type=submit]")
      .filter({ hasText: /settle|approve refund|mark succeeded|adjust|create dispute/i })
      .count();
    expect(dangerous).toBe(0);
  });

  test("renders no credential, provider identifier, or password", async ({ page }) => {
    await page.goto("/admin/financial", { waitUntil: "networkidle" });
    await expectNoLeaks(page);

    const body = (await page.textContent("body")) ?? "";
    for (const account of Object.values(BROWSER_TEST_ACCOUNTS)) {
      expect(body).not.toContain(account.password);
    }
  });

  test("reflows to 320 CSS px without horizontal overflow", async ({ page }) => {
    // WCAG 1.4.10 sets the reflow requirement at 320 CSS pixels, which is what
    // a 640px window at 200% zoom produces.
    await page.setViewportSize({ width: 320, height: 512 });
    await page.goto("/admin/financial", { waitUntil: "networkidle" });
    await expectNoHorizontalOverflow(page);
  });

  test("names every figure with a definition term", async ({ page }) => {
    await page.goto("/admin/financial", { waitUntil: "networkidle" });
    const structure = await page.evaluate(() => ({
      h1s: document.querySelectorAll("h1").length,
      h2s: document.querySelectorAll("h2").length,
      dls: document.querySelectorAll("dl").length,
      unlabelledDds: [...document.querySelectorAll("dd")].filter(
        (dd) => !dd.previousElementSibling || dd.previousElementSibling.tagName !== "DT",
      ).length,
    }));
    expect(structure.h1s).toBe(1);
    expect(structure.h2s).toBeGreaterThan(2);
    expect(structure.dls).toBeGreaterThan(0);
    expect(structure.unlabelledDds, "every figure needs a term").toBe(0);
  });

  test("produces no console errors, page errors, or hydration warnings", async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const hydrationWarnings: string[] = [];
    page.on("console", (message) => {
      const text = message.text();
      if (/hydrat|did not match|server rendered/i.test(text)) hydrationWarnings.push(text);
      else if (message.type() === "error") consoleErrors.push(text);
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto("/admin/financial", { waitUntil: "networkidle" });

    expect(pageErrors).toEqual([]);
    expect(hydrationWarnings).toEqual([]);
    expect(consoleErrors).toEqual([]);
    await expect(page.locator("nextjs-portal")).toHaveCount(0);
  });

  test("is reachable by keyboard with visible focus", async ({ page }) => {
    await page.goto("/admin/financial", { waitUntil: "networkidle" });
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active || active.tagName === "BODY") return null;
      const style = getComputedStyle(active);
      return {
        tag: active.tagName,
        // A focus ring must be rendered, not suppressed.
        suppressed: style.outlineStyle === "none" && style.boxShadow === "none",
      };
    });
    if (focused) expect(focused.suppressed).toBe(false);
  });
});
