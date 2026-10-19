import { memo } from "react";

import type { SeatVisualState } from "@/features/holds/selection";

/**
 * Non-colour glyph per visual state, so state never depends on colour alone.
 * Shared with the legend so the two always match.
 */
export const SEAT_STATE_GLYPHS: Readonly<Record<SeatVisualState, string>> = {
  available: "",
  premium: "★",
  selected: "✓",
  "held-by-you": "●",
  unavailable: "✕",
  blocked: "✕",
};

export const SEAT_STATE_CLASSES: Readonly<Record<SeatVisualState, string>> = {
  available: "bg-[var(--sf-seat-available)] text-[var(--sf-on-brand)]",
  premium: "bg-[var(--sf-seat-premium)] text-[var(--sf-on-brand)]",
  selected:
    "bg-[var(--sf-seat-selected)] text-[var(--sf-on-brand)] ring-2 ring-[var(--sf-text)] ring-offset-1 ring-offset-[var(--sf-canvas)]",
  "held-by-you": "bg-[var(--sf-seat-held-by-you)] text-[var(--sf-on-brand)]",
  unavailable: "bg-[var(--sf-seat-unavailable)] text-[var(--sf-canvas)] opacity-70",
  blocked: "bg-[var(--sf-seat-unavailable)] text-[var(--sf-canvas)] opacity-70",
};

export interface SeatNodeProps {
  seatId: string;
  x: number;
  y: number;
  size: number;
  visualState: SeatVisualState;
  /** Full accessible name: section, row, seat, availability and price. */
  accessibleName: string;
  /** Present only in interactive mode; exposed as aria-pressed. */
  pressed: boolean | undefined;
  /** Not actionable now (unavailable, or selection limit reached). */
  inert: boolean;
  /** The single roving-tabindex stop of the map. */
  tabbable: boolean;
}

/**
 * One seat. Props are primitives only, so `memo` skips every seat whose state,
 * label, and focus role did not change. Clicks and keys are handled by the map
 * through event delegation (`data-seat-id`), keeping handlers out of props.
 * Unavailable seats stay focusable (`aria-disabled`) so keyboard and screen
 * reader users can still discover them.
 */
export const SeatNode = memo(function SeatNode({
  seatId,
  x,
  y,
  size,
  visualState,
  accessibleName,
  pressed,
  inert,
  tabbable,
}: SeatNodeProps) {
  return (
    <button
      type="button"
      data-seat-id={seatId}
      data-seat-state={visualState}
      aria-label={accessibleName}
      aria-pressed={pressed}
      aria-disabled={inert || undefined}
      tabIndex={tabbable ? 0 : -1}
      // Styling lives in the scoped `.sf-seat` rule (globals.css), keyed by
      // data-seat-state and aria-disabled, to keep per-seat style work small.
      className="sf-seat"
      style={{ left: x, top: y, width: size, height: size }}
    >
      {/* Available seats have no glyph; omitting the empty span saves one
          element per seat (thousands on a large map). */}
      {SEAT_STATE_GLYPHS[visualState] ? <span aria-hidden="true">{SEAT_STATE_GLYPHS[visualState]}</span> : null}
    </button>
  );
});
