import Link from "next/link";
import { redirect } from "next/navigation";

import { updateSpaceAction } from "@/app/venue-operator/actions";
import { SpaceForm } from "@/components/venue-operator/space-form";
import { Container } from "@/components/ui/container";
import { ROUTES } from "@/config/site";
import { requireSpaceAccess } from "@/lib/venue-authorization";

export default async function EditSpacePage({ params }: { params: Promise<{ organizationSlug: string; venueSlug: string; spaceSlug: string }> }) {
  const scope = await params;
  const path = ROUTES.venueOperatorSpaceEdit(scope.organizationSlug, scope.venueSlug, scope.spaceSlug);
  const { space } = await requireSpaceAccess(scope, path, "ADMIN");
  if (space.status === "ARCHIVED" || space.venue.status === "ARCHIVED") redirect(ROUTES.venueOperatorSpace(scope.organizationSlug, scope.venueSlug, scope.spaceSlug));
  const action = updateSpaceAction.bind(null, scope);

  return <section className="bg-slate-50 py-12 sm:py-16"><Container><div className="mx-auto max-w-3xl"><Link href={ROUTES.venueOperatorSpace(scope.organizationSlug, scope.venueSlug, scope.spaceSlug)} className="text-sm font-semibold text-slate-600 hover:text-slate-950">← Back to space</Link><div className="mt-6 rounded-[2rem] border border-slate-200 bg-white p-7 shadow-sm sm:p-10"><h1 className="text-3xl font-black tracking-[-0.04em] text-slate-950">Edit {space.name}</h1><p className="mt-3 text-sm text-slate-600">Changing the slug changes this space’s management URL.</p><div className="mt-8"><SpaceForm action={action} submitLabel="Save space" defaults={{ ...space, status: space.status }} /></div></div></div></Container></section>;
}
