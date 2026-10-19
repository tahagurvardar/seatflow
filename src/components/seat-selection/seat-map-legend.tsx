import {
  SEAT_STATE_CLASSES,
  SEAT_STATE_GLYPHS,
} from "@/components/seat-selection/seat-node";
import {
  SEAT_VISUAL_LABELS,
  type SeatVisualState,
} from "@/features/holds/selection";
import { cn } from "@/lib/utils";

export const DEFAULT_LEGEND_STATES: readonly SeatVisualState[] = [
  "available",
  "selected",
  "premium",
  "held-by-you",
  "unavailable",
];

/**
 * Seat legend: swatch colour, the same glyph the seat shows, and a text label.
 * Callers pass only the states that can actually appear (for example, omit
 * "premium" when the published map has no PREMIUM seats).
 */
export function SeatMapLegend({
  states = DEFAULT_LEGEND_STATES,
  className,
}: {
  states?: readonly SeatVisualState[];
  className?: string;
}) {
  return (
    <ul
      aria-label="Seat legend"
      className={cn(
        "flex flex-wrap items-center gap-x-5 gap-y-2 text-sm font-semibold text-[var(--sf-text-secondary)]",
        className,
      )}
    >
      {states.map((state) => (
        <li key={state} className="flex items-center gap-2" data-legend-state={state}>
          <span
            aria-hidden="true"
            className={cn(
              "flex size-5 items-center justify-center rounded-full text-[11px] font-black leading-none",
              SEAT_STATE_CLASSES[state],
              state === "selected" && "ring-offset-0",
            )}
          >
            {SEAT_STATE_GLYPHS[state]}
          </span>
          {SEAT_VISUAL_LABELS[state]}
        </li>
      ))}
    </ul>
  );
}
