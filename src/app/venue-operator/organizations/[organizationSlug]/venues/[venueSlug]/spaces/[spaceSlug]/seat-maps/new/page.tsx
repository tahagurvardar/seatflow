import Link from "next/link";
import { redirect } from "next/navigation";

import { createSeatMapAction } from "@/app/venue-operator/actions";
import { SeatMapForm } from "@/components/seat-maps/seat-map-form";
import { Container } from "@/components/ui/container";
import { ROUTES } from "@/config/site";
import { requireSpaceAccess } from "@/lib/venue-authorization";

export default async function NewSeatMapPage({ params }: { params: Promise<{ organizationSlug: string; venueSlug: string; spaceSlug: string }> }) {
  const scope = await params;
  const path = ROUTES.venueOperatorNewSeatMap(scope.organizationSlug, scope.venueSlug, scope.spaceSlug);
  const { space } = await requireSpaceAccess(scope, path, "ADMIN");
  if (space.status === "ARCHIVED" || space.venue.status === "ARCHIVED") {
    redirect(
      ROUTES.venueOperatorSpace(
        scope.organizationSlug,
        scope.venueSlug,
        scope.spaceSlug,
      ),
    );
  }
  const action = createSeatMapAction.bind(null, scope);

  return <section className="bg-slate-50 py-12 sm:py-16"><Container><div className="mx-auto max-w-2xl"><Link href={ROUTES.venueOperatorSpace(scope.organizationSlug, scope.venueSlug, scope.spaceSlug)} className="text-sm font-semibold text-slate-600 hover:text-slate-950">← Back to {space.name}</Link><div className="mt-6 rounded-[2rem] border border-slate-200 bg-white p-7 shadow-sm sm:p-10"><p className="text-xs font-bold uppercase tracking-[0.16em] text-orange-600">Server-assigned version</p><h1 className="mt-3 text-3xl font-black tracking-[-0.04em] text-slate-950">Create a draft seat map</h1><p className="mt-3 text-sm leading-6 text-slate-600">The next version is allocated transactionally. Published layouts are never edited in place.</p><div className="mt-8"><SeatMapForm action={action} /></div></div></div></Container></section>;
}
