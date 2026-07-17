import type { ReactNode } from "react";

import type { SeatState, SeatType } from "@/generated/prisma/enums";
import { cn } from "@/lib/utils";

interface CoordinateSeat {
  id: string;
  label: string;
  x: number;
  y: number;
  type: SeatType;
  state: SeatState;
}

interface CoordinateRow {
  id: string;
  label: string;
  seats: CoordinateSeat[];
}

interface CoordinateSection {
  id: string;
  code: string;
  rows: CoordinateRow[];
}

interface SeatRenderContext {
  row: CoordinateRow;
  seat: CoordinateSeat;
}

interface SeatMapCoordinateCanvasProps {
  ariaLabel: string;
  className?: string;
  renderSeat: (context: SeatRenderContext) => ReactNode;
  section: CoordinateSection;
}

const ROW_LABEL_GUTTER = 56;
const CANVAS_PADDING = 12;
const SEAT_SIZE = 36;
const EMPTY_ROW_SPACING = 44;

function rowTop(row: CoordinateRow, rowIndex: number) {
  return row.seats.length > 0
    ? Math.min(...row.seats.map((seat) => seat.y))
    : rowIndex * EMPTY_ROW_SPACING;
}

export function SeatMapCoordinateCanvas({
  ariaLabel,
  className,
  renderSeat,
  section,
}: SeatMapCoordinateCanvasProps) {
  const seats = section.rows.flatMap((row) => row.seats);
  const rowPositions = section.rows.map((row, index) => rowTop(row, index));
  const maximumX = Math.max(0, ...seats.map((seat) => seat.x));
  const maximumY = Math.max(
    0,
    ...seats.map((seat) => seat.y),
    ...rowPositions,
  );
  const canvasStyle = {
    height: Math.max(112, maximumY + SEAT_SIZE + CANVAS_PADDING * 2),
    width: Math.max(
      360,
      ROW_LABEL_GUTTER + maximumX + SEAT_SIZE + CANVAS_PADDING,
    ),
  };

  return (
    <div
      aria-label={ariaLabel}
      className={cn(
        "max-h-[32rem] overflow-auto rounded-2xl border border-slate-200 bg-slate-100 p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500",
        className,
      )}
      role="region"
      tabIndex={0}
    >
      <div
        className="relative overflow-hidden rounded-xl bg-white shadow-inner"
        style={{
          ...canvasStyle,
          backgroundImage:
            "radial-gradient(circle, rgb(203 213 225) 1px, transparent 1px)",
          backgroundSize: "20px 20px",
        }}
      >
        {section.rows.map((row, rowIndex) => (
          <span
            key={row.id}
            aria-hidden="true"
            className="absolute left-3 flex h-9 w-8 items-center justify-end font-mono text-xs font-black text-slate-500"
            style={{ top: rowPositions[rowIndex] + CANVAS_PADDING }}
          >
            {row.label}
          </span>
        ))}

        {section.rows.flatMap((row) =>
          row.seats.map((seat) => (
            <div
              key={seat.id}
              data-seat-coordinate={`${seat.x},${seat.y}`}
              className="absolute"
              style={{
                left: ROW_LABEL_GUTTER + seat.x,
                top: CANVAS_PADDING + seat.y,
              }}
            >
              {renderSeat({ row, seat })}
            </div>
          )),
        )}
      </div>
    </div>
  );
}
