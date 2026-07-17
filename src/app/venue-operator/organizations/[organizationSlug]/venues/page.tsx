import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { EmptyState } from "@/components/ui/empty-state";
import { ROUTES } from "@/config/site";
import { hasMinimumMembershipRole } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";
import { requireVenueOperatorOrganizationAccess } from "@/lib/venue-authorization";

export default async function VenuesPage({ params }: { params: Promise<{ organizationSlug: string }> }) {
  const { organizationSlug } = await params;
  const path = ROUTES.venueOperatorVenues(organizationSlug);
  const { membership } = await requireVenueOperatorOrganizationAccess(organizationSlug, path);
  const venues = await getDatabase().venue.findMany({
    where: { organizationId: membership.organizationId },
    include: { _count: { select: { spaces: true } } },
    orderBy: [{ status: "asc" }, { name: "asc" }],
  });
  const canManage = hasMinimumMembershipRole(membership.role, "ADMIN");

  return (
    <section className="bg-slate-50 py-12 sm:py-16">
      <Container>
        <nav aria-label="Breadcrumb" className="text-sm text-slate-500"><Link href={ROUTES.venueOperatorDashboard} className="hover:text-slate-950">Venue workspaces</Link> / Venues</nav>
        <div className="mt-5 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div><Badge className="bg-sky-50 text-sky-800 ring-sky-600/15">{membership.role} · VENUE OPERATOR</Badge><h1 className="mt-4 text-4xl font-black tracking-[-0.05em] text-slate-950">{membership.organization.name}</h1><p className="mt-2 text-slate-600">Venues, spaces, and versioned layouts in one tenant boundary.</p></div>
          {canManage ? <Link href={ROUTES.venueOperatorNewVenue(organizationSlug)} className={buttonStyles()}>Add venue</Link> : <Badge className="bg-amber-50 text-amber-800 ring-amber-600/15">Read-only member</Badge>}
        </div>
        {venues.length === 0 ? (
          <div className="mt-9"><EmptyState icon="map-pin" title="No venues yet" description={canManage ? "Create the first venue, then add spaces and seat-map versions." : "An owner or administrator has not added a venue yet."} action={canManage ? <Link href={ROUTES.venueOperatorNewVenue(organizationSlug)} className={buttonStyles({ size: "sm" })}>Create venue</Link> : undefined} /></div>
        ) : (
          <div className="mt-9 grid gap-4 lg:grid-cols-2">
            {venues.map((venue) => (
              <Link key={venue.id} href={ROUTES.venueOperatorVenue(organizationSlug, venue.slug)} className="group rounded-3xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-lg">
                <div className="flex items-start justify-between gap-4"><div><h2 className="text-xl font-black text-slate-950 group-hover:text-orange-600">{venue.name}</h2><p className="mt-1 text-sm text-slate-500">{venue.city}, {venue.countryCode}</p></div><Badge className={venue.status === "ARCHIVED" ? "bg-slate-100 text-slate-600 ring-slate-500/15" : venue.status === "ACTIVE" ? "bg-emerald-50 text-emerald-800 ring-emerald-600/15" : "bg-amber-50 text-amber-800 ring-amber-600/15"}>{venue.status}</Badge></div>
                <p className="mt-6 text-sm font-semibold text-slate-600">{venue._count.spaces} {venue._count.spaces === 1 ? "space" : "spaces"}</p>
              </Link>
            ))}
          </div>
        )}
      </Container>
    </section>
  );
}
