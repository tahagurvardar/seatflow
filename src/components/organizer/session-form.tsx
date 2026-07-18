"use client";

import { useActionState, useState } from "react";

import type { OrganizerActionState } from "@/app/organizer/actions";
import { Button } from "@/components/ui/button";
import { fieldControlStyles, FieldLabel } from "@/components/ui/field";

export interface SessionVenueOption {
  id: string;
  name: string;
  city: string;
  timeZone: string;
  spaces: Array<{
    id: string;
    name: string;
    seatMaps: Array<{ id: string; name: string; version: number }>;
  }>;
}

interface SessionDefaults {
  venueId?: string;
  spaceId?: string;
  seatMapId?: string;
  startLocal?: string;
  endLocal?: string;
  salesStartLocal?: string;
  salesEndLocal?: string;
}

interface SessionFormProps {
  action: (
    state: OrganizerActionState,
    formData: FormData,
  ) => Promise<OrganizerActionState>;
  venues: SessionVenueOption[];
  defaults?: SessionDefaults;
  submitLabel: string;
}

const initialState: OrganizerActionState = {};

export function SessionForm({
  action,
  venues,
  defaults = {},
  submitLabel,
}: SessionFormProps) {
  const initialVenue =
    venues.find((venue) => venue.id === defaults.venueId) ?? venues[0];
  const initialSpace =
    initialVenue?.spaces.find((space) => space.id === defaults.spaceId) ??
    initialVenue?.spaces[0];
  const initialMap =
    initialSpace?.seatMaps.find((seatMap) => seatMap.id === defaults.seatMapId) ??
    initialSpace?.seatMaps[0];
  const [venueId, setVenueId] = useState(initialVenue?.id ?? "");
  const [spaceId, setSpaceId] = useState(initialSpace?.id ?? "");
  const [seatMapId, setSeatMapId] = useState(initialMap?.id ?? "");
  const [state, formAction, pending] = useActionState(action, initialState);
  const venue = venues.find((candidate) => candidate.id === venueId);
  const spaces = venue?.spaces ?? [];
  const space = spaces.find((candidate) => candidate.id === spaceId);
  const seatMaps = space?.seatMaps ?? [];
  const error = (field: string) => state.fieldErrors?.[field];

  const changeVenue = (nextVenueId: string) => {
    const nextVenue = venues.find((candidate) => candidate.id === nextVenueId);
    const nextSpace = nextVenue?.spaces[0];
    setVenueId(nextVenueId);
    setSpaceId(nextSpace?.id ?? "");
    setSeatMapId(nextSpace?.seatMaps[0]?.id ?? "");
  };
  const changeSpace = (nextSpaceId: string) => {
    const nextSpace = spaces.find((candidate) => candidate.id === nextSpaceId);
    setSpaceId(nextSpaceId);
    setSeatMapId(nextSpace?.seatMaps[0]?.id ?? "");
  };

  if (venues.length === 0) {
    return (
      <p className="rounded-2xl bg-amber-50 p-5 text-sm leading-6 text-amber-900">
        No active approved venue has both an active space and a published seat map. Ask the venue operator for access or finish the venue configuration first.
      </p>
    );
  }

  return (
    <form action={formAction} className="grid gap-5 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <FieldLabel htmlFor="session-venue">Approved venue</FieldLabel>
        <select id="session-venue" name="venueId" value={venueId} onChange={(event) => changeVenue(event.target.value)} className={`${fieldControlStyles} mt-2`} disabled={pending}>
          {venues.map((option) => <option key={option.id} value={option.id}>{option.name} · {option.city}</option>)}
        </select>
        <p className="mt-2 text-xs text-slate-500">Times below are entered and displayed in {venue?.timeZone}.</p>
      </div>
      <div>
        <FieldLabel htmlFor="session-space">Active space</FieldLabel>
        <select id="session-space" name="spaceId" value={spaceId} onChange={(event) => changeSpace(event.target.value)} className={`${fieldControlStyles} mt-2`} disabled={pending}>
          {spaces.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
      </div>
      <div>
        <FieldLabel htmlFor="session-map">Exact published seat map</FieldLabel>
        <select id="session-map" name="seatMapId" value={seatMapId} onChange={(event) => setSeatMapId(event.target.value)} className={`${fieldControlStyles} mt-2`} disabled={pending}>
          {seatMaps.map((option) => <option key={option.id} value={option.id}>{option.name} · v{option.version}</option>)}
        </select>
      </div>
      {[
        { name: "startLocal", label: "Session start", value: defaults.startLocal },
        { name: "endLocal", label: "Session end", value: defaults.endLocal },
        { name: "salesStartLocal", label: "Sales start", value: defaults.salesStartLocal },
        { name: "salesEndLocal", label: "Sales end", value: defaults.salesEndLocal },
      ].map((field) => (
        <div key={field.name}>
          <FieldLabel htmlFor={`session-${field.name}`}>{field.label}</FieldLabel>
          <input id={`session-${field.name}`} name={field.name} type="datetime-local" defaultValue={field.value} className={`${fieldControlStyles} mt-2`} required disabled={pending} aria-invalid={Boolean(error(field.name))} />
          {error(field.name) ? <p className="mt-2 text-sm text-red-700">{error(field.name)}</p> : null}
        </div>
      ))}
      {state.message ? <p className="rounded-2xl bg-red-50 p-4 text-sm text-red-800 sm:col-span-2" role="alert">{state.message}</p> : null}
      <Button type="submit" size="lg" className="sm:col-span-2" disabled={pending || !seatMapId}>
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
