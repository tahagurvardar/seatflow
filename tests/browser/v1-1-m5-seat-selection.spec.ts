import { expect, test, type Page } from "@playwright/test";

import { storageStatePath } from "./global-setup";
import { BROWSER_TEST_ACCOUNTS } from "./seed";
import {
  createSeatSession,
  releaseActiveHolds,
  type SeatSessionFixture,
  seatsPath as fixtureSeatsPath,
} from "./seat-session-fixture";

/**
 * M5.4 SF-04 seat-selection page composition in a real browser.
 *
 * A dedicated two-section, two-tier session is built through the real
 * services in the isolated test database (never the development database:
 * `createBrowserTestDatabase` refuses anything else). The hold placed by the
 * signed-in test is released again afterwards. Screenshots are written only
 * when M5_SCREENSHOT_DIR is set, to a directory outside the repository.
 */

const WIDTHS = [1440, 768, 390, 320] as const;
const HEIGHT_FOR: Record<number, number> = { 1440: 900, 768: 1024, 390: 844, 320: 640 };

let fixture: SeatSessionFixture;
let heldToken: string | null = null;

function seatsPath() {
  return fixtureSeatsPath(fixture);
}

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: HEIGHT_FOR[width]! });
  await page.goto(seatsPath(), { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: fixture.title })).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

/** Instant scroll: the site enables smooth scrolling globally. */
async function scrollToY(page: Page, y: "top" | "bottom" | "form") {
  await page.evaluate((target) => {
    const top =
      target === "top"
        ? 0
        : target === "bottom"
          ? document.documentElement.scrollHeight
          : document.querySelector("form")!.getBoundingClientRect().top + window.scrollY - 80;
    window.scrollTo({ top, behavior: "instant" });
  }, y);
}

async function capture(page: Page, name: string, fullPage = true) {
  const directory = process.env.M5_SCREENSHOT_DIR;
  if (directory) await page.screenshot({ path: `${directory}/${name}.png`, fullPage });
}

function desktopProjectOnly() {
  return test.info().project.name === "desktop";
}

test.beforeAll(async () => {
  if (!desktopProjectOnly()) return;
  fixture = await createSeatSession("M54", [
    { name: "Stalls", code: "ST", rows: 8, seatsPerRow: 16, tier: { name: "Front Stalls", code: "FRONT", priceMinor: 4_500 } },
    { name: "Balcony", code: "BA", rows: 4, seatsPerRow: 12, tier: { name: "Balcony", code: "BAL", priceMinor: 2_500 } },
  ]);
});

test.afterAll(async () => {
  if (heldToken && desktopProjectOnly()) {
    await releaseActiveHolds(fixture.sessionId, { email: BROWSER_TEST_ACCOUNTS.otherCustomer.email });
  }
});

test.beforeEach(() => {
  // Viewports are set per step; one project is enough.
  test.skip(!desktopProjectOnly(), "Runs once; widths are set explicitly.");
});

test.describe("M5.4 seat selection: signed-out preview", () => {
  test("is a read-only preview with a working sign-in path at every width", async ({ page }) => {
    for (const width of WIDTHS) {
      await open(page, width);
      await expectNoHorizontalOverflow(page);
      const signIn = page.getByRole("link", { name: "Sign in to continue" });
      await expect(signIn).toHaveAttribute("href", `/login?redirectTo=${encodeURIComponent(seatsPath())}`);
      await expect(page.getByRole("button", { name: /^Hold/ })).toHaveCount(0);
      await expect(page.getByRole("timer")).toHaveCount(0);
      await expect(page.getByRole("group", { name: /^Seat availability preview/ })).toHaveCount(1);
      await expect(page.locator("[data-seat-id]").first()).toBeVisible();
      await capture(page, `preview-${width}`);
    }
  });
});

test.describe("M5.4 seat selection: signed-in customer", () => {
  test.use({ storageState: storageStatePath("otherCustomer") });

  test("desktop: keyboard selection syncs map, list and rail", async ({ page }) => {
    await open(page, 1440);
    const rail = page.getByRole("complementary", { name: "Your selection" });
    await expect(rail).toBeVisible();
    await expect(page.locator('[data-summary-variant="sheet"]')).toBeHidden();

    await page.locator("[data-seat-id]").first().focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    const pressed = page.locator('[data-seat-id][aria-pressed="true"]');
    await expect(pressed).toHaveCount(1);
    const seatId = await pressed.getAttribute("data-seat-id");
    await expect(page.locator(`[data-list-seat-id="${seatId}"]`)).toHaveAttribute("aria-pressed", "true");
    await expect(rail).toContainText(/Seats selected — not reserved yet\. 1 of \d+ seats selected\./);
    await expect(rail.getByTestId("selection-total")).toHaveText(/AZN\s45\.00/);
    await expect(rail).toContainText("Front Stalls");
    await expect(rail.getByRole("button", { name: "Hold 1 seat" })).toBeEnabled();
    await expectNoHorizontalOverflow(page);
    await capture(page, "selected-1440");
  });

  test("tablet and mobile: the sheet keeps the hold action in view and never covers the footer", async ({ page }) => {
    for (const width of [768, 390, 320] as const) {
      await open(page, width);
      await expect(page.getByRole("complementary", { name: "Your selection" })).toBeHidden();
      const listSeat = page.locator("[data-list-seat-id]").first();
      await listSeat.focus();
      await page.keyboard.press(" ");
      await expect(listSeat).toHaveAttribute("aria-pressed", "true");

      const sheet = page.locator('[data-summary-variant="sheet"]');
      await expect(sheet).toBeVisible();
      const hold = sheet.getByRole("button", { name: "Hold 1 seat" });
      await expect(hold).toBeEnabled();
      // Pinned to the bottom of the viewport while the map is in view. (At
      // scroll 0 a sticky sheet cannot rise above the top of its form, so on
      // short phones it starts partly below the fold until the map is reached.)
      await scrollToY(page, "form");
      const viewportHeight = HEIGHT_FOR[width]!;
      const holdBox = (await hold.boundingBox())!;
      expect(holdBox.y + holdBox.height).toBeLessThanOrEqual(viewportHeight);
      const sheetBox = (await sheet.boundingBox())!;
      expect(sheetBox.height).toBeLessThanOrEqual(viewportHeight * 0.7 + 1);
      await expectNoHorizontalOverflow(page);
      await capture(page, `selected-${width}`, false);

      // At the end of the page the sheet sits above the footer, not over it.
      await scrollToY(page, "bottom");
      const footer = page.locator("footer").last();
      const footerBox = await footer.boundingBox();
      const sheetEnd = (await sheet.boundingBox())!;
      if (footerBox) expect(sheetEnd.y + sheetEnd.height).toBeLessThanOrEqual(footerBox.y + 1);

      // Expanding the details keeps part of the map visible.
      await scrollToY(page, "form");
      await sheet.getByRole("button", { name: "View details" }).click();
      const expanded = (await sheet.boundingBox())!;
      expect(expanded.height).toBeLessThanOrEqual(viewportHeight * 0.7 + 1);
      await capture(page, `sheet-expanded-${width}`, false);
    }
  });

  test("a confirmed hold navigates to the hold, then the page shows a real countdown", async ({ page }) => {
    await open(page, 390);
    await page.locator("[data-list-seat-id]").first().click();
    const sheet = page.locator('[data-summary-variant="sheet"]');
    await Promise.all([
      page.waitForURL(/\/customer\/holds\//, { timeout: 30_000 }),
      sheet.getByRole("button", { name: "Hold 1 seat" }).click(),
    ]);
    heldToken = new URL(page.url()).pathname.split("/").pop() ?? null;
    expect(heldToken).toBeTruthy();

    for (const width of [390, 1440] as const) {
      await open(page, width);
      // Rendered at the top below lg and in the side column from lg; role
      // queries skip the copy that is display:none at this width.
      const notice = page.getByRole("status").filter({ hasText: "You already have an active hold" });
      await expect(notice).toHaveCount(1);
      await expect(notice.getByRole("timer")).toHaveText(/^\d+:\d{2}$/);
      await expect(notice.getByRole("link", { name: "View your hold" })).toHaveAttribute(
        "href",
        `/customer/holds/${heldToken}`,
      );
      await expect(page.getByRole("button", { name: /^Hold/ })).toHaveCount(0);
      await expect(page.locator('[data-seat-id][aria-label*="held by you"]')).toHaveCount(1);
      await expectNoHorizontalOverflow(page);
      await capture(page, `active-hold-${width}`);
    }
  });
});
