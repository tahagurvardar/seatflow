import type { Metadata } from "next";
import Link from "next/link";

import { OrganizationOnboardingForm } from "@/components/organizer/organization-onboarding-form";
import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { ROUTES } from "@/config/site";
import { getUserMemberships, requireAuth } from "@/lib/authorization";

export const metadata: Metadata = {
  title: "Create Organizer Workspace",
  description: "Create an organizer organization and owner membership.",
};

export default async function OrganizerOnboardingPage() {
  const session = await requireAuth(ROUTES.organizerOnboarding);
  const existingOrganizerMemberships = (await getUserMemberships(
    session.user.id,
  )).filter((membership) => membership.organization.kind === "ORGANIZER");

  return (
    <section className="bg-slate-50 py-16 sm:py-24">
      <Container>
        <div className="mx-auto grid max-w-5xl gap-8 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="rounded-[2rem] bg-slate-950 p-8 text-white sm:p-10">
            <Badge className="bg-orange-500/15 text-orange-200 ring-orange-400/20">
              Organizer onboarding
            </Badge>
            <h1 className="mt-6 text-4xl font-black tracking-[-0.05em] sm:text-5xl">
              Create a tenant you own.
            </h1>
            <p className="mt-5 leading-7 text-slate-300">
              SeatFlow will atomically create one ORGANIZER organization and one
              OWNER membership for your current account. No other user, role, or
              organization kind can be submitted by this form.
            </p>
            {existingOrganizerMemberships.length > 0 ? (
              <Link
                href={ROUTES.organizerDashboard}
                className={buttonStyles({
                  variant: "outline",
                  size: "sm",
                  className:
                    "mt-8 border-white/20 bg-white/5 text-white hover:border-white hover:bg-white/10",
                })}
              >
                Return to organizer dashboard
              </Link>
            ) : null}
          </div>

          <div className="rounded-[2rem] border border-slate-200 bg-white p-8 shadow-xl shadow-slate-950/5 sm:p-10">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-orange-600">
              Signed in as {session.user.email}
            </p>
            <h2 className="mt-3 text-3xl font-black tracking-[-0.04em] text-slate-950">
              {existingOrganizerMemberships.length > 0
                ? "Create another organization"
                : "Name your organization"}
            </h2>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              You can belong to multiple organizations. Tenant permissions remain
              separate from platform administrator access.
            </p>
            <OrganizationOnboardingForm />
          </div>
        </div>
      </Container>
    </section>
  );
}
