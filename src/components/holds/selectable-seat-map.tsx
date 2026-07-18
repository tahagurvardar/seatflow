"use client";

import { useActionState, useMemo, useState } from "react";

import type { HoldActionState } from "@/app/customer/hold-actions";
import { SeatMapCoordinateCanvas } from "@/components/seat-maps/seat-map-coordinate-canvas";
import { buttonStyles } from "@/components/ui/button";
import type { SupportedCurrency } from "@/config/site";
import type {
  SelectionSeatView,
  SelectionSectionView,
} from "@/features/holds/inventory";
import { formatMinorCurrency } from "@/features/events/money";
import { cn } from "@/lib/utils";

interface SelectableSeatMapProps {
  sections: SelectionSectionView[];
  maxSeats: number;
  currency: SupportedCurrency | null;
  action: (state: HoldActionState, formData: FormData) => Promise<HoldActionState>;
}

function seatClasses(state: SelectionSeatView["state"], selected: boolean) {
  if (selected) return "border-orange-500 bg-orange-500 text-white shadow";
  if (state === "AVAILABLE") return "border-emerald-300 bg-emerald-100 text-emerald-900 hover:border-emerald-500";
  if (state === "HELD_BY_YOU") return "border-indigo-400 bg-indigo-100 text-indigo-900";
  if (state === "BLOCKED") return "border-slate-300 bg-slate-200 text-slate-500 line-through";
  return "border-slate-300 bg-slate-200 text-slate-400";
}

export function SelectableSeatMap({
  sections,
  maxSeats,
  currency,
  action,
}: SelectableSeatMapProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [state, formAction, pending] = useActionState<HoldActionState, FormData>(
    action,
    {},
  );

  const seatById = useMemo(() => {
    const map = new Map<string, SelectionSeatView>();
    for (const section of sections) {
      for (const row of section.rows) {
        for (const seat of row.seats) map.set(seat.seatId, seat);
      }
    }
    return map;
  }, [sections]);

  // One unguessable idempotency key per picker instance. A successful hold
  // redirects away, and a failed attempt leaves no hold, so reusing this key
  // across retries is safe; the server dedupes identical requests.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const previewTotal = selected.reduce(
    (total, seatId) => total + (seatById.get(seatId)?.priceMinor ?? 0),
    0,
  );
  const availableSeatCount = [...seatById.values()].filter(
    (seat) => seat.state === "AVAILABLE",
  ).length;
  const atLimit = selected.length >= maxSeats;

  if (seatById.size === 0) {
    return (
      <div
        className="rounded-3xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-600"
        role="status"
      >
        No seats are available for this session.
      </div>
    );
  }

  function toggleSeat(seatId: string, seatState: SelectionSeatView["state"]) {
    if (seatState !== "AVAILABLE") return;
    setSelected((current) => {
      if (current.includes(seatId)) {
        return current.filter((id) => id !== seatId);
      }
      if (current.length >= maxSeats) return current;
      return [...current, seatId];
    });
  }

  return (
    <form action={formAction} className="space-y-6">
      <div className="flex flex-wrap gap-4 text-xs font-semibold text-slate-600" aria-label="Seat legend">
        <span className="flex items-center gap-1.5"><span className="size-3 rounded border border-emerald-300 bg-emerald-100" /> Available</span>
        <span className="flex items-center gap-1.5"><span className="size-3 rounded border border-orange-500 bg-orange-500" /> Selected</span>
        <span className="flex items-center gap-1.5"><span className="size-3 rounded border border-indigo-400 bg-indigo-100" /> Held by you</span>
        <span className="flex items-center gap-1.5"><span className="size-3 rounded border border-slate-300 bg-slate-200" /> Unavailable</span>
      </div>

      {availableSeatCount === 0 ? (
        <p
          className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
          role="status"
        >
          No seats are currently available to hold. Refresh to check again.
        </p>
      ) : null}

      <div className="space-y-6">
        {sections.map((section) => (
          <section
            key={section.id}
            aria-labelledby={`select-section-${section.id}`}
            className="rounded-3xl border border-slate-200 bg-white p-5 sm:p-6"
          >
            <div className="flex items-baseline justify-between gap-4">
              <h3 id={`select-section-${section.id}`} className="text-base font-black text-slate-950">
                {section.name}
              </h3>
              <span className="font-mono text-xs font-bold text-slate-500">{section.code}</span>
            </div>
            <SeatMapCoordinateCanvas
              ariaLabel={`${section.name} selectable layout`}
              className="mt-4"
              section={{ rows: section.rows.map((row) => ({ ...row, seats: row.seats.map((seat) => ({ ...seat, id: seat.seatId })) })) }}
              renderSeat={({ row, seat }) => {
                const isSelected = selected.includes(seat.seatId);
                const interactive = seat.state === "AVAILABLE";
                const priceLabel =
                  seat.priceMinor !== null && seat.currency
                    ? `, ${formatMinorCurrency(seat.priceMinor, seat.currency)}`
                    : "";
                return (
                  <button
                    type="button"
                    disabled={!interactive || (atLimit && !isSelected)}
                    aria-pressed={isSelected}
                    aria-label={`${section.name}, row ${row.label}, seat ${seat.label}, ${seat.type.toLowerCase()}: ${seat.state
                      .toLowerCase()
                      .replace(/_/g, " ")}${priceLabel}`}
                    title={`${section.code}-${row.label}-${seat.label}`}
                    onClick={() => toggleSeat(seat.seatId, seat.state)}
                    className={cn(
                      "flex size-9 items-center justify-center rounded-t-xl rounded-b-md border font-mono text-[11px] font-black transition disabled:cursor-not-allowed",
                      seatClasses(seat.state, isSelected),
                    )}
                  >
                    {seat.label}
                  </button>
                );
              }}
            />
          </section>
        ))}
      </div>

      {selected.map((seatId) => (
        <input key={seatId} type="hidden" name="seatIds" value={seatId} />
      ))}
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      <div className="sticky bottom-4 rounded-3xl border border-slate-200 bg-white/95 p-5 shadow-xl shadow-slate-950/5 backdrop-blur">
        {state.message ? (
          <p className="mb-3 rounded-2xl bg-red-50 p-3 text-sm text-red-800" role="alert">
            {state.message}
          </p>
        ) : null}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-slate-950">
              {selected.length} of {maxSeats} seats selected
            </p>
            <p className="mt-1 text-2xl font-black tracking-tight text-slate-950">
              {currency ? formatMinorCurrency(previewTotal, currency) : "—"}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Estimated total. The server confirms availability and the official price when your hold is created.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {selected.length > 0 ? (
              <button
                type="button"
                onClick={() => setSelected([])}
                className={buttonStyles({ variant: "ghost", size: "sm" })}
              >
                Clear
              </button>
            ) : null}
            <button
              type="submit"
              disabled={pending || selected.length === 0}
              className={buttonStyles({ size: "lg" })}
            >
              {pending ? "Holding…" : `Hold ${selected.length || ""} ${selected.length === 1 ? "seat" : "seats"}`.trim()}
            </button>
          </div>
        </div>
        {atLimit ? (
          <p className="mt-3 text-xs font-semibold text-amber-700">
            You have reached the maximum of {maxSeats} seats per hold.
          </p>
        ) : null}
      </div>
    </form>
  );
}
