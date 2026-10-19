"use client";

import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import {
  canZoomIn,
  canZoomOut,
  clampViewport,
  DEFAULT_FIT_PADDING,
  ensureRectVisible,
  fitViewport,
  panBy,
  pinchViewport,
  type Point,
  type Rect,
  resolveZoomLimits,
  wheelZoomFactor,
  zoomAt,
  zoomIn,
  zoomOut,
  type ViewportSize,
  type ViewportState,
  type ZoomLimits,
} from "@/features/seat-maps/viewport";
import { cn } from "@/lib/utils";

/** Smallest on-screen seat edge (px) the default view and focus-follow allow. */
export const READABLE_SEAT_PX = 20;
const DRAG_THRESHOLD_PX = 5;

function clampScale(scale: number, limits: ZoomLimits) {
  return Math.min(limits.maxScale, Math.max(limits.minScale, scale));
}

/** Scale at which seats render at least READABLE_SEAT_PX (within limits). */
export function readableScale(seatSize: number, limits: ZoomLimits) {
  return clampScale(seatSize > 0 ? READABLE_SEAT_PX / seatSize : 1, limits);
}

/**
 * Default view. When fitting the whole map keeps seats readable, fit-all is
 * used. Otherwise the view opens at a readable scale with `focus` (stage and
 * first section) aligned to the top and centred horizontally.
 */
export function readableViewport(
  size: ViewportSize,
  limits: ZoomLimits,
  focus: Rect,
  seatSize: number,
): ViewportState {
  const fitted = fitViewport(size, limits);
  const scale = readableScale(seatSize, limits);
  if (fitted.scale >= scale) return fitted;
  return clampViewport(
    {
      scale,
      x: size.viewportWidth / 2 - (focus.x + focus.width / 2) * scale,
      y: DEFAULT_FIT_PADDING - focus.y * scale,
    },
    size,
    limits,
  );
}

/**
 * Bring a content rectangle into view. If seats are currently too small to read
 * (for example in the overview), zoom to the readable scale centred on it;
 * otherwise pan minimally.
 */
export function revealViewport(
  state: ViewportState,
  size: ViewportSize,
  limits: ZoomLimits,
  rect: Rect,
  seatSize: number,
): ViewportState {
  const scale = readableScale(seatSize, limits);
  if (state.scale * seatSize < READABLE_SEAT_PX - 1e-9 && state.scale < scale) {
    return clampViewport(
      {
        scale,
        x: size.viewportWidth / 2 - (rect.x + rect.width / 2) * scale,
        y: size.viewportHeight / 2 - (rect.y + rect.height / 2) * scale,
      },
      size,
      limits,
    );
  }
  return ensureRectVisible(state, rect, size, limits);
}

/** Jump target: readable (or current, if larger) scale, rect at the top. */
export function showRectViewport(
  state: ViewportState,
  size: ViewportSize,
  limits: ZoomLimits,
  rect: Rect,
  seatSize: number,
): ViewportState {
  const scale = Math.max(state.scale, readableScale(seatSize, limits));
  return clampViewport(
    {
      scale,
      x: size.viewportWidth / 2 - (rect.x + rect.width / 2) * scale,
      y: DEFAULT_FIT_PADDING - rect.y * scale,
    },
    size,
    limits,
  );
}

export interface SeatMapViewportHandle {
  /** Keep a content rect (e.g. the focused seat) visible. */
  reveal(rect: Rect): void;
  /** Jump to a content rect (e.g. a section) at a readable scale. */
  showRect(rect: Rect): void;
  zoomIn(): void;
  zoomOut(): void;
  /** Back to the readable default view. */
  reset(): void;
  /** Optional whole-map overview (fit-all). */
  overview(): void;
}

interface SeatMapViewportProps {
  contentWidth: number;
  contentHeight: number;
  seatSize: number;
  /** Content rect the default view is anchored on. */
  initialFocus: Rect;
  label: string;
  children: ReactNode;
  className?: string;
  ref?: Ref<SeatMapViewportHandle>;
}

interface ActivePointer {
  id: number;
  type: string;
  point: Point;
}

const controlClass =
  "flex size-11 items-center justify-center rounded-[var(--sf-radius-input)] border border-[var(--sf-border)] bg-[var(--sf-surface-raised)] text-lg font-black text-[var(--sf-text)] hover:bg-[var(--sf-surface-hover)] disabled:cursor-not-allowed disabled:opacity-40 outline-none focus-visible:ring-4 focus-visible:ring-[var(--sf-focus)]";

/**
 * Pan/zoom surface for the seat map. Seats keep their own pointer and keyboard
 * behaviour; this component only transforms the content.
 *
 * Page scrolling is preserved on purpose: a plain mouse wheel and one-finger
 * touch scroll the page. Zooming uses the buttons, Ctrl/⌘ + wheel (also trackpad
 * pinch), +/−/0 keys, or a two-finger pinch; a mouse drag pans the map.
 */
export function SeatMapViewport({
  contentWidth,
  contentHeight,
  seatSize,
  initialFocus,
  label,
  children,
  className,
  ref,
}: SeatMapViewportProps) {
  const hintId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number } | null>(null);
  const [view, setView] = useState<ViewportState | null>(null);
  const [animate, setAnimate] = useState(false);

  const pointersRef = useRef(new Map<number, ActivePointer>());
  const dragRef = useRef<{ start: Point; last: Point; dragging: boolean } | null>(null);
  const suppressClickRef = useRef(false);

  const size: ViewportSize | null = viewportSize
    ? {
        contentWidth,
        contentHeight,
        viewportWidth: viewportSize.width,
        viewportHeight: viewportSize.height,
      }
    : null;
  const limits = size ? resolveZoomLimits(size) : null;

  // Refs give stable callbacks (imperative handle, native listeners) the latest
  // geometry without re-subscribing on every render.
  const latest = useRef({ size, limits, initialFocus, seatSize });
  useEffect(() => {
    latest.current = { size, limits, initialFocus, seatSize };
  });

  const update = useCallback(
    (
      compute: (state: ViewportState, size: ViewportSize, limits: ZoomLimits) => ViewportState,
      animated: boolean,
    ) => {
      const { size: currentSize, limits: currentLimits } = latest.current;
      if (!currentSize || !currentLimits) return;
      setAnimate(animated);
      setView((current) =>
        current ? compute(current, currentSize, currentLimits) : current,
      );
    },
    [],
  );

  // Measure the viewport and keep the view valid when it resizes.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      if (width > 0 && height > 0) {
        setViewportSize((current) =>
          current && current.width === width && current.height === height
            ? current
            : { width, height },
        );
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // First measurement opens the readable default view; later size or content
  // changes only re-clamp the current view so the customer keeps their place.
  useEffect(() => {
    if (!size || !limits) return;
    setView((current) =>
      current
        ? clampViewport(current, size, limits)
        : readableViewport(size, limits, latest.current.initialFocus, latest.current.seatSize),
    );
    // Primitive dependencies only; `size`/`limits` are rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewportSize?.width, viewportSize?.height, contentWidth, contentHeight]);

  useImperativeHandle(
    ref,
    () => ({
      reveal: (rect) =>
        update((state, s, l) => revealViewport(state, s, l, rect, latest.current.seatSize), true),
      showRect: (rect) =>
        update((state, s, l) => showRectViewport(state, s, l, rect, latest.current.seatSize), true),
      zoomIn: () => update(zoomIn, true),
      zoomOut: () => update(zoomOut, true),
      reset: () =>
        update(
          (_state, s, l) =>
            readableViewport(s, l, latest.current.initialFocus, latest.current.seatSize),
          true,
        ),
      overview: () => update((_state, s, l) => fitViewport(s, l), true),
    }),
    [update],
  );

  // Ctrl/⌘ + wheel zooms; a plain wheel is left to the page. React's onWheel is
  // passive, so a native non-passive listener is needed to preventDefault.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      const anchor = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      const factor = wheelZoomFactor(event.deltaY, event.deltaMode);
      update((state, s, l) => zoomAt(state, factor, anchor, s, l), false);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [update]);

  function localPoint(event: PointerEvent<HTMLDivElement>): Point {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("[data-viewport-control]")) return;
    const point = localPoint(event);
    pointersRef.current.set(event.pointerId, { id: event.pointerId, type: event.pointerType, point });
    if (event.pointerType === "mouse" && event.button === 0) {
      dragRef.current = { start: point, last: point, dragging: false };
    }
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const tracked = pointersRef.current.get(event.pointerId);
    if (!tracked) return;
    const point = localPoint(event);

    const touches = [...pointersRef.current.values()].filter((pointer) => pointer.type === "touch");
    if (tracked.type === "touch" && touches.length === 2) {
      const previous = [touches[0]!.point, touches[1]!.point] as const;
      tracked.point = point;
      const next = [touches[0]!.point, touches[1]!.point] as const;
      suppressClickRef.current = true;
      update((state, s, l) => pinchViewport(state, previous, next, s, l), false);
      return;
    }
    tracked.point = point;

    const drag = dragRef.current;
    if (!drag || tracked.type !== "mouse") return;
    if (!drag.dragging) {
      const moved = Math.hypot(point.x - drag.start.x, point.y - drag.start.y);
      if (moved < DRAG_THRESHOLD_PX) return;
      // Capture only once a real drag starts, so ordinary seat clicks still
      // land on the seat button.
      drag.dragging = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    const delta = { x: point.x - drag.last.x, y: point.y - drag.last.y };
    drag.last = point;
    update((state, s, l) => panBy(state, delta, s, l), false);
  }

  function onPointerEnd(event: PointerEvent<HTMLDivElement>) {
    pointersRef.current.delete(event.pointerId);
    if (dragRef.current?.dragging) suppressClickRef.current = true;
    if (event.pointerType === "mouse") dragRef.current = null;
  }

  function onClickCapture(event: MouseEvent<HTMLDivElement>) {
    // A click that ends a drag or pinch must not toggle the seat under it.
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      event.stopPropagation();
      event.preventDefault();
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "+" || event.key === "=") update(zoomIn, true);
    else if (event.key === "-" || event.key === "_") update(zoomOut, true);
    else if (event.key === "0") {
      update(
        (_state, s, l) => readableViewport(s, l, latest.current.initialFocus, latest.current.seatSize),
        true,
      );
    } else return;
    event.preventDefault();
  }

  const zoomInEnabled = view && limits ? canZoomIn(view, limits) : false;
  const zoomOutEnabled = view && limits ? canZoomOut(view, limits) : false;
  const transform = view
    ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})`
    : undefined;

  // Below `sm` the zoom controls sit in a row above the map: overlaid on a
  // narrow map they would always cover the first seats. From `sm` they float
  // over the top-left corner as in SF-04.
  return (
    <div className={cn("relative flex flex-col", className)}>
      <div
        className="mb-2 flex shrink-0 gap-2 sm:absolute sm:left-3 sm:top-3 sm:z-10 sm:mb-0 sm:flex-col"
        role="toolbar"
        aria-label="Map zoom"
        data-viewport-control=""
      >
        <button type="button" className={controlClass} aria-label="Zoom in" disabled={!zoomInEnabled} onClick={() => update(zoomIn, true)}>
          <span aria-hidden="true">+</span>
        </button>
        <button type="button" className={controlClass} aria-label="Zoom out" disabled={!zoomOutEnabled} onClick={() => update(zoomOut, true)}>
          <span aria-hidden="true">−</span>
        </button>
        <button
          type="button"
          className={controlClass}
          aria-label="Reset view"
          disabled={!view}
          onClick={() =>
            update(
              (_state, s, l) => readableViewport(s, l, latest.current.initialFocus, latest.current.seatSize),
              true,
            )
          }
        >
          <span aria-hidden="true">⌖</span>
        </button>
        <button
          type="button"
          className={controlClass}
          aria-label="Show whole map"
          disabled={!view}
          onClick={() => update((_state, s, l) => fitViewport(s, l), true)}
        >
          <span aria-hidden="true">⤢</span>
        </button>
      </div>
      <div
        ref={containerRef}
        role="region"
        aria-label={label}
        aria-describedby={hintId}
        data-testid="seat-map-viewport"
        data-viewport-scale={view ? view.scale.toFixed(4) : undefined}
        className="relative min-h-0 w-full flex-1 overflow-hidden rounded-[var(--sf-radius-card)] border border-[var(--sf-border)] bg-[var(--sf-canvas-deep)] [touch-action:pan-x_pan-y]"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClickCapture={onClickCapture}
        onKeyDown={onKeyDown}
      >
        <div
          data-testid="seat-map-content"
          className={cn(
            "absolute left-0 top-0 origin-top-left",
            animate && "motion-safe:transition-transform motion-safe:duration-[var(--sf-motion-panel)] motion-safe:ease-out",
            !view && "invisible",
          )}
          style={{ width: contentWidth, height: contentHeight, transform }}
        >
          {children}
        </div>

      </div>
      <p id={hintId} className="mt-2 shrink-0 text-xs text-[var(--sf-text-muted)]">
        Zoom with the buttons, + and − keys, Ctrl + scroll, or a two-finger pinch. Drag with a mouse to move the map.
      </p>
    </div>
  );
}
