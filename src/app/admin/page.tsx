import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import { Container } from "@/components/ui/container";
import { ROUTES } from "@/config/site";
import { requirePlatformAdmin } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";

export const metadata: Metadata = {
  title: "Platform Administration",
  description: "SeatFlow platform identity and tenant totals.",
};

export default async function AdminPage() {
  const { user } = await requirePlatformAdmin(ROUTES.admin);
  const database = getDatabase();
  const [
    users,
    activeSessions,
    organizations,
    organizerOrganizations,
    venueOperatorOrganizations,
    memberships,
  ] = await Promise.all([
      database.user.count(),
      database.session.count({ where: { expiresAt: { gt: new Date() } } }),
      database.organization.count(),
      database.organization.count({ where: { kind: "ORGANIZER" } }),
      database.organization.count({ where: { kind: "VENUE_OPERATOR" } }),
      database.membership.count(),
    ]);
  const metrics = [
    { label: "Registered users", value: users },
    { label: "Active sessions", value: activeSessions },
    { label: "Organizations", value: organizations },
    { label: "Organizer tenants", value: organizerOrganizations },
    { label: "Venue tenants", value: venueOperatorOrganizations },
    { label: "Memberships", value: memberships },
  ];

  return (
    <section className="bg-slate-950 py-14 text-white sm:py-20">
      <Container>
        <Badge className="bg-orange-500/15 text-orange-200 ring-orange-400/20">
          Platform administrator
        </Badge>
        <h1 className="mt-4 text-4xl font-black tracking-[-0.05em] sm:text-5xl">
          SeatFlow operations
        </h1>
        <p className="mt-3 max-w-2xl leading-7 text-slate-300">
          Signed in as {user.email}. These counts are queried from PostgreSQL at
          request time; there are no simulated analytics.
        </p>

        <dl className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {metrics.map((metric) => (
            <div
              key={metric.label}
              className="rounded-3xl border border-white/10 bg-white/5 p-6"
            >
              <dt className="text-xs font-bold uppercase tracking-[0.14em] text-slate-400">
                {metric.label}
              </dt>
              <dd className="mt-4 text-4xl font-black tracking-tight">
                {metric.value.toLocaleString("en")}
              </dd>
            </div>
          ))}
        </dl>

        <div className="mt-8 rounded-3xl border border-white/10 bg-white/5 p-6 text-sm leading-6 text-slate-300">
          Platform role changes are intentionally absent from the web interface.
          Promote an already registered account only through the explicit admin
          bootstrap command documented in the repository.
        </div>
      </Container>
    </section>
  );
}
