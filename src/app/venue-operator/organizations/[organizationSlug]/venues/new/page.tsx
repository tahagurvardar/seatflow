import Link from "next/link";

import { createVenueAction } from "@/app/venue-operator/actions";
import { VenueForm } from "@/components/venue-operator/venue-form";
import { Container } from "@/components/ui/container";
import { ROUTES } from "@/config/site";
import { requireVenueOperatorOrganizationAccess } from "@/lib/venue-authorization";

export default async function NewVenuePage({ params }: { params: Promise<{ organizationSlug: string }> }) {
  const { organizationSlug } = await params;
  const path = ROUTES.venueOperatorNewVenue(organizationSlug);
  const { membership } = await requireVenueOperatorOrganizationAccess(organizationSlug, path, "ADMIN");
  const action = createVenueAction.bind(null, organizationSlug);

  return (
    <section className="bg-slate-50 py-12 sm:py-16"><Container><div className="mx-auto max-w-3xl"><Link href={ROUTES.venueOperatorVenues(organizationSlug)} className="text-sm font-semibold text-slate-600 hover:text-slate-950">← Back to venues</Link><div className="mt-6 rounded-[2rem] border border-slate-200 bg-white p-7 shadow-sm sm:p-10"><p className="text-xs font-bold uppercase tracking-[0.16em] text-orange-600">{membership.organization.name}</p><h1 className="mt-3 text-3xl font-black tracking-[-0.04em] text-slate-950">Create a venue</h1><p className="mt-3 text-sm leading-6 text-slate-600">Address and time-zone data establish the operational home for nested spaces.</p><div className="mt-8"><VenueForm action={action} submitLabel="Create venue" /></div></div></div></Container></section>
  );
}
