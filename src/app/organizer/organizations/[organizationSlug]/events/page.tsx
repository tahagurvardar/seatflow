import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { EmptyState } from "@/components/ui/empty-state";
import { ROUTES } from "@/config/site";
import { hasMinimumMembershipRole } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";
import { requireOrganizerOrganizationAccess } from "@/lib/event-authorization";

export default async function OrganizerEventsPage({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}) {
  const { organizationSlug } = await params;
  const path = ROUTES.organizerEvents(organizationSlug);
  const { membership } = await requireOrganizerOrganizationAccess(
    organizationSlug,
    path,
  );
  const events = await getDatabase().event.findMany({
    where: { organizerOrganizationId: membership.organizationId },
    include: { _count: { select: { sessions: true } } },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
  });
  const canManage = hasMinimumMembershipRole(membership.role, "ADMIN");

  return (
    <section className="bg-slate-50 py-12 sm:py-16">
      <Container>
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <Badge className="bg-violet-50 text-violet-800 ring-violet-600/15">{membership.role} · ORGANIZER</Badge>
            <h1 className="mt-4 text-4xl font-black tracking-[-0.05em] text-slate-950">{membership.organization.name} events</h1>
            <p className="mt-2 text-slate-600">Persistent content, sessions, exact seat-map bindings, and section pricing.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href={ROUTES.organizerApprovedVenues(organizationSlug)} className={buttonStyles({ variant: "outline", size: "sm" })}>Approved venues</Link>
            {canManage ? <Link href={ROUTES.organizerNewEvent(organizationSlug)} className={buttonStyles({ size: "sm" })}>Create event</Link> : null}
          </div>
        </div>
        {events.length === 0 ? (
          <div className="mt-9"><EmptyState icon="calendar" title="No persistent events yet" description={canManage ? "Create a draft event, add and price a validated session, then publish it." : "An owner or administrator has not created an event yet."} action={canManage ? <Link href={ROUTES.organizerNewEvent(organizationSlug)} className={buttonStyles({ size: "sm" })}>Create event</Link> : undefined} /></div>
        ) : (
          <div className="mt-9 grid gap-4 lg:grid-cols-2">
            {events.map((event) => (
              <Link key={event.id} href={ROUTES.organizerEvent(organizationSlug, event.slug)} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm transition hover:border-orange-300 hover:shadow-lg">
                <div className="flex items-start justify-between gap-4"><div><h2 className="text-xl font-black text-slate-950">{event.title}</h2><p className="mt-1 font-mono text-xs text-slate-500">{event.slug}</p></div><Badge className="bg-slate-100 text-slate-700 ring-slate-500/15">{event.status}</Badge></div>
                <p className="mt-4 line-clamp-2 text-sm leading-6 text-slate-600">{event.shortDescription}</p>
                <p className="mt-5 text-xs font-bold uppercase tracking-wide text-slate-500">{event._count.sessions} {event._count.sessions === 1 ? "session" : "sessions"}</p>
              </Link>
            ))}
          </div>
        )}
      </Container>
    </section>
  );
}
