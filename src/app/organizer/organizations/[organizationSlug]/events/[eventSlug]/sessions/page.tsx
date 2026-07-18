import { redirect } from "next/navigation";
import { ROUTES } from "@/config/site";
import { requireEventAccess } from "@/lib/event-authorization";

export default async function SessionsIndexPage({ params }: { params: Promise<{ organizationSlug: string; eventSlug: string }> }) {
  const scope = await params;
  const destination = ROUTES.organizerEvent(
    scope.organizationSlug,
    scope.eventSlug,
  );
  await requireEventAccess(scope, destination);
  redirect(destination);
}
