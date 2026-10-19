import { describe, expect, it } from "vitest";

import { numberToRowLabel } from "../src/features/seat-maps/row-labels";
import { buildVenueLayout } from "../src/features/seat-maps/venue-layout";
import {
  canZoomIn,
  canZoomOut,
  clampViewport,
  contentToScreen,
  ensureRectVisible,
  fitScale,
  fitViewport,
  panBy,
  pinchViewport,
  renderedSeatSize,
  resetViewport,
  resolveZoomLimits,
  scaleForTargetSize,
  screenToContent,
  wheelZoomFactor,
  zoomAt,
  zoomIn,
  zoomOut,
  type ViewportSize,
} from "../src/features/seat-maps/viewport";

const size: ViewportSize = {
  contentWidth: 2_000,
  contentHeight: 1_000,
  viewportWidth: 1_000,
  viewportHeight: 600,
};
const limits = resolveZoomLimits(size, { padding: 0 });

describe("M5.1 viewport fit and limits", () => {
  it("fits the whole content and never zooms out past fit", () => {
    expect(fitScale(size, 0)).toBe(0.5);
    expect(limits).toEqual({ minScale: 0.5, maxScale: 4 });
  });

  it("does not upscale small content beyond 1:1 when fitting", () => {
    const small = { ...size, contentWidth: 200, contentHeight: 100 };
    expect(resolveZoomLimits(small).minScale).toBe(1);
  });

  it("centres the fitted content; reset equals fit", () => {
    const fitted = fitViewport(size, limits);
    expect(fitted).toEqual({ scale: 0.5, x: 0, y: 50 });
    expect(resetViewport(size, limits)).toEqual(fitted);
  });

  it("returns a safe identity scale for zero-sized inputs", () => {
    expect(fitScale({ ...size, viewportWidth: 0 })).toBe(1);
  });
});

describe("M5.1 zoom", () => {
  it("keeps the content point under the anchor fixed", () => {
    const start = { scale: 1, x: -200, y: -100 };
    const anchor = { x: 300, y: 200 };
    const before = screenToContent(start, anchor);
    const zoomed = zoomAt(start, 2, anchor, size, limits);
    expect(zoomed.scale).toBe(2);
    const after = contentToScreen(zoomed, before);
    expect(after.x).toBeCloseTo(anchor.x);
    expect(after.y).toBeCloseTo(anchor.y);
  });

  it("clamps zoom to the limits and reports button availability", () => {
    let state = fitViewport(size, limits);
    expect(canZoomOut(state, limits)).toBe(false);
    expect(zoomOut(state, size, limits).scale).toBe(limits.minScale);
    for (let step = 0; step < 20; step += 1) state = zoomIn(state, size, limits);
    expect(state.scale).toBe(limits.maxScale);
    expect(canZoomIn(state, limits)).toBe(false);
    expect(canZoomOut(state, limits)).toBe(true);
  });

  it("ignores invalid zoom factors", () => {
    const state = { scale: 1, x: -100, y: -100 };
    expect(zoomAt(state, Number.NaN, { x: 0, y: 0 }, size, limits)).toEqual(state);
    expect(zoomAt(state, -2, { x: 0, y: 0 }, size, limits)).toEqual(state);
  });

  it("maps wheel deltas to bounded factors (scroll up zooms in)", () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBe(1);
    expect(wheelZoomFactor(-1_000_000)).toBe(2);
    expect(wheelZoomFactor(1_000_000)).toBe(0.5);
    expect(wheelZoomFactor(-3, 1)).toBeCloseTo(wheelZoomFactor(-48, 0));
  });
});

describe("M5.1 pan, pinch and focus follow", () => {
  it("clamps panning so no gap opens at the content edges", () => {
    const state = { scale: 1, x: 0, y: 0 };
    expect(panBy(state, { x: 500, y: 500 }, size, limits)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(panBy(state, { x: -5_000, y: -5_000 }, size, limits)).toEqual({ scale: 1, x: -1_000, y: -400 });
  });

  it("centres an axis whose content is narrower than the viewport", () => {
    const clamped = clampViewport({ scale: 0.5, x: -300, y: -300 }, size, limits);
    expect(clamped.x).toBe(0);
    expect(clamped.y).toBe(50);
  });

  it("pinches by finger distance and follows the midpoint", () => {
    const state = { scale: 1, x: -500, y: -200 };
    const pinched = pinchViewport(
      state,
      [{ x: 400, y: 300 }, { x: 600, y: 300 }],
      [{ x: 350, y: 300 }, { x: 650, y: 300 }],
      size,
      limits,
    );
    expect(pinched.scale).toBeCloseTo(1.5);
    // The content point under the original midpoint stays under the fingers.
    const anchor = screenToContent(state, { x: 500, y: 300 });
    const after = contentToScreen(pinched, anchor);
    expect(after.x).toBeCloseTo(500);
    expect(after.y).toBeCloseTo(300);
  });

  it("pans minimally to reveal a focused seat and is a no-op when visible", () => {
    const state = { scale: 1, x: 0, y: 0 };
    const visible = { x: 100, y: 100, width: 36, height: 36 };
    expect(ensureRectVisible(state, visible, size, limits)).toBe(state);
    const offscreen = { x: 1_500, y: 900, width: 36, height: 36 };
    const moved = ensureRectVisible(state, offscreen, size, limits, 16);
    const topLeft = contentToScreen(moved, offscreen);
    expect(topLeft.x + 36).toBeLessThanOrEqual(size.viewportWidth - 16 + 1e-9);
    expect(topLeft.y + 36).toBeLessThanOrEqual(size.viewportHeight - 16 + 1e-9);
    expect(moved.scale).toBe(1);
  });

  it("computes the scale for a 44px touch target within limits", () => {
    expect(scaleForTargetSize(36, limits)).toBeCloseTo(44 / 36);
    expect(scaleForTargetSize(4, limits)).toBe(limits.maxScale);
    expect(renderedSeatSize({ scale: 2, x: 0, y: 0 }, 36)).toBe(72);
  });
});

describe("M5.1 viewport with a 3,000-seat schematic layout", () => {
  it("reports fitted seat sizes at the approved desktop and mobile widths", () => {
    const layout = buildVenueLayout(
      Array.from({ length: 6 }, (_, s) => ({
        id: `s${s}`,
        name: `Section ${s + 1}`,
        code: `S${s + 1}`,
        rows: Array.from({ length: 20 }, (_, r) => ({
          id: `s${s}-r${r}`,
          label: numberToRowLabel(r + 1),
          seats: Array.from({ length: 25 }, (_, n) => ({
            seatId: `s${s}-r${r}-n${n}`,
            label: String(n + 1),
            x: n * 40,
            y: r * 40,
          })),
        })),
      })),
    );
    const content = { contentWidth: layout.width, contentHeight: layout.height };
    const desktop = { ...content, viewportWidth: 1_120, viewportHeight: 640 };
    const mobile = { ...content, viewportWidth: 358, viewportHeight: 420 };

    const desktopFit = fitViewport(desktop);
    const mobileFit = fitViewport(mobile);
    const desktopSeat = renderedSeatSize(desktopFit, layout.seatSize);
    const mobileSeat = renderedSeatSize(mobileFit, layout.seatSize);
    const mobileLimits = resolveZoomLimits(mobile);
    const tapScale = scaleForTargetSize(layout.seatSize, mobileLimits);

    console.info(
      `[M5.1 perf] 3000-seat schematic ${layout.width}x${layout.height}: ` +
        `fit seat ${desktopSeat.toFixed(2)}px @1120x640, ${mobileSeat.toFixed(2)}px @358x420; ` +
        `44px target needs scale ${tapScale.toFixed(3)} (max ${mobileLimits.maxScale})`,
    );

    // A whole 3,000-seat map cannot offer 44px targets at fit; zoom or the list
    // alternative (M5.3) must provide them. Fit still keeps everything visible.
    expect(mobileSeat).toBeLessThan(44);
    expect(renderedSeatSize({ ...mobileFit, scale: tapScale }, layout.seatSize)).toBeCloseTo(44);
    expect(desktopFit.scale).toBeLessThanOrEqual(1);
  });
});
