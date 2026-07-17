import type { Metadata } from "next";
import Link from "next/link";

import { VenueOperatorOrganizationForm } from "@/components/venue-operator/organization-onboarding-form";
import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { ROUTES } from "@/config/site";
import { getUserMemberships, requireAuth } from "@/lib/authorization";

export const metadata: Metadata = {
  title: "Create Venue-Operator Workspace",
  description: "Create a venue-operator organization and owner membership.",
};

export default async function VenueOperatorOnboardingPage() {
  const session = await requireAuth(ROUTES.venueOperatorOnboarding);
  const memberships = (await getUserMemberships(session.user.id)).filter(
    (membership) => membership.organization.kind === "VENUE_OPERATOR",
  );

  return (
    <section className="bg-slate-50 py-16 sm:py-24">
      <Container>
        <div className="mx-auto grid max-w-5xl gap-8 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="rounded-[2rem] bg-slate-950 p-8 text-white sm:p-10">
            <Badge className="bg-sky-500/15 text-sky-200 ring-sky-400/20">Venue operator onboarding</Badge>
            <h1 className="mt-6 text-4xl font-black tracking-[-0.05em] sm:text-5xl">Build the places behind every seat.</h1>
            <p className="mt-5 leading-7 text-slate-300">SeatFlow atomically creates one VENUE_OPERATOR organization and one OWNER membership for your account. Venue data stays isolated from organizer tenants.</p>
            {memberships.length > 0 ? (
              <Link href={ROUTES.venueOperatorDashboard} className={buttonStyles({ variant: "outline", size: "sm", className: "mt-8 border-white/20 bg-white/5 text-white hover:border-white hover:bg-white/10" })}>Return to venue dashboard</Link>
            ) : null}
          </div>
          <div className="rounded-[2rem] border border-slate-200 bg-white p-8 shadow-xl shadow-slate-950/5 sm:p-10">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-orange-600">Signed in as {session.user.email}</p>
            <h2 className="mt-3 text-3xl font-black tracking-[-0.04em] text-slate-950">{memberships.length > 0 ? "Create another operator" : "Name your operator"}</h2>
            <p className="mt-3 text-sm leading-6 text-slate-600">OWNER and ADMIN members can manage venues and seat maps. MEMBER access is read-only.</p>
            <VenueOperatorOrganizationForm />
          </div>
        </div>
      </Container>
    </section>
  );
}
