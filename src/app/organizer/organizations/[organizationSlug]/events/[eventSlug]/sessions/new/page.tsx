import Link from "next/link";
import { redirect } from "next/navigation";

import { createSessionAction } from "@/app/organizer/actions";
import { SessionForm } from "@/components/organizer/session-form";
import { Container } from "@/components/ui/container";
import { ROUTES } from "@/config/site";
import { getDatabase } from "@/lib/database";
import { requireEventAccess } from "@/lib/event-authorization";
import { listActiveVenueOptionsForOrganizer } from "@/server/venue-access/venue-access-service";

export default async function NewSessionPage({ params }: { params: Promise<{ organizationSlug: string; eventSlug: string }> }) {
  const scope = await params;
  const path = ROUTES.organizerNewSession(scope.organizationSlug, scope.eventSlug);
  const { session, event } = await requireEventAccess(scope, path, "ADMIN");
  if (!["DRAFT", "PUBLISHED"].includes(event.status)) {
    redirect(ROUTES.organizerEvent(scope.organizationSlug, scope.eventSlug));
  }
  const venues = await listActiveVenueOptionsForOrganizer(
    getDatabase(),
    { userId: session.user.id, organizationSlug: scope.organizationSlug },
  );

  return <section className="bg-slate-50 py-12 sm:py-16"><Container><div className="mx-auto max-w-4xl"><Link href={ROUTES.organizerEvent(scope.organizationSlug, scope.eventSlug)} className="text-sm font-semibold text-slate-600 hover:text-slate-950">← Back to {event.title}</Link><div className="mt-6 rounded-[2rem] border border-slate-200 bg-white p-7 shadow-sm sm:p-10"><p className="text-xs font-bold uppercase tracking-[0.16em] text-orange-600">Exact immutable layout binding</p><h1 className="mt-3 text-3xl font-black tracking-[-0.04em] text-slate-950">Create a draft session</h1><p className="mt-3 text-sm leading-6 text-slate-600">Only actively granted venues, active spaces, and published maps are offered. The server rechecks every selected identifier and rejects overlaps.</p><div className="mt-8"><SessionForm action={createSessionAction.bind(null, scope)} venues={venues} submitLabel="Create draft session" /></div></div></div></Container></section>;
}
