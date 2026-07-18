"use client";

import { useActionState } from "react";

import type { OrganizerActionState } from "@/app/organizer/actions";
import { Button } from "@/components/ui/button";
import { fieldControlStyles, FieldLabel } from "@/components/ui/field";

interface EventDefaults {
  title?: string;
  slug?: string;
  shortDescription?: string;
  description?: string;
  category?: "CONCERT" | "CINEMA" | "THEATRE" | "SPORT" | "OTHER";
  imagePath?: string | null;
}

interface EventFormProps {
  action: (
    state: OrganizerActionState,
    formData: FormData,
  ) => Promise<OrganizerActionState>;
  defaults?: EventDefaults;
  submitLabel: string;
}

const initialState: OrganizerActionState = {};

export function EventForm({
  action,
  defaults = {},
  submitLabel,
}: EventFormProps) {
  const [state, formAction, pending] = useActionState(action, initialState);
  const error = (field: string) => state.fieldErrors?.[field];

  return (
    <form action={formAction} className="grid gap-5">
      <div>
        <FieldLabel htmlFor="event-title">Event title</FieldLabel>
        <input id="event-title" name="title" defaultValue={defaults.title} className={`${fieldControlStyles} mt-2`} minLength={3} maxLength={160} required disabled={pending} aria-invalid={Boolean(error("title"))} />
        {error("title") ? <p className="mt-2 text-sm text-red-700">{error("title")}</p> : null}
      </div>
      <div>
        <FieldLabel htmlFor="event-slug">Organizer-scoped slug</FieldLabel>
        <input id="event-slug" name="slug" defaultValue={defaults.slug} className={`${fieldControlStyles} mt-2 font-mono`} placeholder="generated-from-title" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" disabled={pending} aria-invalid={Boolean(error("slug"))} />
        <p className="mt-2 text-xs text-slate-500">Leave blank on creation to generate it. Public URLs also include the organizer slug.</p>
        {error("slug") ? <p className="mt-2 text-sm text-red-700">{error("slug")}</p> : null}
      </div>
      <div>
        <FieldLabel htmlFor="event-short-description">Short description</FieldLabel>
        <textarea id="event-short-description" name="shortDescription" defaultValue={defaults.shortDescription} className={`${fieldControlStyles} mt-2 min-h-24 py-3`} minLength={10} maxLength={280} required disabled={pending} aria-invalid={Boolean(error("shortDescription"))} />
        {error("shortDescription") ? <p className="mt-2 text-sm text-red-700">{error("shortDescription")}</p> : null}
      </div>
      <div>
        <FieldLabel htmlFor="event-description">Full description</FieldLabel>
        <textarea id="event-description" name="description" defaultValue={defaults.description} className={`${fieldControlStyles} mt-2 min-h-44 py-3`} minLength={30} maxLength={10000} required disabled={pending} aria-invalid={Boolean(error("description"))} />
        {error("description") ? <p className="mt-2 text-sm text-red-700">{error("description")}</p> : null}
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <FieldLabel htmlFor="event-category">Category</FieldLabel>
          <select id="event-category" name="category" defaultValue={defaults.category ?? "CONCERT"} className={`${fieldControlStyles} mt-2`} disabled={pending}>
            <option value="CONCERT">Concert</option>
            <option value="CINEMA">Cinema</option>
            <option value="THEATRE">Theatre</option>
            <option value="SPORT">Sport</option>
            <option value="OTHER">Other</option>
          </select>
        </div>
        <div>
          <FieldLabel htmlFor="event-image">Local image path</FieldLabel>
          <input id="event-image" name="imagePath" defaultValue={defaults.imagePath ?? ""} className={`${fieldControlStyles} mt-2 font-mono`} placeholder="/events/aurora-room.svg" disabled={pending} aria-invalid={Boolean(error("imagePath"))} />
          {error("imagePath") ? <p className="mt-2 text-sm text-red-700">{error("imagePath")}</p> : null}
        </div>
      </div>
      {state.message ? <p className="rounded-2xl bg-red-50 p-4 text-sm text-red-800" role="alert">{state.message}</p> : null}
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
