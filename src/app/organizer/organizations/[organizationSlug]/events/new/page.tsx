import Link from "next/link";

import { createEventAction } from "@/app/organizer/actions";
import { EventForm } from "@/components/organizer/event-form";
import { Container } from "@/components/ui/container";
import { ROUTES } from "@/config/site";
import { requireOrganizerOrganizationAccess } from "@/lib/event-authorization";

export default async function NewEventPage({ params }: { params: Promise<{ organizationSlug: string }> }) {
  const { organizationSlug } = await params;
  const path = ROUTES.organizerNewEvent(organizationSlug);
  const { membership } = await requireOrganizerOrganizationAccess(organizationSlug, path, "ADMIN");

  return <section className="bg-slate-50 py-12 sm:py-16"><Container><div className="mx-auto max-w-3xl"><Link href={ROUTES.organizerEvents(organizationSlug)} className="text-sm font-semibold text-slate-600 hover:text-slate-950">← Back to events</Link><div className="mt-6 rounded-[2rem] border border-slate-200 bg-white p-7 shadow-sm sm:p-10"><p className="text-xs font-bold uppercase tracking-[0.16em] text-orange-600">{membership.organization.name}</p><h1 className="mt-3 text-3xl font-black tracking-[-0.04em] text-slate-950">Create a persistent event</h1><p className="mt-3 text-sm leading-6 text-slate-600">The organizer tenant is derived from this authorized route. Client input cannot move the event to another organization.</p><div className="mt-8"><EventForm action={createEventAction.bind(null, organizationSlug)} submitLabel="Create draft event" /></div></div></div></Container></section>;
}
