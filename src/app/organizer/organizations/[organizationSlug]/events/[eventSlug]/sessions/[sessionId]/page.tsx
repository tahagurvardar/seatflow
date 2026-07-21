import Link from "next/link";

import { sessionLifecycleAction } from "@/app/organizer/actions";
import { RealtimeOrganizerInventory } from "@/components/holds/realtime-organizer-inventory";
import { PricingSummary } from "@/components/organizer/pricing-summary";
import { OrganizerBookingSummary } from "@/components/bookings/organizer-booking-summary";
import { OrganizerTicketSummary } from "@/components/tickets/organizer-ticket-summary";
import { SeatMapRenderer } from "@/components/seat-maps/seat-map-renderer";
import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { ROUTES } from "@/config/site";
import { getServerEnvironment } from "@/env/server";
import { formatVenueDateTime } from "@/features/events/date-time";
import { realtimeUrlForClient } from "@/features/inventory-events/realtime-endpoint";
import { createRealtimeRoomTicket } from "@/features/inventory-events/room-ticket";
import { hasMinimumMembershipRole } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";
import { requireEventSessionAccess } from "@/lib/event-authorization";
import { getSessionPublicationReadiness } from "@/server/events/event-session-service";
import { getSessionInventorySummary } from "@/server/holds/hold-queries";
import { getOrganizerBookingSummary } from "@/server/payments/booking-queries";
import { getOrganizerTicketSummary } from "@/server/tickets/ticket-queries";

export default async function OrganizerSessionPage({ params, searchParams }: { params: Promise<{ organizationSlug: string; eventSlug: string; sessionId: string }>; searchParams: Promise<{ error?: string; success?: string }> }) {
  const scope = await params;
  const notices = await searchParams;
  const path = ROUTES.organizerSession(scope.organizationSlug, scope.eventSlug, scope.sessionId);
  const { session: authSession, membership, event } = await requireEventSessionAccess(scope, path);
  const { eventSession, coverage, issues } = await getSessionPublicationReadiness(getDatabase(), scope.sessionId);
  const inventorySummary = await getSessionInventorySummary(getDatabase(), scope.sessionId);
  const bookingSummary = await getOrganizerBookingSummary(getDatabase(), {
    userId: authSession.user.id,
    ...scope,
  });
  const ticketSummary = await getOrganizerTicketSummary(getDatabase(), {
    userId: authSession.user.id,
    ...scope,
  });
  const canManage = hasMinimumMembershipRole(membership.role, "ADMIN") && ["DRAFT", "PUBLISHED"].includes(event.status);
  const canScan = hasMinimumMembershipRole(membership.role, "ADMIN");
  const action = sessionLifecycleAction.bind(null, scope);
  const realtimeTicket = createRealtimeRoomTicket({ sessionId: scope.sessionId, secret: getServerEnvironment().BETTER_AUTH_SECRET });
  const realtimeUrl = realtimeUrlForClient(process.env, { hosted: process.env.NODE_ENV === "production" });

  return <section className="bg-slate-50 py-12 sm:py-16"><Container className="max-w-[96rem]">
    <nav className="text-sm text-slate-500"><Link href={ROUTES.organizerEvent(scope.organizationSlug, scope.eventSlug)} className="hover:text-slate-950">{event.title}</Link> / Session</nav>
    {notices.error ? <p className="mt-5 rounded-2xl bg-red-50 p-4 text-sm text-red-800" role="alert">{notices.error}</p> : null}
    {notices.success ? <p className="mt-5 rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-800">Session transition completed: {notices.success}.</p> : null}
    <header className="mt-6 rounded-[2rem] bg-slate-950 p-7 text-white sm:p-9"><div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between"><div><div className="flex flex-wrap gap-2"><Badge className="bg-white/10 text-slate-200 ring-white/15">{eventSession.status}</Badge><Badge className="bg-emerald-500/15 text-emerald-200 ring-emerald-400/20">MAP V{eventSession.seatMap.version}</Badge>{!canManage ? <Badge className="bg-sky-500/15 text-sky-200 ring-sky-400/20">READ ONLY</Badge> : null}</div><h1 className="mt-4 text-3xl font-black tracking-[-0.04em] sm:text-4xl">{formatVenueDateTime(eventSession.startAt, eventSession.venue.timeZone)}</h1><p className="mt-3 text-slate-300">{eventSession.venue.name} · {eventSession.space.name} · {eventSession.venue.city}</p></div>{canManage && eventSession.status === "DRAFT" ? <div className="flex gap-2"><Link href={ROUTES.organizerSessionEdit(scope.organizationSlug, scope.eventSlug, scope.sessionId)} className={buttonStyles({ variant: "outline", size: "sm", className: "border-white/20 bg-white/5 text-white hover:border-white" })}>Edit session</Link><Link href={ROUTES.organizerSessionPricing(scope.organizationSlug, scope.eventSlug, scope.sessionId)} className={buttonStyles({ size: "sm" })}>Configure pricing</Link></div> : null}</div></header>
    <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[["Session end", formatVenueDateTime(eventSession.endAt, eventSession.venue.timeZone)], ["Sales start", formatVenueDateTime(eventSession.salesStartAt, eventSession.venue.timeZone)], ["Sales end", formatVenueDateTime(eventSession.salesEndAt, eventSession.venue.timeZone)], ["Sellable capacity", coverage.totalSellable]].map(([label, value]) => <div key={label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</p><p className="mt-2 text-sm font-bold text-slate-950">{value}</p></div>)}</div>
    <div className="mt-8 grid gap-7 xl:grid-cols-[1fr_22rem]">
      <div className="min-w-0 space-y-7">
        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex items-end justify-between"><div><h2 className="text-xl font-black text-slate-950">Pricing coverage</h2><p className="mt-1 text-sm text-slate-600">Blocked seats are excluded. Physical seat types do not assign prices automatically.</p></div><Link href={ROUTES.organizerSessionPricing(scope.organizationSlug, scope.eventSlug, scope.sessionId)} className={buttonStyles({ variant: "outline", size: "sm" })}>View pricing</Link></div><div className="mt-5"><PricingSummary tiers={coverage.tiers} totalSellable={coverage.totalSellable} pricedSellable={coverage.pricedSellable} unpricedSellable={coverage.unpricedSellable} /></div></section>
        <RealtimeOrganizerInventory sessionId={scope.sessionId} organizationSlug={scope.organizationSlug} eventSlug={scope.eventSlug} initialSummary={inventorySummary} timeZone={eventSession.venue.timeZone} initialTicket={realtimeTicket} realtimeUrl={realtimeUrl} />
        <OrganizerBookingSummary summary={bookingSummary} />
        {ticketSummary ? <OrganizerTicketSummary summary={ticketSummary} scope={scope} canScan={canScan} /> : null}
        <section><h2 className="mb-4 text-2xl font-black text-slate-950">Bound read-only seat map</h2><SeatMapRenderer sections={eventSession.seatMap.sections} /></section>
      </div>
      <aside className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm xl:sticky xl:top-24 xl:self-start"><h2 className="font-black text-slate-950">Publication readiness</h2>{issues.length === 0 ? <p className="mt-3 rounded-2xl bg-emerald-50 p-3 text-sm text-emerald-800">This session configuration passes capacity, coverage, ancestry, and pricing checks.</p> : <ul className="mt-3 space-y-2">{issues.map((issue) => <li key={issue} className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{issue}</li>)}</ul>}
        {canManage ? <div className="mt-5 space-y-4">{eventSession.status === "DRAFT" ? <form action={action}><input type="hidden" name="intent" value="publish" /><label className="flex items-start gap-2 text-xs text-slate-600"><input type="checkbox" name="confirmation" value="publish" required />Publish this immutable session configuration.</label><button disabled={issues.length > 0} className={buttonStyles({ size: "sm", className: "mt-3 w-full" })}>Publish session</button></form> : null}{eventSession.status === "ON_SALE" ? <form action={action}><input type="hidden" name="intent" value="pause" /><input type="hidden" name="confirmation" value="pause" /><button className={buttonStyles({ variant: "outline", size: "sm", className: "w-full" })}>Pause sales</button></form> : null}{["SCHEDULED", "SALES_PAUSED"].includes(eventSession.status) ? <form action={action}><input type="hidden" name="intent" value="resume" /><input type="hidden" name="confirmation" value="resume" /><button className={buttonStyles({ variant: "secondary", size: "sm", className: "w-full" })}>Open or resume sales</button></form> : null}{!["CANCELLED", "COMPLETED"].includes(eventSession.status) ? <form action={action}><input type="hidden" name="intent" value="cancel" /><label className="flex items-start gap-2 text-xs text-slate-600"><input type="checkbox" name="confirmation" value="cancel" required />Cancel without deleting history.</label><button className={buttonStyles({ variant: "ghost", size: "sm", className: "mt-2 w-full text-red-700" })}>Cancel session</button></form> : null}</div> : <p className="mt-4 text-xs font-semibold text-amber-700">This session is read-only for your current role or event state.</p>}
      </aside>
    </div>
  </Container></section>;
}
