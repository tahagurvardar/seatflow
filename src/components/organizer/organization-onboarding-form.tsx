"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { fieldControlStyles, FieldLabel } from "@/components/ui/field";
import {
  createOrganizerOrganizationAction,
  type OrganizationOnboardingState,
} from "@/app/organizer/onboarding/actions";

const initialState: OrganizationOnboardingState = {};

export function OrganizationOnboardingForm() {
  const [state, action, pending] = useActionState(
    createOrganizerOrganizationAction,
    initialState,
  );

  return (
    <form action={action} className="mt-8 space-y-5">
      <div>
        <FieldLabel htmlFor="organization-name">Organization name</FieldLabel>
        <input
          id="organization-name"
          name="name"
          className={`${fieldControlStyles} mt-2`}
          type="text"
          autoComplete="organization"
          placeholder="Northstar Live"
          minLength={2}
          maxLength={100}
          required
          disabled={pending}
          aria-invalid={Boolean(state.fieldErrors?.name)}
          aria-describedby={
            state.fieldErrors?.name ? "organization-name-error" : "slug-hint"
          }
        />
        <p id="slug-hint" className="mt-2 text-xs leading-5 text-slate-500">
          SeatFlow creates a normalized URL slug from this name. Organization
          names must resolve to a unique slug.
        </p>
        {state.fieldErrors?.name ? (
          <p id="organization-name-error" className="mt-2 text-sm text-red-700">
            {state.fieldErrors.name}
          </p>
        ) : null}
      </div>

      <div aria-live="polite" aria-atomic="true">
        {state.message ? (
          <p className="rounded-2xl bg-red-50 p-4 text-sm text-red-800">
            {state.message}
          </p>
        ) : null}
      </div>

      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? "Creating organization…" : "Create organizer workspace"}
      </Button>
    </form>
  );
}
