// ---------------------------------------------------------------------------
// Seat-map viewport math (pure, framework-free)
// ---------------------------------------------------------------------------
//
// The rendered map is transformed as `translate(x, y) scale(scale)`: a content
// point (cx, cy) appears on screen at (x + cx * scale, y + cy * scale). These
// helpers compute fit, reset, zoom, pan, pinch and focus-follow transforms for
// pointer, touch and keyboard input. They never touch inventory or selection.

export interface ViewportState {
  scale: number;
  x: number;
  y: number;
}

export interface ViewportSize {
  contentWidth: number;
  contentHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface ZoomLimits {
  minScale: number;
  maxScale: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEFAULT_MAX_SCALE = 4;
export const DEFAULT_FIT_PADDING = 16;
export const ZOOM_STEP_FACTOR = 1.25;
/** Recommended touch target (design tokens: touchMinimumRecommendedPx). */
export const RECOMMENDED_TARGET_PX = 44;

const WHEEL_SENSITIVITY = 0.0015;
const WHEEL_LINE_PX = 16;
const MAX_WHEEL_FACTOR = 2;

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function hasArea(size: ViewportSize) {
  return (
    size.contentWidth > 0 &&
    size.contentHeight > 0 &&
    size.viewportWidth > 0 &&
    size.viewportHeight > 0
  );
}

/** Scale that fits the whole content inside the viewport with padding. */
export function fitScale(size: ViewportSize, padding = DEFAULT_FIT_PADDING): number {
  if (!hasArea(size)) return 1;
  const availableWidth = Math.max(1, size.viewportWidth - padding * 2);
  const availableHeight = Math.max(1, size.viewportHeight - padding * 2);
  return Math.min(
    availableWidth / size.contentWidth,
    availableHeight / size.contentHeight,
  );
}

/**
 * Zoom limits: never zoom out further than "whole map visible" (or 1:1 when the
 * map is already smaller than the viewport) and never beyond `maxScale`.
 */
export function resolveZoomLimits(
  size: ViewportSize,
  options: { maxScale?: number; padding?: number } = {},
): ZoomLimits {
  const maxScale = Math.max(finiteOr(options.maxScale ?? DEFAULT_MAX_SCALE, DEFAULT_MAX_SCALE), 0.01);
  const minScale = Math.min(fitScale(size, options.padding), 1, maxScale);
  return { minScale, maxScale };
}

/**
 * Clamp a transform: scale stays within limits; on each axis, content smaller
 * than the viewport is centred, and larger content cannot be dragged so far
 * that an edge leaves a gap inside the viewport.
 */
export function clampViewport(
  state: ViewportState,
  size: ViewportSize,
  limits: ZoomLimits,
): ViewportState {
  const scale = clamp(finiteOr(state.scale, limits.minScale), limits.minScale, limits.maxScale);
  const scaledWidth = size.contentWidth * scale;
  const scaledHeight = size.contentHeight * scale;

  const x =
    scaledWidth <= size.viewportWidth
      ? (size.viewportWidth - scaledWidth) / 2
      : clamp(finiteOr(state.x, 0), size.viewportWidth - scaledWidth, 0);
  const y =
    scaledHeight <= size.viewportHeight
      ? (size.viewportHeight - scaledHeight) / 2
      : clamp(finiteOr(state.y, 0), size.viewportHeight - scaledHeight, 0);

  return { scale, x, y };
}

/** Whole map visible and centred. Also the "reset" transform. */
export function fitViewport(
  size: ViewportSize,
  limits: ZoomLimits = resolveZoomLimits(size),
): ViewportState {
  return clampViewport({ scale: limits.minScale, x: 0, y: 0 }, size, limits);
}

export const resetViewport = fitViewport;

/** Convert a screen point (relative to the viewport) into content units. */
export function screenToContent(state: ViewportState, point: Point): Point {
  return {
    x: (point.x - state.x) / state.scale,
    y: (point.y - state.y) / state.scale,
  };
}

/** Convert a content point into screen units relative to the viewport. */
export function contentToScreen(state: ViewportState, point: Point): Point {
  return { x: state.x + point.x * state.scale, y: state.y + point.y * state.scale };
}

/**
 * Multiply the scale by `factor` while keeping the content point under
 * `anchor` (screen coordinates) fixed, then clamp.
 */
export function zoomAt(
  state: ViewportState,
  factor: number,
  anchor: Point,
  size: ViewportSize,
  limits: ZoomLimits,
): ViewportState {
  if (!Number.isFinite(factor) || factor <= 0) return clampViewport(state, size, limits);
  const scale = clamp(state.scale * factor, limits.minScale, limits.maxScale);
  const focus = screenToContent(state, anchor);
  return clampViewport(
    { scale, x: anchor.x - focus.x * scale, y: anchor.y - focus.y * scale },
    size,
    limits,
  );
}

function viewportCentre(size: ViewportSize): Point {
  return { x: size.viewportWidth / 2, y: size.viewportHeight / 2 };
}

/** Zoom-in button / "+" key: one step around the viewport centre. */
export function zoomIn(state: ViewportState, size: ViewportSize, limits: ZoomLimits) {
  return zoomAt(state, ZOOM_STEP_FACTOR, viewportCentre(size), size, limits);
}

/** Zoom-out button / "-" key: one step around the viewport centre. */
export function zoomOut(state: ViewportState, size: ViewportSize, limits: ZoomLimits) {
  return zoomAt(state, 1 / ZOOM_STEP_FACTOR, viewportCentre(size), size, limits);
}

export function canZoomIn(state: ViewportState, limits: ZoomLimits) {
  return state.scale < limits.maxScale - 1e-9;
}

export function canZoomOut(state: ViewportState, limits: ZoomLimits) {
  return state.scale > limits.minScale + 1e-9;
}

/** Drag or arrow-key pan by a screen-space delta, then clamp. */
export function panBy(
  state: ViewportState,
  delta: Point,
  size: ViewportSize,
  limits: ZoomLimits,
): ViewportState {
  return clampViewport(
    { scale: state.scale, x: state.x + finiteOr(delta.x, 0), y: state.y + finiteOr(delta.y, 0) },
    size,
    limits,
  );
}

/**
 * Translate a wheel delta into a bounded zoom factor. `deltaMode` follows
 * WheelEvent: 0 = pixels, 1 = lines, 2 = pages. Scrolling up zooms in.
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  const pixels =
    deltaMode === 1 ? deltaY * WHEEL_LINE_PX : deltaMode === 2 ? deltaY * 400 : deltaY;
  return clamp(Math.exp(-pixels * WHEEL_SENSITIVITY), 1 / MAX_WHEEL_FACTOR, MAX_WHEEL_FACTOR);
}

function distance(first: Point, second: Point) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function midpoint(first: Point, second: Point): Point {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

/**
 * Two-finger pinch: scale by the change in finger distance around the previous
 * midpoint, and follow the midpoint's movement as a pan.
 */
export function pinchViewport(
  state: ViewportState,
  previous: readonly [Point, Point],
  next: readonly [Point, Point],
  size: ViewportSize,
  limits: ZoomLimits,
): ViewportState {
  const previousDistance = distance(previous[0], previous[1]);
  const nextDistance = distance(next[0], next[1]);
  const factor = previousDistance > 0 ? nextDistance / previousDistance : 1;
  const previousMid = midpoint(previous[0], previous[1]);
  const nextMid = midpoint(next[0], next[1]);
  const zoomed = zoomAt(state, factor, previousMid, size, limits);
  return panBy(
    zoomed,
    { x: nextMid.x - previousMid.x, y: nextMid.y - previousMid.y },
    size,
    limits,
  );
}

/**
 * Minimal pan that brings a content rectangle (e.g. the keyboard-focused seat)
 * fully into view with a margin. Scale is unchanged; returns the same object
 * when no movement is needed, so callers can skip a re-render.
 */
export function ensureRectVisible(
  state: ViewportState,
  rect: Rect,
  size: ViewportSize,
  limits: ZoomLimits,
  margin = DEFAULT_FIT_PADDING,
): ViewportState {
  const left = state.x + rect.x * state.scale;
  const top = state.y + rect.y * state.scale;
  const right = left + rect.width * state.scale;
  const bottom = top + rect.height * state.scale;

  let dx = 0;
  if (left < margin) dx = margin - left;
  else if (right > size.viewportWidth - margin) dx = size.viewportWidth - margin - right;
  let dy = 0;
  if (top < margin) dy = margin - top;
  else if (bottom > size.viewportHeight - margin) dy = size.viewportHeight - margin - bottom;

  if (dx === 0 && dy === 0) return state;
  return panBy(state, { x: dx, y: dy }, size, limits);
}

/**
 * Scale at which a seat of `seatSize` content units renders at least
 * `targetPx` screen pixels (capped by the zoom limits). Useful to decide when
 * direct tapping is comfortable and when the list alternative should lead.
 */
export function scaleForTargetSize(
  seatSize: number,
  limits: ZoomLimits,
  targetPx = RECOMMENDED_TARGET_PX,
): number {
  if (!(seatSize > 0)) return limits.maxScale;
  return clamp(targetPx / seatSize, limits.minScale, limits.maxScale);
}

/** Rendered seat edge length in screen pixels at the current scale. */
export function renderedSeatSize(state: ViewportState, seatSize: number): number {
  return seatSize * state.scale;
}
