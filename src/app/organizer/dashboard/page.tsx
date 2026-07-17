import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { EmptyState } from "@/components/ui/empty-state";
import { ROUTES } from "@/config/site";
import {
  getUserMemberships,
  requireAuth,
  requireOrganizationMembership,
} from "@/lib/authorization";

export const metadata: Metadata = {
  title: "Organizer Dashboard",
  description: "Open an organizer workspace you are authorized to access.",
};

export default async function OrganizerDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ organization?: string | string[] }>;
}) {
  const [session, parameters] = await Promise.all([
    requireAuth(ROUTES.organizerDashboard),
    searchParams,
  ]);
  const organizerMemberships = (await getUserMemberships(session.user.id)).filter(
    (membership) => membership.organization.kind === "ORGANIZER",
  );

  if (organizerMemberships.length === 0) {
    redirect(ROUTES.organizerOnboarding);
  }

  const requestedSlug = Array.isArray(parameters.organization)
    ? parameters.organization[0]
    : parameters.organization;
  const selectedSlug = requestedSlug ?? organizerMemberships[0].organization.slug;
  const { membership: selectedMembership } =
    await requireOrganizationMembership({
      organizationSlug: selectedSlug,
      kind: "ORGANIZER",
      minimumRole: "MEMBER",
      redirectPath: `${ROUTES.organizerDashboard}?organization=${encodeURIComponent(selectedSlug)}`,
    });

  return (
    <section className="bg-slate-50 py-14 sm:py-20">
      <Container>
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <Badge className="bg-violet-50 text-violet-800 ring-violet-600/15">
              ORGANIZER · {selectedMembership.role}
            </Badge>
            <h1 className="mt-4 text-4xl font-black tracking-[-0.05em] text-slate-950 sm:text-5xl">
              {selectedMembership.organization.name}
            </h1>
            <p className="mt-3 text-base text-slate-600">
              Tenant access is derived from your current membership, not a global
              organizer role.
            </p>
          </div>
          <Link
            href={ROUTES.organizerOnboarding}
            className={buttonStyles({ variant: "outline", size: "sm" })}
          >
            Create another organization
          </Link>
        </div>

        {organizerMemberships.length > 1 ? (
          <div className="mt-8 rounded-3xl border border-slate-200 bg-white p-5">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
              Switch organization
            </p>
            <nav aria-label="Organizer workspaces" className="mt-3 flex flex-wrap gap-2">
              {organizerMemberships.map((membership) => (
                <Link
                  key={membership.id}
                  href={`${ROUTES.organizerDashboard}?organization=${encodeURIComponent(membership.organization.slug)}`}
                  aria-current={
                    membership.organization.id ===
                    selectedMembership.organization.id
                      ? "page"
                      : undefined
                  }
                  className={buttonStyles({
                    variant:
                      membership.organization.id ===
                      selectedMembership.organization.id
                        ? "secondary"
                        : "outline",
                    size: "sm",
                  })}
                >
                  {membership.organization.name}
                </Link>
              ))}
            </nav>
          </div>
        ) : null}

        <div className="mt-8 grid gap-6 lg:grid-cols-[0.75fr_1.25fr]">
          <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-orange-600">
              Workspace identity
            </p>
            <dl className="mt-6 grid gap-5">
              <div>
                <dt className="text-xs font-semibold text-slate-500">Slug</dt>
                <dd className="mt-1 font-mono text-sm font-bold text-slate-950">
                  {selectedMembership.organization.slug}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold text-slate-500">Kind</dt>
                <dd className="mt-1 font-bold text-slate-950">
                  {selectedMembership.organization.kind}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold text-slate-500">
                  Your membership
                </dt>
                <dd className="mt-1 font-bold text-slate-950">
                  {selectedMembership.role}
                </dd>
              </div>
            </dl>
          </article>

          <EmptyState
            icon="calendar"
            title="Event management begins in Phase 3"
            description="This is a real protected organizer workspace. Persistent events, sessions, pricing, and inventory are deliberately deferred; Phase 2 venue layouts live in separate venue-operator tenants."
          />
        </div>
      </Container>
    </section>
  );
}
