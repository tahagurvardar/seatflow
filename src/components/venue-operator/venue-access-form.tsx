"use client";

import { useActionState } from "react";

import type { VenueAccessActionState } from "@/app/venue-operator/access-actions";
import { Button } from "@/components/ui/button";
import { fieldControlStyles, FieldLabel } from "@/components/ui/field";

export function VenueAccessForm({ action }: { action: (state: VenueAccessActionState, formData: FormData) => Promise<VenueAccessActionState> }) {
  const [state, formAction, pending] = useActionState(action, {});
  return <form action={formAction} className="space-y-4"><div><FieldLabel htmlFor="organizer-slug">Organizer organization slug</FieldLabel><input id="organizer-slug" name="organizerSlug" className={`${fieldControlStyles} mt-2 font-mono`} placeholder="northstar-live" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required disabled={pending} /></div>{state.message ? <p className="rounded-2xl bg-red-50 p-4 text-sm text-red-800" role="alert">{state.message}</p> : null}<Button type="submit" disabled={pending}>{pending ? "Granting…" : "Grant venue access"}</Button></form>;
}
