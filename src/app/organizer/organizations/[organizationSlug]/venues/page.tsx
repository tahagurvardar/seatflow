import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Container } from "@/components/ui/container";
import { EmptyState } from "@/components/ui/empty-state";
import { ROUTES } from "@/config/site";
import { requireOrganizerOrganizationAccess } from "@/lib/event-authorization";
import { getDatabase } from "@/lib/database";
import { listApprovedVenuesForOrganizer } from "@/server/venue-access/venue-access-service";

export default async function ApprovedVenuesPage({ params }: { params: Promise<{ organizationSlug: string }> }) {
  const { organizationSlug } = await params;
  const path = ROUTES.organizerApprovedVenues(organizationSlug);
  const { session, membership } = await requireOrganizerOrganizationAccess(organizationSlug, path);
  const grants = await listApprovedVenuesForOrganizer(getDatabase(), { userId: session.user.id, organizationSlug });
  return <section className="bg-slate-50 py-12 sm:py-16"><Container><Link href={ROUTES.organizerEvents(organizationSlug)} className="text-sm font-semibold text-slate-600 hover:text-slate-950">← Back to events</Link><Badge className="mt-6 bg-violet-50 text-violet-800 ring-violet-600/15">{membership.organization.name}</Badge><h1 className="mt-4 text-4xl font-black tracking-[-0.05em] text-slate-950">Approved venues</h1><p className="mt-3 text-slate-600">Only published seat-map metadata needed for session creation is exposed. Operator drafts remain private.</p>{grants.length === 0 ? <div className="mt-9"><EmptyState icon="map-pin" title="No venue access grants" description="A venue-operator owner or administrator must grant this organizer access before sessions can be created." /></div> : <div className="mt-9 grid gap-4 lg:grid-cols-2">{grants.map((grant) => <article key={grant.id} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex items-start justify-between gap-4"><div><h2 className="text-xl font-black text-slate-950">{grant.venue.name}</h2><p className="mt-1 text-sm text-slate-600">{grant.venue.city}, {grant.venue.countryCode} · {grant.venue.timeZone}</p></div><Badge className={grant.status === "ACTIVE" && grant.venue.status === "ACTIVE" ? "bg-emerald-50 text-emerald-800 ring-emerald-600/15" : "bg-slate-100 text-slate-600 ring-slate-500/15"}>{grant.status === "ACTIVE" ? grant.venue.status : "REVOKED"}</Badge></div><div className="mt-5 space-y-2">{grant.venue.spaces.length > 0 ? grant.venue.spaces.map((space) => <div key={space.id} className="rounded-2xl bg-slate-50 p-4"><p className="font-bold text-slate-950">{space.name}</p><p className="mt-1 text-xs text-slate-500">{space.seatMaps.length > 0 ? space.seatMaps.map((map) => `${map.name} v${map.version}`).join(", ") : "No current published map"}</p></div>) : <p className="text-sm text-slate-600">No active spaces are currently available.</p>}</div></article>)}</div>}</Container></section>;
}
