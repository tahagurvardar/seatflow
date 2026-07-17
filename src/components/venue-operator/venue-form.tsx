"use client";

import { useActionState } from "react";

import type { ManagementActionState } from "@/app/venue-operator/actions";
import { Button } from "@/components/ui/button";
import { fieldControlStyles, FieldLabel } from "@/components/ui/field";

interface VenueDefaults {
  name?: string;
  slug?: string;
  description?: string | null;
  addressLine1?: string;
  addressLine2?: string | null;
  city?: string;
  countryCode?: string;
  postalCode?: string | null;
  timeZone?: string;
  status?: "DRAFT" | "ACTIVE";
}

interface VenueFormProps {
  action: (state: ManagementActionState, formData: FormData) => Promise<ManagementActionState>;
  defaults?: VenueDefaults;
  submitLabel: string;
}

const initialState: ManagementActionState = {};

export function VenueForm({ action, defaults = {}, submitLabel }: VenueFormProps) {
  const [state, formAction, pending] = useActionState(action, initialState);
  const error = (field: string) => state.fieldErrors?.[field];

  return (
    <form action={formAction} className="grid gap-5 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <FieldLabel htmlFor="venue-name">Venue name</FieldLabel>
        <input id="venue-name" name="name" defaultValue={defaults.name} className={`${fieldControlStyles} mt-2`} minLength={2} maxLength={120} required disabled={pending} aria-invalid={Boolean(error("name"))} />
        {error("name") ? <p className="mt-2 text-sm text-red-700">{error("name")}</p> : null}
      </div>
      <div className="sm:col-span-2">
        <FieldLabel htmlFor="venue-slug">URL slug</FieldLabel>
        <input id="venue-slug" name="slug" defaultValue={defaults.slug} className={`${fieldControlStyles} mt-2 font-mono`} placeholder="generated-from-name" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" disabled={pending} aria-invalid={Boolean(error("slug"))} />
        <p className="mt-2 text-xs text-slate-500">Leave blank when creating to generate it from the name.</p>
        {error("slug") ? <p className="mt-2 text-sm text-red-700">{error("slug")}</p> : null}
      </div>
      <div className="sm:col-span-2">
        <FieldLabel htmlFor="venue-description">Description</FieldLabel>
        <textarea id="venue-description" name="description" defaultValue={defaults.description ?? ""} className={`${fieldControlStyles} mt-2 min-h-28 py-3`} maxLength={1000} disabled={pending} />
      </div>
      <div className="sm:col-span-2">
        <FieldLabel htmlFor="venue-address-1">Address line 1</FieldLabel>
        <input id="venue-address-1" name="addressLine1" defaultValue={defaults.addressLine1} className={`${fieldControlStyles} mt-2`} maxLength={160} required disabled={pending} aria-invalid={Boolean(error("addressLine1"))} />
        {error("addressLine1") ? <p className="mt-2 text-sm text-red-700">{error("addressLine1")}</p> : null}
      </div>
      <div className="sm:col-span-2">
        <FieldLabel htmlFor="venue-address-2">Address line 2</FieldLabel>
        <input id="venue-address-2" name="addressLine2" defaultValue={defaults.addressLine2 ?? ""} className={`${fieldControlStyles} mt-2`} maxLength={160} disabled={pending} />
      </div>
      <div>
        <FieldLabel htmlFor="venue-city">City</FieldLabel>
        <input id="venue-city" name="city" defaultValue={defaults.city} className={`${fieldControlStyles} mt-2`} maxLength={100} required disabled={pending} aria-invalid={Boolean(error("city"))} />
        {error("city") ? <p className="mt-2 text-sm text-red-700">{error("city")}</p> : null}
      </div>
      <div>
        <FieldLabel htmlFor="venue-country">Country code</FieldLabel>
        <input id="venue-country" name="countryCode" defaultValue={defaults.countryCode ?? "AZ"} className={`${fieldControlStyles} mt-2 uppercase`} minLength={2} maxLength={2} required disabled={pending} aria-invalid={Boolean(error("countryCode"))} />
        {error("countryCode") ? <p className="mt-2 text-sm text-red-700">{error("countryCode")}</p> : null}
      </div>
      <div>
        <FieldLabel htmlFor="venue-postal">Postal code</FieldLabel>
        <input id="venue-postal" name="postalCode" defaultValue={defaults.postalCode ?? ""} className={`${fieldControlStyles} mt-2`} maxLength={24} disabled={pending} />
      </div>
      <div>
        <FieldLabel htmlFor="venue-time-zone">Time zone</FieldLabel>
        <input id="venue-time-zone" name="timeZone" defaultValue={defaults.timeZone ?? "Asia/Baku"} className={`${fieldControlStyles} mt-2 font-mono`} required disabled={pending} aria-invalid={Boolean(error("timeZone"))} />
        {error("timeZone") ? <p className="mt-2 text-sm text-red-700">{error("timeZone")}</p> : null}
      </div>
      <div>
        <FieldLabel htmlFor="venue-status">Status</FieldLabel>
        <select id="venue-status" name="status" defaultValue={defaults.status ?? "DRAFT"} className={`${fieldControlStyles} mt-2`} disabled={pending}>
          <option value="DRAFT">Draft</option>
          <option value="ACTIVE">Active</option>
        </select>
      </div>
      <div className="flex items-end">
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
      </div>
      {state.message ? (
        <p className="rounded-2xl bg-red-50 p-4 text-sm text-red-800 sm:col-span-2" aria-live="polite">{state.message}</p>
      ) : null}
    </form>
  );
}
