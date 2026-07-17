import Link from "next/link";

import { archiveVenueAction, restoreVenueAction } from "@/app/venue-operator/actions";
import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { EmptyState } from "@/components/ui/empty-state";
import { ROUTES } from "@/config/site";
import { hasMinimumMembershipRole } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";
import { requireVenueAccess } from "@/lib/venue-authorization";

export default async function VenuePage({ params, searchParams }: { params: Promise<{ organizationSlug: string; venueSlug: string }>; searchParams: Promise<{ error?: string; success?: string }> }) {
  const scope = await params;
  const notices = await searchParams;
  const path = ROUTES.venueOperatorVenue(scope.organizationSlug, scope.venueSlug);
  const { membership, venue } = await requireVenueAccess(scope, path);
  const spaces = await getDatabase().space.findMany({
    where: { venueId: venue.id },
    include: { _count: { select: { seatMaps: true } } },
    orderBy: [{ status: "asc" }, { name: "asc" }],
  });
  const canManage = hasMinimumMembershipRole(membership.role, "ADMIN");
  const actionScope = { organizationSlug: scope.organizationSlug, venueSlug: scope.venueSlug };

  return (
    <section className="bg-slate-50 py-12 sm:py-16"><Container>
      <nav aria-label="Breadcrumb" className="text-sm text-slate-500"><Link href={ROUTES.venueOperatorVenues(scope.organizationSlug)} className="hover:text-slate-950">Venues</Link> / {venue.name}</nav>
      {notices.error ? <p className="mt-5 rounded-2xl bg-red-50 p-4 text-sm text-red-800" role="alert">{notices.error}</p> : null}
      {notices.success ? <p className="mt-5 rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-800">Venue {notices.success}.</p> : null}
      <div className="mt-6 rounded-[2rem] bg-slate-950 p-7 text-white sm:p-10">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between"><div><Badge className={venue.status === "ARCHIVED" ? "bg-white/10 text-slate-200 ring-white/15" : "bg-emerald-500/15 text-emerald-200 ring-emerald-400/20"}>{venue.status}</Badge><h1 className="mt-4 text-4xl font-black tracking-[-0.05em] sm:text-5xl">{venue.name}</h1><p className="mt-3 text-slate-300">{venue.addressLine1}, {venue.city} · {venue.timeZone}</p></div>{canManage ? <div className="flex flex-wrap gap-2">{venue.status !== "ARCHIVED" ? <><Link href={ROUTES.venueOperatorVenueEdit(scope.organizationSlug, scope.venueSlug)} className={buttonStyles({ variant: "outline", size: "sm", className: "border-white/20 bg-white/5 text-white hover:border-white hover:bg-white/10" })}>Edit venue</Link><Link href={ROUTES.venueOperatorNewSpace(scope.organizationSlug, scope.venueSlug)} className={buttonStyles({ size: "sm" })}>Add space</Link></> : null}</div> : null}</div>
      </div>
      <div className="mt-8 grid gap-6 lg:grid-cols-[1.4fr_0.6fr]">
        <div>
          <div className="flex items-center justify-between"><h2 className="text-2xl font-black text-slate-950">Spaces</h2><span className="text-sm text-slate-500">{spaces.length} total</span></div>
          {spaces.length === 0 ? <div className="mt-4"><EmptyState icon="ticket" title="No spaces yet" description="Add an auditorium, hall, arena, cinema, or other bookable space." action={canManage && venue.status !== "ARCHIVED" ? <Link href={ROUTES.venueOperatorNewSpace(scope.organizationSlug, scope.venueSlug)} className={buttonStyles({ size: "sm" })}>Add space</Link> : undefined} /></div> : <div className="mt-4 grid gap-3">{spaces.map((space) => <Link key={space.id} href={ROUTES.venueOperatorSpace(scope.organizationSlug, scope.venueSlug, space.slug)} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-orange-300"><div className="flex items-center justify-between gap-4"><div><h3 className="font-black text-slate-950">{space.name}</h3><p className="mt-1 text-xs text-slate-500">{space.type.replaceAll("_", " ")} · {space._count.seatMaps} versions</p></div><Badge className="bg-slate-100 text-slate-700 ring-slate-500/10">{space.status}</Badge></div></Link>)}</div>}
        </div>
        <aside className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><h2 className="font-black text-slate-950">Venue lifecycle</h2><p className="mt-2 text-sm leading-6 text-slate-600">Archiving removes the venue from active operations without deleting spaces or historical layouts.</p>{canManage ? venue.status === "ARCHIVED" ? <form action={restoreVenueAction.bind(null, actionScope)} className="mt-5"><button className={buttonStyles({ variant: "secondary", size: "sm" })} type="submit">Restore venue</button></form> : <form action={archiveVenueAction.bind(null, actionScope)} className="mt-5 space-y-3"><label className="flex items-start gap-2 text-xs text-slate-600"><input type="checkbox" name="confirmation" value="archive" required className="mt-0.5" />I understand this venue will become read-only until restored.</label><button className={buttonStyles({ variant: "outline", size: "sm" })} type="submit">Archive venue</button></form> : <p className="mt-5 text-xs font-semibold text-amber-700">Read-only MEMBER access</p>}</aside>
      </div>
    </Container></section>
  );
}
