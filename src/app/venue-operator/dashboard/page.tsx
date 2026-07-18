import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { ROUTES } from "@/config/site";
import { getUserMemberships, requireAuth } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";

export const metadata: Metadata = {
  title: "Venue Operator Dashboard",
  description: "Choose a venue-operator workspace.",
};

export default async function VenueOperatorDashboardPage() {
  const session = await requireAuth(ROUTES.venueOperatorDashboard);
  const memberships = (await getUserMemberships(session.user.id)).filter(
    (membership) => membership.organization.kind === "VENUE_OPERATOR",
  );

  if (memberships.length === 0) redirect(ROUTES.venueOperatorOnboarding);
  const organizationIds = memberships.map((membership) => membership.organizationId);
  const [activeGrants, organizerCount, upcomingSessions] = await Promise.all([
    getDatabase().venueAccessGrant.count({ where: { operatorOrganizationId: { in: organizationIds }, status: "ACTIVE" } }),
    getDatabase().venueAccessGrant.findMany({ where: { operatorOrganizationId: { in: organizationIds }, status: "ACTIVE" }, distinct: ["organizerOrganizationId"], select: { organizerOrganizationId: true } }),
    getDatabase().eventSession.count({ where: { venue: { organizationId: { in: organizationIds } }, startAt: { gt: new Date() }, status: { in: ["SCHEDULED", "ON_SALE", "SALES_PAUSED"] } } }),
  ]);

  return (
    <section className="bg-slate-50 py-14 sm:py-20">
      <Container>
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <Badge className="bg-sky-50 text-sky-800 ring-sky-600/15">VENUE OPERATOR</Badge>
            <h1 className="mt-4 text-4xl font-black tracking-[-0.05em] text-slate-950 sm:text-5xl">Your venue workspaces</h1>
            <p className="mt-3 text-slate-600">Choose an organization. Every destination rechecks your membership on the server.</p>
          </div>
          <Link href={ROUTES.venueOperatorOnboarding} className={buttonStyles({ variant: "outline", size: "sm" })}>Create organization</Link>
        </div>
        <dl className="mt-8 grid gap-3 sm:grid-cols-3">{[["Active venue grants", activeGrants], ["Authorized organizers", organizerCount.length], ["Upcoming configured sessions", upcomingSessions]].map(([label, value]) => <div key={label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><dt className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</dt><dd className="mt-2 font-mono text-3xl font-black text-slate-950">{value}</dd></div>)}</dl>
        <p className="mt-4 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900">Booking and revenue data do not exist in Phase 4A. Venue operators can see configured session timing but cannot edit organizer event content.</p>
        <div className="mt-9 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {memberships.map((membership) => (
            <article key={membership.id} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <Badge className="bg-slate-100 text-slate-700 ring-slate-500/10">{membership.role}</Badge>
              <h2 className="mt-4 text-xl font-black text-slate-950">{membership.organization.name}</h2>
              <p className="mt-2 font-mono text-xs text-slate-500">{membership.organization.slug}</p>
              <Link href={ROUTES.venueOperatorVenues(membership.organization.slug)} className={buttonStyles({ variant: "secondary", size: "sm", className: "mt-6" })}>Manage venues</Link>
            </article>
          ))}
        </div>
      </Container>
    </section>
  );
}
