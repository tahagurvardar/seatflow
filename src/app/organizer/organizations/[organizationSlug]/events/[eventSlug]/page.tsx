import Link from "next/link";

import { eventLifecycleAction } from "@/app/organizer/actions";
import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { ROUTES } from "@/config/site";
import { formatVenueDateTime } from "@/features/events/date-time";
import { canRestoreEvent } from "@/features/events/lifecycle";
import { hasMinimumMembershipRole } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";
import { requireEventAccess } from "@/lib/event-authorization";

export default async function OrganizerEventPage({ params, searchParams }: { params: Promise<{ organizationSlug: string; eventSlug: string }>; searchParams: Promise<{ error?: string; success?: string }> }) {
  const scope = await params;
  const notices = await searchParams;
  const path = ROUTES.organizerEvent(scope.organizationSlug, scope.eventSlug);
  const { membership, event: authorizedEvent } = await requireEventAccess(scope, path);
  const event = await getDatabase().event.findUniqueOrThrow({
    where: { id: authorizedEvent.id },
    include: {
      sessions: {
        orderBy: { startAt: "asc" },
        include: { venue: true, space: true },
      },
    },
  });
  const canManage = hasMinimumMembershipRole(membership.role, "ADMIN");
  const action = eventLifecycleAction.bind(null, scope);
  const upcoming = event.sessions.filter((session) => session.startAt > new Date() && session.status !== "CANCELLED");

  return <section className="bg-slate-50 py-12 sm:py-16"><Container>
    <nav className="text-sm text-slate-500"><Link href={ROUTES.organizerEvents(scope.organizationSlug)} className="hover:text-slate-950">Events</Link> / {event.title}</nav>
    {notices.error ? <p className="mt-5 rounded-2xl bg-red-50 p-4 text-sm text-red-800" role="alert">{notices.error}</p> : null}
    {notices.success ? <p className="mt-5 rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-800">Event transition completed: {notices.success}.</p> : null}
    <header className="mt-6 rounded-[2rem] bg-slate-950 p-7 text-white sm:p-9">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between"><div><div className="flex flex-wrap gap-2"><Badge className="bg-white/10 text-slate-200 ring-white/15">{event.status}</Badge><Badge className="bg-violet-500/15 text-violet-200 ring-violet-400/20">{event.category}</Badge>{!canManage ? <Badge className="bg-sky-500/15 text-sky-200 ring-sky-400/20">READ ONLY</Badge> : null}</div><h1 className="mt-4 text-4xl font-black tracking-[-0.05em] sm:text-5xl">{event.title}</h1><p className="mt-3 max-w-3xl text-slate-300">{event.shortDescription}</p></div><div className="flex flex-wrap gap-2"><Link href={ROUTES.organizerEventPreview(scope.organizationSlug, scope.eventSlug)} className={buttonStyles({ variant: "outline", size: "sm", className: "border-white/20 bg-white/5 text-white hover:border-white hover:bg-white/10" })}>Publication preview</Link>{event.status === "DRAFT" && canManage ? <Link href={ROUTES.organizerEventEdit(scope.organizationSlug, scope.eventSlug)} className={buttonStyles({ size: "sm" })}>Edit content</Link> : null}</div></div>
    </header>
    <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[["All sessions", event.sessions.length], ["Upcoming", upcoming.length], ["Cancelled", event.sessions.filter((session) => session.status === "CANCELLED").length], ["Public slug", event.publicSlug]].map(([label, value]) => <div key={label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</p><p className="mt-2 break-all font-mono text-xl font-black text-slate-950">{value}</p></div>)}</div>
    <div className="mt-8 grid gap-6 lg:grid-cols-[1.35fr_0.65fr]">
      <div><div className="flex items-end justify-between"><h2 className="text-2xl font-black text-slate-950">Sessions</h2>{canManage && ["DRAFT", "PUBLISHED"].includes(event.status) ? <Link href={ROUTES.organizerNewSession(scope.organizationSlug, scope.eventSlug)} className={buttonStyles({ size: "sm" })}>Add session</Link> : null}</div><div className="mt-4 space-y-3">{event.sessions.length > 0 ? event.sessions.map((session) => <Link key={session.id} href={ROUTES.organizerSession(scope.organizationSlug, scope.eventSlug, session.id)} className="flex flex-col gap-3 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between"><div><p className="font-bold text-slate-950">{formatVenueDateTime(session.startAt, session.venue.timeZone)}</p><p className="mt-1 text-sm text-slate-600">{session.venue.name} · {session.space.name}</p></div><Badge className="bg-slate-100 text-slate-700 ring-slate-500/15">{session.status}</Badge></Link>) : <p className="rounded-3xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600">No sessions are configured yet.</p>}</div></div>
      <aside className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><h2 className="font-black text-slate-950">Lifecycle controls</h2><p className="mt-2 text-sm leading-6 text-slate-600">Every transition is re-authorized and validated on the server. Cancellation preserves history.</p>{canManage ? <div className="mt-5 space-y-3">
        {event.status === "DRAFT" ? <form action={action}><input type="hidden" name="intent" value="publish" /><label className="flex items-start gap-2 text-xs text-slate-600"><input type="checkbox" name="confirmation" value="publish" required />Confirm publish after at least one session is published.</label><button className={buttonStyles({ size: "sm", className: "mt-3 w-full" })}>Publish event</button></form> : null}
        {event.status === "DRAFT" && event.sessions.length === 0 ? <form action={action}><input type="hidden" name="intent" value="delete" /><label className="flex items-start gap-2 text-xs text-slate-600"><input type="checkbox" name="confirmation" value="delete" required />Confirm permanent deletion of this empty draft.</label><button className={buttonStyles({ variant: "ghost", size: "sm", className: "mt-2 w-full text-red-700" })}>Delete empty draft</button></form> : null}
        {["DRAFT", "PUBLISHED"].includes(event.status) ? <form action={action}><input type="hidden" name="intent" value="cancel" /><label className="flex items-start gap-2 text-xs text-slate-600"><input type="checkbox" name="confirmation" value="cancel" required />Cancel this event and its non-completed sessions.</label><button className={buttonStyles({ variant: "outline", size: "sm", className: "mt-2 w-full" })}>Cancel event</button></form> : null}
        {event.status !== "ARCHIVED" ? <form action={action}><input type="hidden" name="intent" value="archive" /><label className="flex items-start gap-2 text-xs text-slate-600"><input type="checkbox" name="confirmation" value="archive" required />Archive without deleting history.</label><button className={buttonStyles({ variant: "outline", size: "sm", className: "mt-2 w-full" })}>Archive event</button></form> : null}
        {canRestoreEvent(event.status, event.preArchiveStatus) ? <form action={action}><input type="hidden" name="intent" value="restore" /><input type="hidden" name="confirmation" value="restore" /><button className={buttonStyles({ variant: "secondary", size: "sm", className: "w-full" })}>Restore event</button></form> : null}
      </div> : <p className="mt-5 text-xs font-semibold text-amber-700">MEMBER access is read-only.</p>}</aside>
    </div>
  </Container></section>;
}
