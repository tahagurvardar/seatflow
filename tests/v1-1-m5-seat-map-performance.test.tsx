import { act, fireEvent, render } from "@testing-library/react";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VenueSeatMap } from "../src/components/seat-selection/venue-seat-map";
import type { SelectionSectionView } from "../src/features/holds/inventory";
import { stubViewportSize, syntheticMap } from "./v1-1-m5-seat-map-fixtures";

// These numbers come from React's Profiler inside jsdom. They show relative
// cost (mount vs. memoised updates) and catch regressions; they are NOT browser
// rendering, layout, paint or INP measurements.

afterEach(() => {
  vi.restoreAllMocks();
});

function seat(seatId: string) {
  return document.querySelector<HTMLElement>(`[data-seat-id="${seatId}"]`)!;
}

// jsdom is slow to build 3,000 DOM buttons, especially while the full suite runs
// in parallel; the timeout covers the harness, not a product budget.
describe("M5.2 3,000-seat render behaviour (jsdom)", { timeout: 30_000 }, () => {
  it("mounts once and keeps selection, refresh, zoom and focus updates cheaper than mount", () => {
    stubViewportSize(1_120, 640);
    const commits: Array<{ phase: string; duration: number }> = [];
    const onRender: ProfilerOnRenderCallback = (_id, phase, actualDuration) => {
      commits.push({ phase, duration: actualDuration });
    };
    const take = () => {
      const total = commits.reduce((sum, commit) => sum + commit.duration, 0);
      commits.length = 0;
      return total;
    };
    const onToggle = vi.fn();
    const view = (sections: SelectionSectionView[], selected: string[]) => (
      <Profiler id="map" onRender={onRender}>
        <VenueSeatMap sections={sections} selectedSeatIds={selected} maxSeats={8} onToggleSeat={onToggle} />
      </Profiler>
    );

    const initial = syntheticMap();
    let wall = performance.now();
    const { rerender } = render(view(initial, []));
    const mountWall = performance.now() - wall;
    const mount = take();

    // Selection change: same snapshot, one more selected seat.
    wall = performance.now();
    rerender(view(initial, ["s0-r3-n1"]));
    const toggleWall = performance.now() - wall;
    const toggle = take();
    expect(seat("s0-r3-n1")).toHaveAttribute("aria-pressed", "true");

    // Inventory refresh: brand-new objects, same geometry, one seat changed.
    const refreshed = syntheticMap((s, r, n) =>
      s === 0 && r === 3 && n === 2 ? "UNAVAILABLE" : n % 7 === 0 ? "UNAVAILABLE" : "AVAILABLE",
    );
    const layoutNodeBefore = seat("s5-r19-n24");
    wall = performance.now();
    rerender(view(refreshed, ["s0-r3-n1"]));
    const refreshWall = performance.now() - wall;
    const refresh = take();
    expect(seat("s0-r3-n2")).toHaveAttribute("aria-disabled", "true");
    expect(seat("s5-r19-n24")).toBe(layoutNodeBefore);

    // Zoom: viewport-only state; the seat layer element tree is reused.
    wall = performance.now();
    fireEvent.click(document.querySelector('[role="toolbar"] [aria-label="Zoom in"]')!);
    const zoomWall = performance.now() - wall;
    const zoom = take();

    // Keyboard: 50 roving-focus moves along a row and down rows.
    act(() => seat("s0-r0-n0").focus());
    take();
    wall = performance.now();
    for (let step = 0; step < 50; step += 1) {
      const active = document.activeElement as HTMLElement;
      fireEvent.keyDown(active, { key: step % 2 === 0 ? "ArrowRight" : "ArrowDown" });
    }
    const keysWall = performance.now() - wall;
    const keys = take();
    // 25 rights stop at the row end (n24); 25 downs cross from section 1's
    // last row into section 2 and land on its sixth row.
    expect(document.activeElement).toBe(seat("s1-r5-n24"));

    console.info(
      `[M5.2 jsdom perf] 3000 seats — mount ${mount.toFixed(1)} ms (wall ${mountWall.toFixed(1)}); ` +
        `toggle ${toggle.toFixed(1)} ms (wall ${toggleWall.toFixed(1)}); ` +
        `refresh ${refresh.toFixed(1)} ms (wall ${refreshWall.toFixed(1)}); ` +
        `zoom ${zoom.toFixed(1)} ms (wall ${zoomWall.toFixed(1)}); ` +
        `50 arrow moves ${keys.toFixed(1)} ms profiled (wall ${keysWall.toFixed(1)}, ${(keysWall / 50).toFixed(1)} ms/move)`,
    );

    // Memoised seats make every update cheaper than the initial mount.
    expect(toggle).toBeLessThan(mount);
    expect(refresh).toBeLessThan(mount);
    expect(zoom).toBeLessThan(toggle);
  });
});
