import Link from "next/link";
import { redirect } from "next/navigation";

import { updateVenueAction } from "@/app/venue-operator/actions";
import { VenueForm } from "@/components/venue-operator/venue-form";
import { Container } from "@/components/ui/container";
import { ROUTES } from "@/config/site";
import { requireVenueAccess } from "@/lib/venue-authorization";

export default async function EditVenuePage({ params }: { params: Promise<{ organizationSlug: string; venueSlug: string }> }) {
  const scope = await params;
  const path = ROUTES.venueOperatorVenueEdit(scope.organizationSlug, scope.venueSlug);
  const { venue } = await requireVenueAccess(scope, path, "ADMIN");
  if (venue.status === "ARCHIVED") redirect(ROUTES.venueOperatorVenue(scope.organizationSlug, scope.venueSlug));
  const action = updateVenueAction.bind(null, scope);

  return <section className="bg-slate-50 py-12 sm:py-16"><Container><div className="mx-auto max-w-3xl"><Link href={ROUTES.venueOperatorVenue(scope.organizationSlug, scope.venueSlug)} className="text-sm font-semibold text-slate-600 hover:text-slate-950">← Back to venue</Link><div className="mt-6 rounded-[2rem] border border-slate-200 bg-white p-7 shadow-sm sm:p-10"><h1 className="text-3xl font-black tracking-[-0.04em] text-slate-950">Edit {venue.name}</h1><p className="mt-3 text-sm text-slate-600">Changing the slug changes this venue’s management URL.</p><div className="mt-8"><VenueForm action={action} submitLabel="Save venue" defaults={{ ...venue, status: venue.status }} /></div></div></div></Container></section>;
}
