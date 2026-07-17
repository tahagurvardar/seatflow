import type { SeatState, SeatType } from "@/generated/prisma/enums";
import { cn } from "@/lib/utils";
import { SeatMapCoordinateCanvas } from "@/components/seat-maps/seat-map-coordinate-canvas";

interface RenderSeat {
  id: string;
  label: string;
  x: number;
  y: number;
  type: SeatType;
  state: SeatState;
}

interface SeatMapRendererProps {
  sections: Array<{
    id: string;
    name: string;
    code: string;
    rows: Array<{ id: string; label: string; seats: RenderSeat[] }>;
  }>;
}

function seatColor(type: SeatType, state: SeatState) {
  if (state === "BLOCKED") return "border-slate-300 bg-slate-200 text-slate-500 line-through";
  if (type === "ACCESSIBLE") return "border-sky-300 bg-sky-100 text-sky-900";
  if (type === "COMPANION") return "border-violet-300 bg-violet-100 text-violet-900";
  if (type === "PREMIUM") return "border-amber-300 bg-amber-100 text-amber-950";
  return "border-emerald-300 bg-emerald-100 text-emerald-900";
}

export function SeatMapRenderer({ sections }: SeatMapRendererProps) {
  return (
    <div className="space-y-8">
      <p
        className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900"
        role="note"
      >
        This is a read-only venue layout preview. Seats are not bookable in
        Phase 2.
      </p>
      <div className="mx-auto max-w-xl rounded-b-[2rem] border-x border-b border-orange-200 bg-orange-50 py-3 text-center text-xs font-black uppercase tracking-[0.24em] text-orange-800">
        Stage / screen
      </div>
      {sections.length === 0 ? (
        <p className="rounded-3xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-600">
          This seat map does not contain any sections yet.
        </p>
      ) : null}
      {sections.map((section) => (
        <section
          key={section.id}
          aria-labelledby={`seat-map-section-${section.id}`}
          className="rounded-3xl border border-slate-200 bg-white p-5 sm:p-7"
        >
          <div className="flex items-baseline justify-between gap-4">
            <h2
              id={`seat-map-section-${section.id}`}
              className="text-lg font-black text-slate-950"
            >
              {section.name}
            </h2>
            <span className="font-mono text-xs font-bold text-slate-500">{section.code}</span>
          </div>
          <SeatMapCoordinateCanvas
            ariaLabel={`${section.name} coordinate layout`}
            className="mt-5"
            section={section}
            renderSeat={({ row, seat }) => (
              <span
                aria-label={`${section.name}, row ${row.label}, seat ${seat.label}: ${seat.type.toLowerCase()}, ${seat.state.toLowerCase()}`}
                role="img"
                title={`${section.code}-${row.label}-${seat.label} · ${seat.type.toLowerCase()} · ${seat.state.toLowerCase()} · (${seat.x}, ${seat.y})`}
                className={cn(
                  "flex size-9 items-center justify-center rounded-t-xl rounded-b-md border font-mono text-[11px] font-black",
                  seatColor(seat.type, seat.state),
                )}
              >
                {seat.label}
              </span>
            )}
          />
        </section>
      ))}
      <div className="flex flex-wrap gap-4 text-xs font-semibold text-slate-600" aria-label="Seat legend">
        <span>Green: standard</span><span>Blue: accessible</span><span>Violet: companion</span><span>Amber: premium</span><span>Gray: blocked</span>
      </div>
    </div>
  );
}
