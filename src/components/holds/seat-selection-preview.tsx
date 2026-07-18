import { SeatMapCoordinateCanvas } from "@/components/seat-maps/seat-map-coordinate-canvas";
import type {
  SelectionSeatView,
  SelectionSectionView,
} from "@/features/holds/inventory";
import { cn } from "@/lib/utils";

function seatClasses(state: SelectionSeatView["state"]) {
  if (state === "AVAILABLE") return "border-emerald-300 bg-emerald-100 text-emerald-900";
  if (state === "HELD_BY_YOU") return "border-indigo-400 bg-indigo-100 text-indigo-900";
  if (state === "BLOCKED") return "border-slate-300 bg-slate-200 text-slate-500 line-through";
  return "border-slate-300 bg-slate-200 text-slate-400";
}

/**
 * Non-interactive availability preview. It honestly shows which seats are
 * available, held by the current customer, or unavailable, without exposing who
 * holds another customer's seat. Used when selection is not possible (signed
 * out, not on sale, or the customer already holds seats).
 */
export function SeatSelectionPreview({
  sections,
}: {
  sections: SelectionSectionView[];
}) {
  const seatCount = sections.reduce(
    (total, section) =>
      total + section.rows.reduce((rowTotal, row) => rowTotal + row.seats.length, 0),
    0,
  );

  if (seatCount === 0) {
    return (
      <div
        className="rounded-3xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-600"
        role="status"
      >
        No seats are available for this session.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-4 text-xs font-semibold text-slate-600" aria-label="Seat legend">
        <span className="flex items-center gap-1.5"><span className="size-3 rounded border border-emerald-300 bg-emerald-100" /> Available</span>
        <span className="flex items-center gap-1.5"><span className="size-3 rounded border border-indigo-400 bg-indigo-100" /> Held by you</span>
        <span className="flex items-center gap-1.5"><span className="size-3 rounded border border-slate-300 bg-slate-200" /> Unavailable</span>
      </div>
      {sections.map((section) => (
        <section
          key={section.id}
          aria-labelledby={`preview-section-${section.id}`}
          className="rounded-3xl border border-slate-200 bg-white p-5 sm:p-6"
        >
          <div className="flex items-baseline justify-between gap-4">
            <h3 id={`preview-section-${section.id}`} className="text-base font-black text-slate-950">
              {section.name}
            </h3>
            <span className="font-mono text-xs font-bold text-slate-500">{section.code}</span>
          </div>
          <SeatMapCoordinateCanvas
            ariaLabel={`${section.name} availability preview`}
            className="mt-4"
            section={{ rows: section.rows.map((row) => ({ ...row, seats: row.seats.map((seat) => ({ ...seat, id: seat.seatId })) })) }}
            renderSeat={({ row, seat }) => (
              <span
                role="img"
                aria-label={`${section.name}, row ${row.label}, seat ${seat.label}, ${seat.type.toLowerCase()}: ${seat.state
                  .toLowerCase()
                  .replace(/_/g, " ")}`}
                title={`${section.code}-${row.label}-${seat.label}`}
                className={cn(
                  "flex size-9 items-center justify-center rounded-t-xl rounded-b-md border font-mono text-[11px] font-black",
                  seatClasses(seat.state),
                )}
              >
                {seat.label}
              </span>
            )}
          />
        </section>
      ))}
    </div>
  );
}
