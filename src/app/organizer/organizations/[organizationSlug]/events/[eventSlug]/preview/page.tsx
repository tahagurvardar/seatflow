import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { ROUTES } from "@/config/site";
import { formatVenueDateTime } from "@/features/events/date-time";
import { formatMinorCurrency } from "@/features/events/money";
import { getDatabase } from "@/lib/database";
import { requireEventAccess } from "@/lib/event-authorization";

interface EventPublicationPreviewPageProps {
  params: Promise<{ organizationSlug: string; eventSlug: string }>;
}

export default async function EventPublicationPreviewPage({
  params,
}: EventPublicationPreviewPageProps) {
  const scope = await params;
  const path = ROUTES.organizerEventPreview(
    scope.organizationSlug,
    scope.eventSlug,
  );
  const { event: authorizedEvent } = await requireEventAccess(scope, path);
  const event = await getDatabase().event.findUniqueOrThrow({
    where: { id: authorizedEvent.id },
    include: {
      organizerOrganization: true,
      sessions: {
        where: {
          status: { in: ["SCHEDULED", "ON_SALE", "SALES_PAUSED"] },
          startAt: { gt: new Date() },
        },
        orderBy: { startAt: "asc" },
        include: {
          venue: true,
          space: true,
          priceTiers: { orderBy: { priceMinor: "asc" } },
        },
      },
    },
  });
  const publiclyVisible = event.status === "PUBLISHED" && event.sessions.length > 0;

  return (
    <section className="bg-slate-50 py-12 sm:py-16">
      <Container>
        <Link
          href={ROUTES.organizerEvent(scope.organizationSlug, scope.eventSlug)}
          className="text-sm font-semibold text-slate-600 hover:text-slate-950"
        >
          ← Back to event
        </Link>
        <div className="mt-6 rounded-[2rem] border border-slate-200 bg-white p-7 shadow-sm sm:p-10">
          <div className="flex flex-wrap gap-2">
            <Badge
              className={
                publiclyVisible
                  ? "bg-emerald-50 text-emerald-800 ring-emerald-600/15"
                  : "bg-amber-50 text-amber-800 ring-amber-600/15"
              }
            >
              {publiclyVisible ? "PUBLICLY ELIGIBLE" : "NOT PUBLIC"}
            </Badge>
            <Badge className="bg-slate-100 text-slate-700 ring-slate-500/15">
              {event.status}
            </Badge>
          </div>
          <h1 className="mt-5 text-4xl font-black tracking-[-0.05em] text-slate-950">
            {event.title}
          </h1>
          <p className="mt-4 max-w-3xl text-lg leading-8 text-slate-600">
            {event.shortDescription}
          </p>
          <p className="mt-7 whitespace-pre-line leading-8 text-slate-700">
            {event.description}
          </p>
          <dl className="mt-8 grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl bg-slate-50 p-4">
              <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">
                Organizer
              </dt>
              <dd className="mt-1 font-bold text-slate-950">
                {event.organizerOrganization.name}
              </dd>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">
                Public route
              </dt>
              <dd className="mt-1 break-all font-mono text-sm font-bold text-slate-950">
                /events/{event.publicSlug}
              </dd>
            </div>
          </dl>
          <section className="mt-9">
            <h2 className="text-2xl font-black text-slate-950">
              Eligible upcoming sessions
            </h2>
            <div className="mt-4 space-y-3">
              {event.sessions.length > 0 ? (
                event.sessions.map((session) => {
                  const minimumTier = session.priceTiers[0];

                  return (
                    <article
                      key={session.id}
                      className="rounded-2xl border border-slate-200 p-4"
                    >
                      <p className="font-bold text-slate-950">
                        {formatVenueDateTime(
                          session.startAt,
                          session.venue.timeZone,
                        )}
                      </p>
                      <p className="mt-1 text-sm text-slate-600">
                        {session.venue.name} · {session.space.name} ·{" "}
                        {minimumTier
                          ? `from ${formatMinorCurrency(minimumTier.priceMinor, minimumTier.currency)}`
                          : "no tiers"}
                      </p>
                    </article>
                  );
                })
              ) : (
                <p className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-900">
                  Publish a valid future session before this event can appear
                  publicly.
                </p>
              )}
            </div>
          </section>
          {publiclyVisible ? (
            <Link
              href={ROUTES.eventDetail(event.publicSlug)}
              className={buttonStyles({ className: "mt-8" })}
            >
              Open public detail
            </Link>
          ) : null}
        </div>
      </Container>
    </section>
  );
}
