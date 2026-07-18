import Link from "next/link";
import { redirect } from "next/navigation";

import { updateEventAction } from "@/app/organizer/actions";
import { EventForm } from "@/components/organizer/event-form";
import { Container } from "@/components/ui/container";
import { ROUTES } from "@/config/site";
import { requireEventAccess } from "@/lib/event-authorization";

export default async function EditEventPage({ params }: { params: Promise<{ organizationSlug: string; eventSlug: string }> }) {
  const scope = await params;
  const path = ROUTES.organizerEventEdit(scope.organizationSlug, scope.eventSlug);
  const { event } = await requireEventAccess(scope, path, "ADMIN");
  if (event.status !== "DRAFT") redirect(ROUTES.organizerEvent(scope.organizationSlug, scope.eventSlug));
  return <section className="bg-slate-50 py-12 sm:py-16"><Container><div className="mx-auto max-w-3xl"><Link href={ROUTES.organizerEvent(scope.organizationSlug, scope.eventSlug)} className="text-sm font-semibold text-slate-600 hover:text-slate-950">← Back to event</Link><div className="mt-6 rounded-[2rem] border border-slate-200 bg-white p-7 shadow-sm sm:p-10"><h1 className="text-3xl font-black tracking-[-0.04em] text-slate-950">Edit draft event</h1><p className="mt-3 text-sm text-slate-600">Published descriptive content is intentionally immutable in Phase 3.</p><div className="mt-8"><EventForm action={updateEventAction.bind(null, scope)} submitLabel="Save draft event" defaults={event} /></div></div></div></Container></section>;
}
