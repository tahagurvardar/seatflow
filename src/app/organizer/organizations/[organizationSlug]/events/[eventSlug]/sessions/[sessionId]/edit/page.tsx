import Link from "next/link";
import { redirect } from "next/navigation";

import { updateSessionAction } from "@/app/organizer/actions";
import { SessionForm } from "@/components/organizer/session-form";
import { Container } from "@/components/ui/container";
import { ROUTES } from "@/config/site";
import { toVenueLocalInputValue } from "@/features/events/date-time";
import { getDatabase } from "@/lib/database";
import { requireEventSessionAccess } from "@/lib/event-authorization";
import { listActiveVenueOptionsForOrganizer } from "@/server/venue-access/venue-access-service";

export default async function EditSessionPage({ params }: { params: Promise<{ organizationSlug: string; eventSlug: string; sessionId: string }> }) {
  const scope = await params;
  const path = ROUTES.organizerSessionEdit(scope.organizationSlug, scope.eventSlug, scope.sessionId);
  const { session, event, eventSession } = await requireEventSessionAccess(scope, path, "ADMIN");
  if (eventSession.status !== "DRAFT" || !["DRAFT", "PUBLISHED"].includes(event.status)) redirect(ROUTES.organizerSession(scope.organizationSlug, scope.eventSlug, scope.sessionId));
  const venues = await listActiveVenueOptionsForOrganizer(getDatabase(), { userId: session.user.id, organizationSlug: scope.organizationSlug });
  const defaults = {
    venueId: eventSession.venueId,
    spaceId: eventSession.spaceId,
    seatMapId: eventSession.seatMapId,
    startLocal: toVenueLocalInputValue(eventSession.startAt, eventSession.venue.timeZone),
    endLocal: toVenueLocalInputValue(eventSession.endAt, eventSession.venue.timeZone),
    salesStartLocal: toVenueLocalInputValue(eventSession.salesStartAt, eventSession.venue.timeZone),
    salesEndLocal: toVenueLocalInputValue(eventSession.salesEndAt, eventSession.venue.timeZone),
  };

  return <section className="bg-slate-50 py-12 sm:py-16"><Container><div className="mx-auto max-w-4xl"><Link href={ROUTES.organizerSession(scope.organizationSlug, scope.eventSlug, scope.sessionId)} className="text-sm font-semibold text-slate-600 hover:text-slate-950">← Back to session</Link><div className="mt-6 rounded-[2rem] border border-slate-200 bg-white p-7 shadow-sm sm:p-10"><h1 className="text-3xl font-black tracking-[-0.04em] text-slate-950">Edit draft session</h1><p className="mt-3 text-sm text-slate-600">Venue, time, and seat-map references become immutable at publication.</p><div className="mt-8"><SessionForm action={updateSessionAction.bind(null, scope)} venues={venues} defaults={defaults} submitLabel="Save draft session" /></div></div></div></Container></section>;
}
