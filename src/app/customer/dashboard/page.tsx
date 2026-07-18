import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { EmptyState } from "@/components/ui/empty-state";
import { ROUTES } from "@/config/site";
import { getUserMemberships, requireAuth } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";

export const metadata: Metadata = {
  title: "Customer Dashboard",
  description: "View your SeatFlow account and organization memberships.",
};

export default async function CustomerDashboardPage() {
  const session = await requireAuth(ROUTES.customerDashboard);
  const [user, memberships] = await Promise.all([
    getDatabase().user.findUniqueOrThrow({
      where: { id: session.user.id },
      select: {
        name: true,
        email: true,
        createdAt: true,
      },
    }),
    getUserMemberships(session.user.id),
  ]);

  return (
    <section className="bg-slate-50 py-14 sm:py-20">
      <Container>
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <Badge className="bg-emerald-50 text-emerald-800 ring-emerald-600/15">
              Authenticated customer
            </Badge>
            <h1 className="mt-4 text-4xl font-black tracking-[-0.05em] text-slate-950 sm:text-5xl">
              Welcome, {user.name}.
            </h1>
            <p className="mt-3 text-base text-slate-600">
              Your account identity and tenant access, read directly from
              PostgreSQL.
            </p>
          </div>
          <Link
            href={ROUTES.events}
            className={buttonStyles({ variant: "outline", size: "sm" })}
          >
            Browse events
          </Link>
        </div>

        <div className="mt-10 grid gap-6 lg:grid-cols-[0.8fr_1.2fr]">
          <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-orange-600">
              Account
            </p>
            <dl className="mt-6 grid gap-5">
              <div>
                <dt className="text-xs font-semibold text-slate-500">Name</dt>
                <dd className="mt-1 font-bold text-slate-950">{user.name}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold text-slate-500">Email</dt>
                <dd className="mt-1 break-all font-bold text-slate-950">
                  {user.email}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold text-slate-500">
                  Customer since
                </dt>
                <dd className="mt-1 font-bold text-slate-950">
                  {new Intl.DateTimeFormat("en", {
                    dateStyle: "long",
                  }).format(user.createdAt)}
                </dd>
              </div>
            </dl>
          </article>

          <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-violet-700">
                  Organizations
                </p>
                <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-950">
                  Memberships
                </h2>
              </div>
              <Link
                href={ROUTES.organizerOnboarding}
                className={buttonStyles({ variant: "ghost", size: "sm" })}
              >
                Create organization
              </Link>
            </div>

            {memberships.length > 0 ? (
              <ul className="mt-6 grid gap-3">
                {memberships.map((membership) => (
                  <li
                    key={membership.id}
                    className="flex flex-col gap-3 rounded-2xl border border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div>
                      <p className="font-bold text-slate-950">
                        {membership.organization.name}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {membership.organization.kind.replace("_", " ")}
                      </p>
                    </div>
                    <Badge className="w-fit bg-slate-100 text-slate-700 ring-slate-600/10">
                      {membership.role}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-6 rounded-2xl bg-slate-50 p-5 text-sm leading-6 text-slate-600">
                You do not belong to an organization yet. Your customer access is
                unaffected.
              </p>
            )}
          </article>
        </div>

        <div className="mt-6">
          <EmptyState
            icon="ticket"
            title="Booking data starts in a later phase"
            description="Phase 3 adds persisted events, configured sessions, and section pricing, but customer bookings and tickets remain deliberately deferred. No fake purchase data is shown here."
            action={
              <Link href={ROUTES.events} className={buttonStyles({ size: "sm" })}>
                Explore the public catalogue
              </Link>
            }
          />
        </div>
      </Container>
    </section>
  );
}
