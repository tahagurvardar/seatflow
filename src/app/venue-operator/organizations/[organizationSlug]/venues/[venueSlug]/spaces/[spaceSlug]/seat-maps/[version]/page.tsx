import Link from "next/link";
import { notFound } from "next/navigation";

import {
  cloneSeatMapAction,
  publishSeatMapAction,
  seatMapEditorAction,
  type MapScope,
} from "@/app/venue-operator/actions";
import { BulkRowGenerator } from "@/components/seat-maps/bulk-row-generator";
import { SeatEditor } from "@/components/seat-maps/seat-editor";
import { SeatMapRenderer } from "@/components/seat-maps/seat-map-renderer";
import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { fieldControlStyles, FieldLabel } from "@/components/ui/field";
import { ROUTES } from "@/config/site";
import { calculateSeatMapCapacity } from "@/features/seat-maps/capacity";
import {
  canCloneSeatMap,
  canEditSeatMap,
} from "@/features/seat-maps/lifecycle";
import { validateSeatMapForPublication } from "@/features/seat-maps/publication-validation";
import { hasMinimumMembershipRole } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";
import { requireSeatMapAccess } from "@/lib/venue-authorization";
import { seatMapGraphInclude } from "@/server/seat-maps/seat-map-service";

interface MapPageParams {
  organizationSlug: string;
  venueSlug: string;
  spaceSlug: string;
  version: string;
}

export default async function SeatMapPage({ params, searchParams }: { params: Promise<MapPageParams>; searchParams: Promise<{ error?: string; success?: string }> }) {
  const route = await params;
  const notices = await searchParams;
  const version = Number(route.version);
  if (!Number.isInteger(version) || version < 1) notFound();
  const path = ROUTES.venueOperatorSeatMap(route.organizationSlug, route.venueSlug, route.spaceSlug, version);
  const { membership, seatMap: authorizedMap } = await requireSeatMapAccess({ ...route, version }, path);
  const seatMap = await getDatabase().seatMap.findUnique({
    where: { id: authorizedMap.id },
    include: { ...seatMapGraphInclude, space: { include: { venue: true } } },
  });
  if (!seatMap) notFound();

  const capacity = calculateSeatMapCapacity(seatMap);
  const readinessIssues = validateSeatMapForPublication(seatMap);
  const canManage = hasMinimumMembershipRole(membership.role, "ADMIN");
  const lifecycle = {
    seatMapStatus: seatMap.status,
    spaceStatus: seatMap.space.status,
    venueStatus: seatMap.space.venue.status,
  } as const;
  const editable = canManage && canEditSeatMap(lifecycle);
  const cloneable = canManage && canCloneSeatMap(lifecycle);
  const actionScope: MapScope = {
    organizationSlug: route.organizationSlug,
    venueSlug: route.venueSlug,
    spaceSlug: route.spaceSlug,
    seatMapId: seatMap.id,
    version,
  };
  const editorAction = seatMapEditorAction.bind(null, actionScope);

  return (
    <section className="bg-slate-50 py-10 sm:py-14">
      <Container className="max-w-[96rem]">
        <nav aria-label="Breadcrumb" className="text-sm text-slate-500"><Link href={ROUTES.venueOperatorSpace(route.organizationSlug, route.venueSlug, route.spaceSlug)} className="hover:text-slate-950">{seatMap.space.name}</Link> / Seat maps / v{version}</nav>
        {notices.error ? <p className="mt-5 rounded-2xl bg-red-50 p-4 text-sm text-red-800" role="alert">{notices.error}</p> : null}
        {notices.success ? <p className="mt-5 rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-800">Change completed: {notices.success}.</p> : null}

        <header className="mt-6 rounded-[2rem] bg-slate-950 p-7 text-white sm:p-9">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div><div className="flex flex-wrap gap-2"><Badge className={seatMap.status === "PUBLISHED" ? "bg-emerald-500/15 text-emerald-200 ring-emerald-400/20" : seatMap.status === "DRAFT" ? "bg-amber-500/15 text-amber-200 ring-amber-400/20" : "bg-white/10 text-slate-200 ring-white/15"}>{seatMap.status}</Badge><Badge className="bg-white/10 text-slate-200 ring-white/15">VERSION {seatMap.version}</Badge>{!canManage ? <Badge className="bg-sky-500/15 text-sky-200 ring-sky-400/20">READ ONLY</Badge> : null}</div><h1 className="mt-4 text-4xl font-black tracking-[-0.05em] sm:text-5xl">{seatMap.name}</h1><p className="mt-3 text-slate-300">{seatMap.space.venue.name} · {seatMap.space.name}{seatMap.sourceSeatMapId ? " · cloned from a published version" : ""}</p></div>
            {cloneable ? <form action={cloneSeatMapAction.bind(null, actionScope)}><button type="submit" className={buttonStyles({ size: "sm" })}>Clone to next draft</button></form> : null}
          </div>
        </header>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[{ label: "Physical capacity", value: capacity.total }, { label: "Sellable", value: capacity.sellable }, { label: "Blocked", value: capacity.blocked }, { label: "Sections", value: seatMap.sections.length }].map((metric) => <div key={metric.label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">{metric.label}</p><p className="mt-2 font-mono text-3xl font-black text-slate-950">{metric.value}</p></div>)}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Object.entries(capacity.byType).map(([type, counts]) => <div key={type} className="rounded-2xl bg-white px-4 py-3 text-sm ring-1 ring-slate-200"><span className="font-bold text-slate-950">{type}</span><span className="float-right font-mono text-slate-500">{counts.sellable}/{counts.total}</span></div>)}
        </div>

        {editable ? (
          <div className="mt-8 grid gap-7 xl:grid-cols-[1fr_22rem]">
            <div className="min-w-0 space-y-7">
              <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="text-xl font-black text-slate-950">Draft identity</h2>
                <form action={editorAction} className="mt-4 flex flex-col gap-3 sm:flex-row">
                  <input type="hidden" name="intent" value="update-map" />
                  <div className="flex-1"><FieldLabel htmlFor="map-name">Map name</FieldLabel><input id="map-name" name="name" defaultValue={seatMap.name} className={`${fieldControlStyles} mt-1`} required /></div>
                  <button type="submit" className={buttonStyles({ size: "sm", className: "self-end" })}>Save name</button>
                </form>
              </section>

              <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="text-xl font-black text-slate-950">Add section</h2>
                <form action={editorAction} className="mt-4 grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
                  <input type="hidden" name="intent" value="create-section" />
                  <div><FieldLabel htmlFor="new-section-name">Name</FieldLabel><input id="new-section-name" name="name" className={`${fieldControlStyles} mt-1`} placeholder="Orchestra" required /></div>
                  <div><FieldLabel htmlFor="new-section-code">Code</FieldLabel><input id="new-section-code" name="code" className={`${fieldControlStyles} mt-1 uppercase`} placeholder="ORCH" required /></div>
                  <button type="submit" className={buttonStyles({ size: "sm" })}>Add section</button>
                </form>
              </section>

              {seatMap.sections.map((section, sectionIndex) => (
                <details key={section.id} open className="rounded-3xl border border-slate-200 bg-white shadow-sm">
                  <summary className="cursor-pointer list-none p-6 text-lg font-black text-slate-950 [&::-webkit-details-marker]:hidden"><span className="flex items-center justify-between gap-4"><span>{section.name} <span className="font-mono text-sm text-slate-400">{section.code}</span></span><span className="text-xs font-semibold text-slate-500">{section.rows.length} rows</span></span></summary>
                  <div className="border-t border-slate-100 p-6 pt-5">
                    <div className="grid gap-3 lg:grid-cols-[1fr_11rem_auto] lg:items-end">
                      <form action={editorAction} className="contents"><input type="hidden" name="intent" value="update-section" /><input type="hidden" name="sectionId" value={section.id} /><div><FieldLabel htmlFor={`section-name-${section.id}`}>Section name</FieldLabel><input id={`section-name-${section.id}`} name="name" defaultValue={section.name} className={`${fieldControlStyles} mt-1`} required /></div><div><FieldLabel htmlFor={`section-code-${section.id}`}>Code</FieldLabel><input id={`section-code-${section.id}`} name="code" defaultValue={section.code} className={`${fieldControlStyles} mt-1 uppercase`} required /></div><button type="submit" className={buttonStyles({ variant: "outline", size: "sm" })}>Save section</button></form>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {sectionIndex > 0 ? <form action={editorAction}><input type="hidden" name="intent" value="move-section" /><input type="hidden" name="sectionId" value={section.id} /><button type="submit" name="direction" value="up" className={buttonStyles({ variant: "ghost", size: "sm" })}>Move up</button></form> : null}
                      {sectionIndex < seatMap.sections.length - 1 ? <form action={editorAction}><input type="hidden" name="intent" value="move-section" /><input type="hidden" name="sectionId" value={section.id} /><button type="submit" name="direction" value="down" className={buttonStyles({ variant: "ghost", size: "sm" })}>Move down</button></form> : null}
                      <form action={editorAction} className="flex items-center gap-2"><input type="hidden" name="intent" value="delete-section" /><input type="hidden" name="sectionId" value={section.id} /><label className="flex items-center gap-1.5 text-xs text-slate-500"><input type="checkbox" name="confirmation" value="delete" required />Confirm delete</label><button type="submit" className={buttonStyles({ variant: "ghost", size: "sm", className: "text-red-700" })}>Delete section</button></form>
                    </div>

                    <div className="mt-6 rounded-2xl bg-slate-50 p-4">
                      <form action={editorAction} className="flex flex-col gap-3 sm:flex-row sm:items-end"><input type="hidden" name="intent" value="create-row" /><input type="hidden" name="sectionId" value={section.id} /><div className="flex-1"><FieldLabel htmlFor={`new-row-${section.id}`}>Add one row</FieldLabel><input id={`new-row-${section.id}`} name="label" className={`${fieldControlStyles} mt-1 uppercase`} placeholder="A" required /></div><button type="submit" className={buttonStyles({ variant: "secondary", size: "sm" })}>Add row</button></form>
                    </div>
                    <div className="mt-4"><BulkRowGenerator action={editorAction} sectionId={section.id} /></div>

                    <div className="mt-5 space-y-3">
                      {section.rows.map((row, rowIndex) => {
                        const lastX = Math.max(-40, ...row.seats.map((seat) => seat.x));
                        const nextX = Math.min(10_000, lastX + 40);
                        const rowY = row.seats[0]?.y ?? Math.min(10_000, row.displayOrder * 40);
                        return <article key={row.id} className="rounded-2xl border border-slate-200 p-4">
                          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between"><form action={editorAction} className="flex items-end gap-2"><input type="hidden" name="intent" value="update-row" /><input type="hidden" name="sectionId" value={section.id} /><input type="hidden" name="rowId" value={row.id} /><div><FieldLabel htmlFor={`row-label-${row.id}`}>Row label</FieldLabel><input id={`row-label-${row.id}`} name="label" defaultValue={row.label} className={`${fieldControlStyles} mt-1 w-28 uppercase`} required /></div><button type="submit" className={buttonStyles({ variant: "outline", size: "sm" })}>Save</button></form><div className="flex flex-wrap gap-1">{rowIndex > 0 ? <form action={editorAction}><input type="hidden" name="intent" value="move-row" /><input type="hidden" name="sectionId" value={section.id} /><input type="hidden" name="rowId" value={row.id} /><button type="submit" name="direction" value="up" className={buttonStyles({ variant: "ghost", size: "sm" })}>Up</button></form> : null}{rowIndex < section.rows.length - 1 ? <form action={editorAction}><input type="hidden" name="intent" value="move-row" /><input type="hidden" name="sectionId" value={section.id} /><input type="hidden" name="rowId" value={row.id} /><button type="submit" name="direction" value="down" className={buttonStyles({ variant: "ghost", size: "sm" })}>Down</button></form> : null}<form action={editorAction} className="flex items-center gap-2"><input type="hidden" name="intent" value="delete-row" /><input type="hidden" name="sectionId" value={section.id} /><input type="hidden" name="rowId" value={row.id} /><label className="flex items-center gap-1 text-xs text-slate-500"><input type="checkbox" name="confirmation" value="delete" required />Confirm</label><button type="submit" className={buttonStyles({ variant: "ghost", size: "sm", className: "text-red-700" })}>Delete row</button></form></div></div>
                          <form action={editorAction} className="mt-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-6 lg:items-end"><input type="hidden" name="intent" value="create-seat" /><input type="hidden" name="sectionId" value={section.id} /><input type="hidden" name="rowId" value={row.id} /><div><FieldLabel htmlFor={`new-seat-label-${row.id}`}>Seat label</FieldLabel><input id={`new-seat-label-${row.id}`} name="label" defaultValue={String(row.seats.length + 1)} className={`${fieldControlStyles} mt-1`} required /></div><div><FieldLabel htmlFor={`new-seat-x-${row.id}`}>X</FieldLabel><input id={`new-seat-x-${row.id}`} name="x" type="number" defaultValue={nextX} min={0} max={10000} className={`${fieldControlStyles} mt-1`} required /></div><div><FieldLabel htmlFor={`new-seat-y-${row.id}`}>Y</FieldLabel><input id={`new-seat-y-${row.id}`} name="y" type="number" defaultValue={rowY} min={0} max={10000} className={`${fieldControlStyles} mt-1`} required /></div><div><FieldLabel htmlFor={`new-seat-type-${row.id}`}>Type</FieldLabel><select id={`new-seat-type-${row.id}`} name="type" className={`${fieldControlStyles} mt-1`}><option value="STANDARD">Standard</option><option value="ACCESSIBLE">Accessible</option><option value="COMPANION">Companion</option><option value="PREMIUM">Premium</option></select></div><div><FieldLabel htmlFor={`new-seat-state-${row.id}`}>State</FieldLabel><select id={`new-seat-state-${row.id}`} name="state" className={`${fieldControlStyles} mt-1`}><option value="ACTIVE">Active</option><option value="BLOCKED">Blocked</option></select></div><button type="submit" className={buttonStyles({ variant: "secondary", size: "sm" })}>Add seat</button></form>
                        </article>;
                      })}
                    </div>
                  </div>
                </details>
              ))}

              <section><div className="mb-4"><h2 className="text-2xl font-black text-slate-950">Visual seat editor</h2><p className="mt-1 text-sm text-slate-600">Select a seat to update its label, type, state, or coordinates.</p></div><SeatEditor action={editorAction} sections={seatMap.sections} /></section>
            </div>

            <aside className="min-w-0 space-y-5 xl:sticky xl:top-24 xl:self-start">
              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><h2 className="font-black text-slate-950">Publication readiness</h2>{readinessIssues.length === 0 ? <p className="mt-3 rounded-2xl bg-emerald-50 p-3 text-sm text-emerald-800">This draft passes structural validation.</p> : <ul className="mt-3 space-y-2 text-sm text-amber-800">{readinessIssues.map((issue) => <li key={issue} className="rounded-xl bg-amber-50 p-3">{issue}</li>)}</ul>}<form action={publishSeatMapAction.bind(null, actionScope)} className="mt-5 space-y-3"><label className="flex items-start gap-2 text-xs leading-5 text-slate-600"><input type="checkbox" name="confirmation" value="publish" required className="mt-1" />Publish this immutable version and archive the current published map.</label><button type="submit" className={buttonStyles({ className: "w-full" })} disabled={readinessIssues.length > 0}>Publish seat map</button></form></div>
              <div className="rounded-3xl bg-slate-950 p-6 text-sm text-slate-300"><h2 className="font-black text-white">Editor limits</h2><ul className="mt-3 space-y-2"><li>20 sections per map</li><li>60 rows per section</li><li>80 seats per row</li><li>3,000 seats per map</li><li>Coordinates from 0 to 10,000</li></ul></div>
            </aside>
          </div>
        ) : (
          <div className="mt-8">
            <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="text-2xl font-black text-slate-950">Read-only layout preview</h2><p className="mt-1 text-sm text-slate-600">{seatMap.status === "DRAFT" ? canManage ? "Restore the archived venue and space before editing this draft." : "Your MEMBER role can inspect this draft but cannot change it." : "Published and archived versions are immutable."}</p></div>{seatMap.publishedAt ? <p className="text-xs text-slate-500">Published {seatMap.publishedAt.toLocaleString("en-GB")}</p> : null}</div>
            {seatMap.sections.length > 0 ? <SeatMapRenderer sections={seatMap.sections} /> : <p className="rounded-3xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-600">This draft does not contain a layout yet.</p>}
          </div>
        )}
      </Container>
    </section>
  );
}
