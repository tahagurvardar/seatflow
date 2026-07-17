"use client";

import { useState } from "react";

import { SeatMapCoordinateCanvas } from "@/components/seat-maps/seat-map-coordinate-canvas";
import { Button } from "@/components/ui/button";
import { fieldControlStyles, FieldLabel } from "@/components/ui/field";
import type { SeatState, SeatType } from "@/generated/prisma/enums";
import { cn } from "@/lib/utils";

interface EditorSeat {
  id: string;
  label: string;
  x: number;
  y: number;
  type: SeatType;
  state: SeatState;
}

interface SeatEditorProps {
  action: (formData: FormData) => Promise<void>;
  sections: Array<{
    id: string;
    code: string;
    rows: Array<{ id: string; label: string; seats: EditorSeat[] }>;
  }>;
}

function seatAppearance(type: SeatType, state: SeatState) {
  if (state === "BLOCKED") {
    return "border-slate-300 bg-slate-200 text-slate-500 line-through opacity-70";
  }
  if (type === "ACCESSIBLE") return "border-sky-300 bg-sky-100 text-sky-900";
  if (type === "COMPANION") return "border-violet-300 bg-violet-100 text-violet-900";
  if (type === "PREMIUM") return "border-amber-300 bg-amber-100 text-amber-950";
  return "border-emerald-300 bg-emerald-100 text-emerald-900";
}

export function SeatEditor({ action, sections }: SeatEditorProps) {
  const seats = sections.flatMap((section) =>
    section.rows.flatMap((row) =>
      row.seats.map((seat) => ({ ...seat, sectionId: section.id, sectionCode: section.code, rowId: row.id, rowLabel: row.label })),
    ),
  );
  const [selectedSeatId, setSelectedSeatId] = useState(seats[0]?.id ?? "");
  const selected = seats.find((seat) => seat.id === selectedSeatId) ?? seats[0];

  if (!selected) {
    return <p className="rounded-2xl bg-slate-100 p-5 text-sm text-slate-600">Add a row and seat, or use the bulk generator, to begin editing seat properties.</p>;
  }

  return (
    <div className="grid min-w-0 gap-6 xl:grid-cols-[1.4fr_0.6fr]">
      <fieldset className="min-w-0 rounded-3xl border border-slate-200 bg-slate-50 p-5">
        <legend className="px-2 text-sm font-black text-slate-950">Select a seat</legend>
        <div className="space-y-5">
          {sections.map((section) => (
            <div key={section.id}>
              <p className="mb-2 font-mono text-xs font-bold text-slate-500">
                Section {section.code}
              </p>
              <SeatMapCoordinateCanvas
                ariaLabel={`Section ${section.code} interactive coordinate layout`}
                section={section}
                renderSeat={({ row, seat }) => (
                  <label className="block cursor-pointer">
                    <input
                      type="radio"
                      name="seat-selection"
                      value={seat.id}
                      checked={selected.id === seat.id}
                      onChange={() => setSelectedSeatId(seat.id)}
                      aria-label={`${section.code} row ${row.label} seat ${seat.label}`}
                      className="peer sr-only"
                    />
                    <span
                      className={cn(
                        "flex size-9 items-center justify-center rounded-t-xl rounded-b-md border font-mono text-[11px] font-black transition peer-focus-visible:ring-2 peer-focus-visible:ring-orange-500 peer-checked:border-orange-500 peer-checked:bg-orange-500 peer-checked:text-white peer-checked:opacity-100",
                        seatAppearance(seat.type, seat.state),
                      )}
                    >
                      {seat.label}
                    </span>
                  </label>
                )}
              />
            </div>
          ))}
        </div>
      </fieldset>

      <div key={selected.id} className="min-w-0 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <form action={action}>
          <input type="hidden" name="sectionId" value={selected.sectionId} />
          <input type="hidden" name="rowId" value={selected.rowId} />
          <input type="hidden" name="seatId" value={selected.id} />
          <input type="hidden" name="intent" value="update-seat" />
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-orange-600">{selected.sectionCode} · Row {selected.rowLabel}</p>
          <h3 className="mt-2 text-xl font-black text-slate-950">Edit seat {selected.label}</h3>
          <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
            <div><FieldLabel htmlFor={`seat-label-${selected.id}`}>Label</FieldLabel><input id={`seat-label-${selected.id}`} name="label" defaultValue={selected.label} className={`${fieldControlStyles} mt-1`} required /></div>
            <div><FieldLabel htmlFor={`seat-type-${selected.id}`}>Type</FieldLabel><select id={`seat-type-${selected.id}`} name="type" defaultValue={selected.type} className={`${fieldControlStyles} mt-1`}><option value="STANDARD">Standard</option><option value="ACCESSIBLE">Accessible</option><option value="COMPANION">Companion</option><option value="PREMIUM">Premium</option></select></div>
            <div><FieldLabel htmlFor={`seat-state-${selected.id}`}>State</FieldLabel><select id={`seat-state-${selected.id}`} name="state" defaultValue={selected.state} className={`${fieldControlStyles} mt-1`}><option value="ACTIVE">Active</option><option value="BLOCKED">Blocked</option></select></div>
            <div><FieldLabel htmlFor={`seat-x-${selected.id}`}>X coordinate</FieldLabel><input id={`seat-x-${selected.id}`} name="x" type="number" defaultValue={selected.x} min={0} max={10000} className={`${fieldControlStyles} mt-1`} required /></div>
            <div><FieldLabel htmlFor={`seat-y-${selected.id}`}>Y coordinate</FieldLabel><input id={`seat-y-${selected.id}`} name="y" type="number" defaultValue={selected.y} min={0} max={10000} className={`${fieldControlStyles} mt-1`} required /></div>
          </div>
          <Button type="submit" size="sm" className="mt-5">Save seat</Button>
        </form>
        <form action={action} className="mt-5 border-t border-slate-100 pt-4">
          <input type="hidden" name="intent" value="delete-seat" />
          <input type="hidden" name="sectionId" value={selected.sectionId} />
          <input type="hidden" name="rowId" value={selected.rowId} />
          <input type="hidden" name="seatId" value={selected.id} />
          <label className="flex items-start gap-2 text-xs text-slate-600"><input type="checkbox" name="confirmation" value="delete" required className="mt-0.5" />Delete this seat permanently from the draft.</label>
          <Button type="submit" variant="outline" size="sm" className="mt-3">Delete seat</Button>
        </form>
      </div>
    </div>
  );
}
