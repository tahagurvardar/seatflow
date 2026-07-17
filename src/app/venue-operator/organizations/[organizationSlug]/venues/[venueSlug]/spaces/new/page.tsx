import Link from "next/link";
import { redirect } from "next/navigation";

import { createSpaceAction } from "@/app/venue-operator/actions";
import { SpaceForm } from "@/components/venue-operator/space-form";
import { Container } from "@/components/ui/container";
import { ROUTES } from "@/config/site";
import { requireVenueAccess } from "@/lib/venue-authorization";

export default async function NewSpacePage({ params }: { params: Promise<{ organizationSlug: string; venueSlug: string }> }) {
  const scope = await params;
  const path = ROUTES.venueOperatorNewSpace(scope.organizationSlug, scope.venueSlug);
  const { venue } = await requireVenueAccess(scope, path, "ADMIN");
  if (venue.status === "ARCHIVED") {
    redirect(ROUTES.venueOperatorVenue(scope.organizationSlug, scope.venueSlug));
  }
  const action = createSpaceAction.bind(null, scope);

  return <section className="bg-slate-50 py-12 sm:py-16"><Container><div className="mx-auto max-w-3xl"><Link href={ROUTES.venueOperatorVenue(scope.organizationSlug, scope.venueSlug)} className="text-sm font-semibold text-slate-600 hover:text-slate-950">← Back to {venue.name}</Link><div className="mt-6 rounded-[2rem] border border-slate-200 bg-white p-7 shadow-sm sm:p-10"><h1 className="text-3xl font-black tracking-[-0.04em] text-slate-950">Add a space</h1><p className="mt-3 text-sm leading-6 text-slate-600">A space owns independent seat-map versions and a single current published layout.</p><div className="mt-8"><SpaceForm action={action} submitLabel="Create space" /></div></div></div></Container></section>;
}
