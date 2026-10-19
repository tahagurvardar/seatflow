import { writeFileSync } from "node:fs";

import { expect, test, type CDPSession, type Page } from "@playwright/test";

import { storageStatePath } from "./global-setup";
import { createSeatSession, type SeatSessionFixture, seatsPath } from "./seat-session-fixture";

/**
 * M5.5 synthetic 3,000-seat performance probe (lab data, not field INP).
 *
 * A 4 × 25 × 30 = 3,000-seat session (the per-map maximum) is created in the
 * isolated test database. Interactions use trusted Playwright input; latency
 * comes from the browser's Event Timing API (entries ≥ 16 ms; shorter ones
 * are reported as "< 16"), plus long tasks and CDP layout/memory metrics.
 * Nothing is asserted against a product budget except gross regressions; the
 * numbers are written to M5_SCREENSHOT_DIR for the report.
 */

const OUTPUT = process.env.M5_SCREENSHOT_DIR;
let fixture: SeatSessionFixture;

function desktopProjectOnly() {
  return test.info().project.name === "desktop";
}

test.beforeAll(async () => {
  if (!desktopProjectOnly()) return;
  const sections = ["North", "East", "South", "West"].map((name, index) => ({
    name: `${name} Block`,
    code: name.slice(0, 2).toUpperCase(),
    rows: 25,
    seatsPerRow: 30,
    tier: { name: `${name} Tier`, code: `T${index}`, priceMinor: 2_000 + index * 1_000 },
  }));
  fixture = await createSeatSession("M55P", sections);
});

test.beforeEach(() => {
  test.skip(!desktopProjectOnly(), "Runs once; profiles are set explicitly.");
});

test.use({ storageState: storageStatePath("otherCustomer") });
test.setTimeout(240_000);

const OBSERVERS = () => {
  const state = { events: [] as { name: string; duration: number }[], longtasks: [] as { start: number; duration: number }[], lcp: 0, cls: 0 };
  (window as unknown as { __m5: typeof state }).__m5 = state;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) state.events.push({ name: entry.name, duration: entry.duration });
  }).observe({ type: "event", durationThreshold: 16, buffered: true } as PerformanceObserverInit);
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) state.longtasks.push({ start: entry.startTime, duration: entry.duration });
  }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) state.lcp = entry.startTime;
  }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) {
      if (!entry.hadRecentInput) state.cls += entry.value;
    }
  }).observe({ type: "layout-shift", buffered: true });
};

async function metrics(cdp: CDPSession) {
  const { metrics: list } = await cdp.send("Performance.getMetrics");
  const pick = Object.fromEntries(list.map((metric) => [metric.name, metric.value]));
  return {
    jsHeapUsedMB: Number((pick.JSHeapUsedSize! / 1_048_576).toFixed(1)),
    domNodes: pick.Nodes,
    layoutCount: pick.LayoutCount,
    recalcStyleCount: pick.RecalcStyleCount,
    layoutMs: Math.round(pick.LayoutDuration! * 1000),
    recalcStyleMs: Math.round(pick.RecalcStyleDuration! * 1000),
    scriptMs: Math.round(pick.ScriptDuration! * 1000),
    taskMs: Math.round(pick.TaskDuration! * 1000),
  };
}

async function nextFrames(page: Page) {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))),
  );
}

/** Run one trusted interaction; return its Event Timing duration (ms, or "< 16"). */
async function timed(page: Page, interact: () => Promise<void>): Promise<number | "< 16"> {
  await page.evaluate(() => {
    (window as unknown as { __m5: { events: unknown[] } }).__m5.events = [];
  });
  await interact();
  await nextFrames(page);
  await page.waitForTimeout(50);
  const durations = await page.evaluate(() =>
    (window as unknown as { __m5: { events: { duration: number }[] } }).__m5.events.map((event) => event.duration),
  );
  return durations.length === 0 ? "< 16" : Math.max(...durations);
}

function summarize(values: (number | "< 16")[]) {
  const numeric = values.map((value) => (value === "< 16" ? 0 : value)).sort((a, b) => a - b);
  const under16 = values.filter((value) => value === "< 16").length;
  const at = (q: number) => numeric[Math.min(numeric.length - 1, Math.floor(q * numeric.length))]!;
  return {
    samples: values.length,
    under16ms: under16,
    p50: at(0.5) || "< 16",
    p75: at(0.75) || "< 16",
    max: numeric[numeric.length - 1] || "< 16",
  };
}

async function visibleAvailableSeatCenters(page: Page, limit: number, unselectedOnly = false) {
  return page.evaluate(([max, unselected]) => {
    const surface = document.querySelector('[data-testid="seat-map-viewport"]')!.getBoundingClientRect();
    const toolbar = document.querySelector('[role="toolbar"][aria-label="Map zoom"]')!.getBoundingClientRect();
    const sheet = document.querySelector('[data-summary-variant="sheet"]')?.getBoundingClientRect();
    const result: { x: number; y: number }[] = [];
    const selector = unselected
      ? '[data-seat-id]:not([aria-disabled="true"]):not([aria-pressed="true"])'
      : '[data-seat-id]:not([aria-disabled="true"])';
    for (const seat of document.querySelectorAll<HTMLElement>(selector)) {
      const r = seat.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const inside = r.left >= surface.left && r.right <= surface.right && r.top >= surface.top && r.bottom <= surface.bottom;
      const underToolbar = x > toolbar.left && x < toolbar.right && y > toolbar.top && y < toolbar.bottom;
      const underSheet = sheet && sheet.height > 0 && y > sheet.top;
      if (inside && !underToolbar && !underSheet && y > 0 && y < window.innerHeight) result.push({ x, y });
      if (result.length >= max) break;
    }
    return result;
  }, [limit, unselectedOnly] as const);
}

const PROFILES = [
  { name: "desktop-1440", width: 1440, height: 900, cpuThrottle: 1 },
  { name: "mobile-390-cpu4x", width: 390, height: 844, cpuThrottle: 4 },
] as const;

for (const profile of PROFILES) {
  test(`3,000 seats: ${profile.name}`, async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    if (profile.cpuThrottle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpuThrottle });
    await page.addInitScript(OBSERVERS);
    await page.setViewportSize({ width: profile.width, height: profile.height });

    const started = Date.now();
    await page.goto(seatsPath(fixture), { waitUntil: "load" });
    // Seats render on the client after hydration; the map is interactive once
    // the viewport has measured itself (data-viewport-scale).
    await page.waitForFunction((count) => document.querySelectorAll("[data-seat-id]").length === count, fixture.seatCount);
    await page.waitForSelector('[data-testid="seat-map-viewport"][data-viewport-scale]');
    await nextFrames(page);
    const mapInteractiveWallMs = Date.now() - started;
    const load = await page.evaluate(() => {
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
      const state = (window as unknown as { __m5: { lcp: number; cls: number; longtasks: { duration: number }[] } }).__m5;
      return {
        domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd),
        loadEventMs: Math.round(navigation.loadEventEnd),
        htmlTransferKB: Math.round(navigation.transferSize / 1024),
        lcpMs: Math.round(state.lcp),
        cls: Number(state.cls.toFixed(4)),
        longTasks: state.longtasks.length,
        longTaskTotalMs: Math.round(state.longtasks.reduce((total, task) => total + task.duration, 0)),
        maxLongTaskMs: Math.round(Math.max(0, ...state.longtasks.map((task) => task.duration))),
      };
    });
    const afterLoad = await metrics(cdp);

    // Seat selection: trusted clicks on visible seats.
    await page.evaluate(() => {
      const map = document.querySelector('[data-testid="seat-map-viewport"]')!;
      window.scrollTo({ top: map.getBoundingClientRect().top + window.scrollY - 90, behavior: "instant" });
    });
    // Recompute the target before every click: the mobile sheet grows after
    // the first selection and may cover seats that were visible before.
    const selection: (number | "< 16")[] = [];
    for (let index = 0; index < 8; index += 1) {
      const [center] = await visibleAvailableSeatCenters(page, 1, true);
      expect(center).toBeDefined();
      selection.push(await timed(page, () => page.mouse.click(center!.x, center!.y)));
      await expect(page.locator('[data-seat-id][aria-pressed="true"]')).toHaveCount(index + 1);
    }

    // Keyboard map navigation from the roving seat.
    await page.locator('[data-seat-id][tabindex="0"]').focus();
    const navigation: (number | "< 16")[] = [];
    for (const key of [...Array(15).fill("ArrowRight"), ...Array(10).fill("ArrowDown"), "End", "Home"]) {
      navigation.push(await timed(page, () => page.keyboard.press(key)));
    }

    // Section jumps.
    const jump = page.getByLabel("Jump to section");
    const jumps: (number | "< 16")[] = [];
    for (const label of ["West Block (WE)", "South Block (SO)", "East Block (EA)", "North Block (NO)"]) {
      jumps.push(await timed(page, async () => void (await jump.selectOption({ label }))));
    }

    // Authoritative snapshot refresh (focus refresh path), timed in-page.
    await page.evaluate(() => {
      (window as unknown as { __m5: { longtasks: unknown[] } }).__m5.longtasks = [];
    });
    const refresh = await page.evaluate(async () => {
      const start = performance.now();
      const resource = new Promise<PerformanceResourceTiming>((resolve) => {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
            if (entry.name.includes("/api/inventory/sessions/")) {
              observer.disconnect();
              resolve(entry);
            }
          }
        });
        observer.observe({ type: "resource" });
      });
      window.dispatchEvent(new Event("focus"));
      const entry = await resource;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))));
      const end = performance.now();
      const tasks = (window as unknown as { __m5: { longtasks: { start: number; duration: number }[] } }).__m5.longtasks;
      return {
        totalMs: Math.round(end - start),
        networkMs: Math.round(entry.responseEnd - entry.startTime),
        afterResponseToPaintMs: Math.round(end - entry.responseEnd),
        payloadKB: Math.round(entry.decodedBodySize / 1024),
        transferKB: Math.round(entry.transferSize / 1024),
        longTaskMs: Math.round(tasks.filter((task) => task.start >= start).reduce((total, task) => total + task.duration, 0)),
      };
    });
    // Selection survives the refresh (seats are still available).
    await expect(page.locator('[data-seat-id][aria-pressed="true"]')).toHaveCount(8);
    const afterInteractions = await metrics(cdp);

    const result = {
      profile,
      seats: fixture.seatCount,
      mapInteractiveWallMs,
      load,
      afterLoad,
      selectionClick: summarize(selection),
      keyboardNavigation: summarize(navigation),
      sectionJump: summarize(jumps),
      snapshotRefresh: refresh,
      afterInteractions,
    };
    if (OUTPUT) {
      writeFileSync(`${OUTPUT}/perf-${profile.name}.json`, JSON.stringify(result, null, 2));
      await page.screenshot({ path: `${OUTPUT}/perf-${profile.name}.png` });
    }
    // Gross-regression guard only (the per-map maximum must stay usable).
    expect(afterInteractions.domNodes).toBeGreaterThan(fixture.seatCount);
    if (profile.cpuThrottle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  });
}
