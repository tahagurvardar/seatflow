import { writeFileSync } from "node:fs";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { storageStatePath } from "./global-setup";
import { BROWSER_TEST_ACCOUNTS } from "./seed";
import {
  countHolds,
  createSeatSession,
  holdAsCompetitor,
  releaseActiveHolds,
  type SeatSessionFixture,
  seatsPath,
} from "./seat-session-fixture";

/**
 * M5.5 seat-selection QA in a real browser: responsive matrix, keyboard and
 * focus, touch targets, browser zoom, reduced motion, orientation, stale
 * availability gating, contention and hold expiry presentation.
 *
 * Runs against the production build on the isolated test database only.
 * Every hold created here is released through the real hold service in
 * afterAll. Measurements and screenshots go to M5_SCREENSHOT_DIR (outside the
 * repository) when it is set.
 */

const OUTPUT = process.env.M5_SCREENSHOT_DIR;
const customer = BROWSER_TEST_ACCOUNTS.otherCustomer;
let fixture: SeatSessionFixture;
const measurements: Record<string, unknown> = {};

function desktopProjectOnly() {
  return test.info().project.name === "desktop";
}

test.beforeAll(async () => {
  if (!desktopProjectOnly()) return;
  fixture = await createSeatSession("M55", [
    { name: "Stalls", code: "ST", rows: 8, seatsPerRow: 16, tier: { name: "Front Stalls", code: "FRONT", priceMinor: 4_500 } },
    { name: "Balcony", code: "BA", rows: 4, seatsPerRow: 12, tier: { name: "Balcony", code: "BAL", priceMinor: 2_500 } },
  ]);
});

test.afterAll(async () => {
  if (!desktopProjectOnly() || !fixture) return;
  await releaseActiveHolds(fixture.sessionId, { email: customer.email });
  await releaseActiveHolds(fixture.sessionId, { userId: fixture.competitorUserId });
  if (OUTPUT) writeFileSync(`${OUTPUT}/qa-measurements.json`, JSON.stringify(measurements, null, 2));
});

test.beforeEach(() => {
  test.skip(!desktopProjectOnly(), "Runs once; viewports are set explicitly.");
});

test.use({ storageState: storageStatePath("otherCustomer") });

async function open(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto(seatsPath(fixture), { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: fixture.title })).toBeVisible();
}

/** Instant scroll (the site enables smooth scrolling globally). */
async function scrollTo(page: Page, target: "top" | "map" | "bottom") {
  await page.evaluate((where) => {
    const top =
      where === "top"
        ? 0
        : where === "bottom"
          ? document.documentElement.scrollHeight
          : document.querySelector('[data-testid="seat-map-viewport"]')!.getBoundingClientRect().top + window.scrollY - 90;
    window.scrollTo({ top, behavior: "instant" });
  }, target);
}

async function horizontalOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  if (!result) throw new Error("Element has no layout box.");
  return result;
}

const sheet = (page: Page) => page.locator('[data-summary-variant="sheet"]');
const rail = (page: Page) => page.getByRole("complementary", { name: "Your selection" });

async function capture(page: Page, name: string, fullPage = false) {
  if (OUTPUT) await page.screenshot({ path: `${OUTPUT}/${name}.png`, fullPage });
}

/** Seats whose visible box intersects the zoom toolbar (inside the map). */
async function seatsUnderToolbar(page: Page) {
  return page.evaluate(() => {
    const toolbar = document.querySelector('[role="toolbar"][aria-label="Map zoom"]')!.getBoundingClientRect();
    const surface = document.querySelector('[data-testid="seat-map-viewport"]')!.getBoundingClientRect();
    let count = 0;
    for (const seat of document.querySelectorAll("[data-seat-id]")) {
      const r = seat.getBoundingClientRect();
      const visible = r.right > surface.left && r.left < surface.right && r.bottom > surface.top && r.top < surface.bottom;
      const overlaps = r.right > toolbar.left && r.left < toolbar.right && r.bottom > toolbar.top && r.top < toolbar.bottom;
      if (visible && overlaps) count += 1;
    }
    return count;
  });
}

const MATRIX = [
  { width: 320, height: 640 },
  { width: 360, height: 740 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

test("responsive matrix: overflow, toolbar, sheet sizes and CTA during selection", async ({ page }) => {
  const rows: Record<string, unknown>[] = [];
  for (const { width, height } of MATRIX) {
    await open(page, width, height);
    const row: Record<string, unknown> = { width, height };
    row.overflowPx = await horizontalOverflow(page);
    expect(row.overflowPx).toBeLessThanOrEqual(1);
    row.seatsUnderToolbar = await seatsUnderToolbar(page);
    expect(row.seatsUnderToolbar).toBe(0);
    await capture(page, `matrix-${width}-initial`, true);

    // Select one seat the way a phone user would: on the map, after scrolling to it.
    await scrollTo(page, "map");
    await page.locator("[data-seat-id]").nth(2).click();
    await expect(page.locator('[data-seat-id][aria-pressed="true"]')).toHaveCount(1);

    if (width < 1024) {
      await expect(rail(page)).toBeHidden();
      const collapsed = await box(sheet(page));
      row.sheetCollapsedPx = Math.round(collapsed.height);
      row.sheetCollapsedPct = Math.round((collapsed.height / height) * 100);
      const hold = await box(sheet(page).getByRole("button", { name: "Hold 1 seat" }));
      row.holdVisibleAfterMapScroll = hold.y >= 0 && hold.y + hold.height <= height;
      expect(row.holdVisibleAfterMapScroll).toBe(true);
      const viewport = await box(page.getByTestId("seat-map-viewport"));
      row.mapVisiblePx = Math.round(Math.max(0, Math.min(collapsed.y, viewport.y + viewport.height) - Math.max(0, viewport.y)));
      await capture(page, `matrix-${width}-selected`);

      await sheet(page).getByRole("button", { name: "View details" }).click();
      const expanded = await box(sheet(page));
      row.sheetExpandedPx = Math.round(expanded.height);
      expect(expanded.height).toBeLessThanOrEqual(height * 0.7 + 1);
      await capture(page, `matrix-${width}-expanded`);
      await sheet(page).getByRole("button", { name: "Hide details" }).click();

      await scrollTo(page, "bottom");
      const footer = await page.locator("footer").last().boundingBox();
      const end = await box(sheet(page));
      row.sheetAboveFooter = !footer || end.y + end.height <= footer.y + 1;
      expect(row.sheetAboveFooter).toBe(true);
    } else {
      await expect(sheet(page)).toBeHidden();
      const railBox = await box(rail(page));
      row.railWidthPx = Math.round(railBox.width);
      row.railTopPx = Math.round(railBox.y);
      await expect(rail(page).getByRole("button", { name: "Hold 1 seat" })).toBeVisible();
      await capture(page, `matrix-${width}-selected`);
    }
    rows.push(row);
  }
  measurements.responsive = rows;
});

test("keyboard only: focus order, visible focus, roving tab stops and focus clear of the sheet", async ({ page }) => {
  await open(page, 390, 844);
  await scrollTo(page, "top");
  const visited: string[] = [];
  let focusedSeat = false;
  for (let step = 0; step < 40 && !focusedSeat; step += 1) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const style = getComputedStyle(el);
      return {
        name: el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? el.tagName,
        seat: el.hasAttribute("data-seat-id"),
        visibleFocus: style.outlineStyle !== "none" || style.boxShadow !== "none",
      };
    });
    visited.push(info.name);
    expect(info.visibleFocus, `visible focus on "${info.name}"`).toBe(true);
    focusedSeat = info.seat;
  }
  expect(focusedSeat).toBe(true);
  measurements.focusOrderToFirstSeat = visited;
  // One roving tab stop for the whole map, and one for the list.
  await expect(page.locator('[data-seat-id][tabindex="0"]')).toHaveCount(1);
  await expect(page.locator('[data-list-seat-id][tabindex="0"]')).toHaveCount(1);

  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-seat-id][aria-pressed="true"]')).toHaveCount(1);
  const announced = await page.locator('[data-seat-id][aria-pressed="true"]').getAttribute("aria-label");
  expect(announced).toMatch(/^Stalls, row B, seat 2, available, AZN.45\.00$/);

  // Focus a list seat at the end of the row with the keyboard: it must not
  // end up hidden behind the sticky sheet.
  await page.locator("[data-list-seat-id]").first().focus();
  await page.keyboard.press("End");
  // Focus scrolling is animated (the site uses smooth scrolling), so poll for
  // the settled position.
  const clearance = async () => {
    const focused = await box(page.locator("[data-list-seat-id]:focus"));
    const sheetBox = await box(sheet(page));
    return Math.round(sheetBox.y - (focused.y + focused.height));
  };
  await expect.poll(clearance, { timeout: 5_000 }).toBeGreaterThanOrEqual(0);
  measurements.listFocusClearanceAboveSheetPx = await clearance();
});

test("touch targets: interactive controls are at least 44x44 except the documented map seats", async ({ page }) => {
  await open(page, 390, 844);
  await page.locator("[data-list-seat-id]").first().click();
  const report = await page.evaluate(() => {
    const scope = document.querySelector("main")!;
    const small: string[] = [];
    let checked = 0;
    let mapSeatPx = 0;
    for (const el of scope.querySelectorAll<HTMLElement>("button, a[href], select")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (el.hasAttribute("data-seat-id")) {
        mapSeatPx = Math.round(r.width);
        continue;
      }
      checked += 1;
      if (r.width < 43.5 || r.height < 43.5) small.push(`${el.getAttribute("aria-label") ?? el.textContent?.trim()} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return { checked, small, mapSeatPx };
  });
  measurements.touchTargets = report;
  expect(report.small).toEqual([]);
});

test("browser zoom 200% and 400% (reflow widths) keep the page usable", async ({ page }) => {
  const results: Record<string, unknown>[] = [];
  // 1280x1024 at 200% → 640x512 CSS px; at 400% → 320x256 CSS px.
  for (const [zoom, width, height] of [["200%", 640, 512], ["400%", 320, 256]] as const) {
    await open(page, width, height);
    const overflow = await horizontalOverflow(page);
    expect(overflow).toBeLessThanOrEqual(1);
    await scrollTo(page, "map");
    await page.locator("[data-list-seat-id]").first().focus();
    await page.keyboard.press(" ");
    await scrollTo(page, "map");
    const position = await sheet(page).evaluate((element) => getComputedStyle(element).position);
    const sheetBox = await box(sheet(page));
    const holdButton = sheet(page).getByRole("button", { name: "Hold 1 seat" });
    let holdVisible: boolean;
    if (position === "sticky") {
      const hold = await box(holdButton);
      holdVisible = hold.y >= 0 && hold.y + hold.height <= height;
      expect(holdVisible).toBe(true);
    } else {
      // Not pinned on very short viewports: the map stays uncovered and the
      // hold action is reached by scrolling, like any other content.
      const map = await box(page.getByTestId("seat-map-viewport"));
      expect(sheetBox.y).toBeGreaterThanOrEqual(map.y + map.height);
      await holdButton.scrollIntoViewIfNeeded();
      await expect(holdButton).toBeInViewport();
      holdVisible = true;
    }
    results.push({ zoom, width, height, overflowPx: overflow, sheetPosition: position, sheetPx: Math.round(sheetBox.height), holdVisible });
    await capture(page, `zoom-${zoom.replace("%", "")}`);
  }
  measurements.browserZoom = results;
});

test("reduced motion and landscape orientation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, 844, 390);
  const motion = await page.evaluate(() => ({
    scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
    mapTransition: getComputedStyle(document.querySelector('[data-testid="seat-map-content"]')!).transitionDuration,
  }));
  measurements.reducedMotion = motion;
  expect(motion.scrollBehavior).toBe("auto");
  await page.getByRole("button", { name: "Zoom in" }).click();
  const afterZoom = await page.evaluate(
    () => getComputedStyle(document.querySelector('[data-testid="seat-map-content"]')!).transitionDuration,
  );
  expect(afterZoom).toMatch(/^0s|^1e-05s|^0\.00001s/);

  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  await scrollTo(page, "map");
  await page.locator("[data-seat-id]").nth(1).click();
  await scrollTo(page, "map");
  const hold = await box(sheet(page).getByRole("button", { name: "Hold 1 seat" }));
  const sheetBox = await box(sheet(page));
  measurements.landscape844x390 = { sheetPx: Math.round(sheetBox.height), holdBottom: Math.round(hold.y + hold.height) };
  expect(hold.y + hold.height).toBeLessThanOrEqual(390);
  await capture(page, "landscape-844x390");
});

test("stale availability pauses holding; a successful retry resumes it", async ({ page }) => {
  await open(page, 1440, 900);
  await page.locator("[data-seat-id]").first().click();
  await page.route("**/api/inventory/sessions/**", (route) => route.abort());
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText(/couldn't refresh seat availability/i)).toBeVisible();
  await expect(rail(page).getByRole("button", { name: "Hold 1 seat" })).toBeDisabled();
  await expect(rail(page).getByText(/Holding is paused/)).toBeVisible();
  await capture(page, "stale-paused-1440");

  await page.unroute("**/api/inventory/sessions/**");
  await rail(page).getByRole("button", { name: "Check availability again" }).click();
  await expect(rail(page).getByRole("button", { name: "Hold 1 seat" })).toBeEnabled();
  await expect(page.locator('[data-seat-id][aria-pressed="true"]')).toHaveCount(1);
});

test("contention: a seat taken by another customer is refused and refreshed", async ({ page }) => {
  await open(page, 1440, 900);
  const seat = page.locator("[data-seat-id]").nth(5);
  const seatId = (await seat.getAttribute("data-seat-id"))!;
  await seat.click();
  await holdAsCompetitor(fixture, seatId);

  await rail(page).getByRole("button", { name: "Hold 1 seat" }).click();
  await expect(rail(page).getByRole("alert")).toBeVisible({ timeout: 15_000 });
  measurements.conflictMessage = await rail(page).getByRole("alert").textContent();
  // The conflict triggers an authoritative refresh: the seat turns unavailable
  // and the local selection drops it.
  await expect(page.locator(`[data-seat-id="${seatId}"]`)).toHaveAttribute("aria-label", /unavailable/, { timeout: 15_000 });
  await expect(page.locator('[data-seat-id][aria-pressed="true"]')).toHaveCount(0);
  expect(page.url()).not.toMatch(/\/customer\/holds\//);
  await capture(page, "conflict-1440");
  await releaseActiveHolds(fixture.sessionId, { userId: fixture.competitorUserId });
});

test("one hold for a double submit, then an honest expiry presentation", async ({ page }) => {
  const before = await countHolds(fixture.sessionId, customer.email);
  await open(page, 390, 844);
  await scrollTo(page, "map");
  await page.locator("[data-seat-id]").nth(3).click();
  const hold = sheet(page).getByRole("button", { name: "Hold 1 seat" });
  await Promise.all([
    page.waitForURL(/\/customer\/holds\//, { timeout: 30_000 }),
    hold.dblclick(),
  ]);
  expect(await countHolds(fixture.sessionId, customer.email)).toBe(before + 1);

  // Fast-forward the browser clock past the hold TTL. Only the informational
  // countdown is affected; the server still decides validity.
  await page.clock.install();
  await open(page, 390, 844);
  const notice = page.getByRole("status").filter({ hasText: "You already have an active hold" });
  await expect(notice.getByRole("timer")).toHaveText(/^\d+:\d{2}$/);
  await page.clock.fastForward("30:00");
  const expired = notice.getByText("Confirming with server…");
  await expect(expired).toBeVisible();
  const colors = await expired.evaluate((el) => {
    const color = getComputedStyle(el).color;
    let node: HTMLElement | null = el.parentElement;
    let background = "rgba(0, 0, 0, 0)";
    while (node && (background === "rgba(0, 0, 0, 0)" || background === "transparent")) {
      background = getComputedStyle(node).backgroundColor;
      node = node.parentElement;
    }
    return { color, background };
  });
  measurements.expiredNotice = colors;
  const parse = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
  const luminance = (rgb: number[]) => {
    const [r, g, b] = rgb.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [l1, l2] = [luminance(parse(colors.color)), luminance(parse(colors.background))];
  const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  measurements.expiredNoticeContrast = Number(ratio.toFixed(2));
  expect(ratio).toBeGreaterThanOrEqual(4.5);
  await capture(page, "expired-countdown-390");
});
