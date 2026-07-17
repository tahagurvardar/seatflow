"use client";

import { useActionState } from "react";

import {
  createVenueOperatorOrganizationAction,
  type ManagementActionState,
} from "@/app/venue-operator/actions";
import { Button } from "@/components/ui/button";
import { fieldControlStyles, FieldLabel } from "@/components/ui/field";

const initialState: ManagementActionState = {};

export function VenueOperatorOrganizationForm() {
  const [state, action, pending] = useActionState(
    createVenueOperatorOrganizationAction,
    initialState,
  );

  return (
    <form action={action} className="mt-8 space-y-5">
      <div>
        <FieldLabel htmlFor="venue-operator-name">Organization name</FieldLabel>
        <input
          id="venue-operator-name"
          name="name"
          className={`${fieldControlStyles} mt-2`}
          type="text"
          autoComplete="organization"
          placeholder="Caspian Venue Group"
          minLength={2}
          maxLength={100}
          required
          disabled={pending}
          aria-invalid={Boolean(state.fieldErrors?.name)}
          aria-describedby={state.fieldErrors?.name ? "venue-operator-name-error" : "venue-operator-slug-hint"}
        />
        <p id="venue-operator-slug-hint" className="mt-2 text-xs leading-5 text-slate-500">
          SeatFlow creates a stable workspace slug from this name.
        </p>
        {state.fieldErrors?.name ? (
          <p id="venue-operator-name-error" className="mt-2 text-sm text-red-700">
            {state.fieldErrors.name}
          </p>
        ) : null}
      </div>
      <div aria-live="polite">
        {state.message ? (
          <p className="rounded-2xl bg-red-50 p-4 text-sm text-red-800">{state.message}</p>
        ) : null}
      </div>
      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? "Creating workspace…" : "Create venue-operator workspace"}
      </Button>
    </form>
  );
}
