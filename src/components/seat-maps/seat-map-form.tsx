"use client";

import { useActionState } from "react";

import type { ManagementActionState } from "@/app/venue-operator/actions";
import { Button } from "@/components/ui/button";
import { fieldControlStyles, FieldLabel } from "@/components/ui/field";

interface SeatMapFormProps {
  action: (state: ManagementActionState, formData: FormData) => Promise<ManagementActionState>;
}

const initialState: ManagementActionState = {};

export function SeatMapForm({ action }: SeatMapFormProps) {
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="space-y-5">
      <div>
        <FieldLabel htmlFor="seat-map-name">Seat-map name</FieldLabel>
        <input id="seat-map-name" name="name" className={`${fieldControlStyles} mt-2`} placeholder="Main auditorium layout" minLength={2} maxLength={120} required disabled={pending} />
        {state.fieldErrors?.name ? <p className="mt-2 text-sm text-red-700">{state.fieldErrors.name}</p> : null}
      </div>
      {state.message ? <p className="rounded-2xl bg-red-50 p-4 text-sm text-red-800" aria-live="polite">{state.message}</p> : null}
      <Button type="submit" size="lg" disabled={pending}>{pending ? "Creating draft…" : "Create draft seat map"}</Button>
    </form>
  );
}
