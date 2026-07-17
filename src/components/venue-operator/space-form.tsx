"use client";

import { useActionState } from "react";

import type { ManagementActionState } from "@/app/venue-operator/actions";
import { Button } from "@/components/ui/button";
import { fieldControlStyles, FieldLabel } from "@/components/ui/field";
import type { SpaceStatus, SpaceType } from "@/generated/prisma/enums";

interface SpaceFormProps {
  action: (state: ManagementActionState, formData: FormData) => Promise<ManagementActionState>;
  defaults?: {
    name?: string;
    slug?: string;
    description?: string | null;
    type?: SpaceType;
    status?: Exclude<SpaceStatus, "ARCHIVED">;
  };
  submitLabel: string;
}

const initialState: ManagementActionState = {};

export function SpaceForm({ action, defaults = {}, submitLabel }: SpaceFormProps) {
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="grid gap-5 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <FieldLabel htmlFor="space-name">Space name</FieldLabel>
        <input id="space-name" name="name" defaultValue={defaults.name} className={`${fieldControlStyles} mt-2`} required minLength={2} maxLength={120} disabled={pending} />
        {state.fieldErrors?.name ? <p className="mt-2 text-sm text-red-700">{state.fieldErrors.name}</p> : null}
      </div>
      <div className="sm:col-span-2">
        <FieldLabel htmlFor="space-slug">URL slug</FieldLabel>
        <input id="space-slug" name="slug" defaultValue={defaults.slug} className={`${fieldControlStyles} mt-2 font-mono`} placeholder="generated-from-name" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" disabled={pending} />
        {state.fieldErrors?.slug ? <p className="mt-2 text-sm text-red-700">{state.fieldErrors.slug}</p> : null}
      </div>
      <div className="sm:col-span-2">
        <FieldLabel htmlFor="space-description">Description</FieldLabel>
        <textarea id="space-description" name="description" defaultValue={defaults.description ?? ""} className={`${fieldControlStyles} mt-2 min-h-28 py-3`} maxLength={1000} disabled={pending} />
      </div>
      <div>
        <FieldLabel htmlFor="space-type">Space type</FieldLabel>
        <select id="space-type" name="type" defaultValue={defaults.type ?? "GENERAL"} className={`${fieldControlStyles} mt-2`} disabled={pending}>
          <option value="GENERAL">General</option>
          <option value="CINEMA">Cinema</option>
          <option value="THEATRE">Theatre</option>
          <option value="CONCERT_HALL">Concert hall</option>
          <option value="STADIUM">Stadium</option>
          <option value="ARENA">Arena</option>
        </select>
      </div>
      <div>
        <FieldLabel htmlFor="space-status">Status</FieldLabel>
        <select id="space-status" name="status" defaultValue={defaults.status ?? "DRAFT"} className={`${fieldControlStyles} mt-2`} disabled={pending}>
          <option value="DRAFT">Draft</option>
          <option value="ACTIVE">Active</option>
        </select>
      </div>
      <div className="sm:col-span-2">
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : submitLabel}</Button>
      </div>
      {state.message ? <p className="rounded-2xl bg-red-50 p-4 text-sm text-red-800 sm:col-span-2" aria-live="polite">{state.message}</p> : null}
    </form>
  );
}
