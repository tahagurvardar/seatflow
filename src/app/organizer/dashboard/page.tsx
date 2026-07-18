import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { ROUTES } from "@/config/site";
import {
  getUserMemberships,
  requireAuth,
  requireOrganizationMembership,
} from "@/lib/authorization";
import { getDatabase } from "@/lib/database";

export const metadata: Metadata = {
  title: "Organizer Dashboard",
  description: "Open an organizer workspace you are authorized to access.",
};

export default async function OrganizerDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ organization?: string | string[] }>;
}) {
  const [session, parameters] = await Promise.all([
    requireAuth(ROUTES.organizerDashboard),
    searchParams,
  ]);
  const organizerMemberships = (await getUserMemberships(session.user.id)).filter(
    (membership) => membership.organization.kind === "ORGANIZER",
  );

  if (organizerMemberships.length === 0) {
    redirect(ROUTES.organizerOnboarding);
  }

  const requestedSlug = Array.isArray(parameters.organization)
    ? parameters.organization[0]
    : parameters.organization;
  const selectedSlug = requestedSlug ?? organizerMemberships[0].organization.slug;
  const { membership: selectedMembership } =
    await requireOrganizationMembership({
      organizationSlug: selectedSlug,
      kind: "ORGANIZER",
      minimumRole: "MEMBER",
      redirectPath: `${ROUTES.organizerDashboard}?organization=${encodeURIComponent(selectedSlug)}`,
    });
  const organizationId = selectedMembership.organizationId;
  const [eventCount, draftEvents, publishedEvents, upcomingSessions, cancelledSessions, approvedVenues] = await Promise.all([
    getDatabase().event.count({ where: { organizerOrganizationId: organizationId } }),
    getDatabase().event.count({ where: { organizerOrganizationId: organizationId, status: "DRAFT" } }),
    getDatabase().event.count({ where: { organizerOrganizationId: organizationId, status: "PUBLISHED" } }),
    getDatabase().eventSession.count({ where: { event: { organizerOrganizationId: organizationId }, startAt: { gt: new Date() }, status: { not: "CANCELLED" } } }),
    getDatabase().eventSession.count({ where: { event: { organizerOrganizationId: organizationId }, status: "CANCELLED" } }),
    getDatabase().venueAccessGrant.count({ where: { organizerOrganizationId: organizationId, status: "ACTIVE", venue: { status: "ACTIVE" } } }),
  ]);

  return (
    <section className="bg-slate-50 py-14 sm:py-20">
      <Container>
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <Badge className="bg-violet-50 text-violet-800 ring-violet-600/15">
              ORGANIZER · {selectedMembership.role}
            </Badge>
            <h1 className="mt-4 text-4xl font-black tracking-[-0.05em] text-slate-950 sm:text-5xl">
              {selectedMembership.organization.name}
            </h1>
            <p className="mt-3 text-base text-slate-600">
              Tenant access is derived from your current membership, not a global
              organizer role.
            </p>
          </div>
          <Link
            href={ROUTES.organizerOnboarding}
            className={buttonStyles({ variant: "outline", size: "sm" })}
          >
            Create another organization
          </Link>
        </div>

        {organizerMemberships.length > 1 ? (
          <div className="mt-8 rounded-3xl border border-slate-200 bg-white p-5">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
              Switch organization
            </p>
            <nav aria-label="Organizer workspaces" className="mt-3 flex flex-wrap gap-2">
              {organizerMemberships.map((membership) => (
                <Link
                  key={membership.id}
                  href={`${ROUTES.organizerDashboard}?organization=${encodeURIComponent(membership.organization.slug)}`}
                  aria-current={
                    membership.organization.id ===
                    selectedMembership.organization.id
                      ? "page"
                      : undefined
                  }
                  className={buttonStyles({
                    variant:
                      membership.organization.id ===
                      selectedMembership.organization.id
                        ? "secondary"
                        : "outline",
                    size: "sm",
                  })}
                >
                  {membership.organization.name}
                </Link>
              ))}
            </nav>
          </div>
        ) : null}

        <dl className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{[["Events", eventCount], ["Draft events", draftEvents], ["Published events", publishedEvents], ["Upcoming sessions", upcomingSessions], ["Cancelled sessions", cancelledSessions], ["Approved venues", approvedVenues]].map(([label, value]) => <div key={label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><dt className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</dt><dd className="mt-2 font-mono text-3xl font-black text-slate-950">{value}</dd></div>)}</dl>
        <div className="mt-6 flex flex-wrap gap-3 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><Link href={ROUTES.organizerEvents(selectedMembership.organization.slug)} className={buttonStyles()}>Manage events</Link><Link href={ROUTES.organizerApprovedVenues(selectedMembership.organization.slug)} className={buttonStyles({ variant: "outline" })}>Review approved venues</Link><p className="basis-full text-sm text-slate-600">Booking, ticket sales, and revenue metrics are intentionally unavailable in Phase 3.</p></div>
      </Container>
    </section>
  );
}
