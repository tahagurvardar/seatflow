"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { fieldControlStyles, FieldLabel } from "@/components/ui/field";
import {
  generateRowLabels,
  generateSeatLabels,
} from "@/features/seat-maps/row-labels";

interface BulkRowGeneratorProps {
  action: (formData: FormData) => Promise<void>;
  sectionId: string;
}

function GenerateButton() {
  const { pending } = useFormStatus();

  return (
    <Button
      type="submit"
      variant="secondary"
      size="sm"
      className="mt-4"
      disabled={pending}
    >
      {pending ? "Generating…" : "Generate rows and seats"}
    </Button>
  );
}

export function BulkRowGenerator({ action, sectionId }: BulkRowGeneratorProps) {
  const [startRowLabel, setStartRowLabel] = useState("A");
  const [rowCount, setRowCount] = useState(5);
  const [seatsPerRow, setSeatsPerRow] = useState(10);
  const [startSeatNumber, setStartSeatNumber] = useState(1);
  let previewRowLabels: string[] = [];
  let previewSeatLabels: string[] = [];

  try {
    previewRowLabels = generateRowLabels(
      startRowLabel,
      Math.min(Math.max(rowCount, 0), 30),
    );
    previewSeatLabels = generateSeatLabels(
      startSeatNumber,
      Math.min(Math.max(seatsPerRow, 0), 80),
    );
  } catch {
    previewRowLabels = [];
    previewSeatLabels = [];
  }

  const visibleRows = previewRowLabels.slice(0, 6);
  const visibleSeats = previewSeatLabels.slice(0, 12);

  return (
    <form
      action={action}
      className="rounded-3xl border border-violet-200 bg-violet-50/60 p-5"
    >
      <input type="hidden" name="intent" value="bulk-generate" />
      <input type="hidden" name="sectionId" value={sectionId} />
      <h3 className="font-black text-slate-950">Bulk row generator</h3>
      <p className="mt-1 text-xs leading-5 text-slate-600">
        Preview generated labels locally; the server validates limits,
        collisions, coordinates, and ownership before one atomic write.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div>
          <FieldLabel htmlFor={`start-row-${sectionId}`}>Start row</FieldLabel>
          <input
            id={`start-row-${sectionId}`}
            name="startRowLabel"
            value={startRowLabel}
            onChange={(event) =>
              setStartRowLabel(event.target.value.toUpperCase())
            }
            className={`${fieldControlStyles} mt-1 uppercase`}
            pattern="[A-Za-z]{1,3}"
            required
          />
        </div>
        <div>
          <FieldLabel htmlFor={`row-count-${sectionId}`}>Rows</FieldLabel>
          <input
            id={`row-count-${sectionId}`}
            name="rowCount"
            type="number"
            value={rowCount}
            onChange={(event) => setRowCount(event.target.valueAsNumber || 0)}
            className={`${fieldControlStyles} mt-1`}
            min={1}
            max={30}
            required
          />
        </div>
        <div>
          <FieldLabel htmlFor={`seats-count-${sectionId}`}>
            Seats per row
          </FieldLabel>
          <input
            id={`seats-count-${sectionId}`}
            name="seatsPerRow"
            type="number"
            value={seatsPerRow}
            onChange={(event) =>
              setSeatsPerRow(event.target.valueAsNumber || 0)
            }
            className={`${fieldControlStyles} mt-1`}
            min={1}
            max={80}
            required
          />
        </div>
        <div>
          <FieldLabel htmlFor={`seat-start-${sectionId}`}>
            First seat number
          </FieldLabel>
          <input
            id={`seat-start-${sectionId}`}
            name="startSeatNumber"
            type="number"
            value={startSeatNumber}
            onChange={(event) =>
              setStartSeatNumber(event.target.valueAsNumber || 0)
            }
            className={`${fieldControlStyles} mt-1`}
            min={1}
            max={9999}
            required
          />
        </div>
        <div>
          <FieldLabel htmlFor={`horizontal-${sectionId}`}>
            Horizontal spacing
          </FieldLabel>
          <input
            id={`horizontal-${sectionId}`}
            name="horizontalSpacing"
            type="number"
            defaultValue={40}
            className={`${fieldControlStyles} mt-1`}
            min={1}
            max={200}
            required
          />
        </div>
        <div>
          <FieldLabel htmlFor={`vertical-${sectionId}`}>
            Vertical spacing
          </FieldLabel>
          <input
            id={`vertical-${sectionId}`}
            name="verticalSpacing"
            type="number"
            defaultValue={40}
            className={`${fieldControlStyles} mt-1`}
            min={1}
            max={200}
            required
          />
        </div>
      </div>

      <div
        className="mt-4 rounded-2xl bg-white p-3 text-xs text-slate-600"
        aria-live="polite"
      >
        {previewRowLabels.length > 0 && previewSeatLabels.length > 0 ? (
          <>
            <p>
              Preview: rows {previewRowLabels.join(", ")} ·{" "}
              {rowCount * seatsPerRow} seats
            </p>
            <div
              className="mt-3 max-h-52 space-y-2 overflow-auto rounded-xl bg-slate-50 p-3"
              aria-label="Generated seat preview"
            >
              {visibleRows.map((rowLabel) => (
                <div key={rowLabel} className="flex min-w-max items-center gap-2">
                  <span className="w-7 text-right font-mono font-bold text-slate-500">
                    {rowLabel}
                  </span>
                  {visibleSeats.map((seatLabel) => (
                    <span
                      key={seatLabel}
                      className="flex size-7 items-center justify-center rounded-t-lg rounded-b-sm border border-violet-200 bg-white font-mono text-[10px] font-bold text-violet-900"
                    >
                      {seatLabel}
                    </span>
                  ))}
                  {previewSeatLabels.length > visibleSeats.length ? (
                    <span className="text-slate-400">…</span>
                  ) : null}
                </div>
              ))}
              {previewRowLabels.length > visibleRows.length ? (
                <p className="pl-9 text-slate-400">Additional rows omitted…</p>
              ) : null}
            </div>
          </>
        ) : (
          "Enter a valid A–ZZZ row range and numeric seat range."
        )}
      </div>
      <GenerateButton />
    </form>
  );
}
