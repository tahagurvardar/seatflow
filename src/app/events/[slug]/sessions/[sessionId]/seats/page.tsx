import Link from "next/link";
import { notFound } from "next/navigation";

import { createHoldAction } from "@/app/customer/hold-actions";
import { HoldCountdown } from "@/components/holds/hold-countdown";
import { SeatSelectionPreview } from "@/components/holds/seat-selection-preview";
import { SelectableSeatMap } from "@/components/holds/selectable-seat-map";
import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Container, Section } from "@/components/ui/container";
import { Icon } from "@/components/ui/icon";
import { ROUTES } from "@/config/site";
import { formatVenueDateTime } from "@/features/events/date-time";
import { getCurrentSession } from "@/lib/session";
import { getDatabase } from "@/lib/database";
import { getSeatSelectionView } from "@/server/holds/hold-queries";

export const dynamic = "force-dynamic";

interface SeatsPageProps {
  params: Promise<{ slug: string; sessionId: string }>;
}

export default async function SeatSelectionPage({ params }: SeatsPageProps) {
  const { slug, sessionId } = await params;
  const authSession = await getCurrentSession();
  const actor = authSession ? { userId: authSession.user.id } : null;

  const view = await getSeatSelectionView(
    getDatabase(),
    actor,
    { publicSlug: slug, sessionId },
  );
  if (!view) notFound();

  const seatsPath = ROUTES.eventSessionSeats(slug, sessionId);
  const { eligibility, viewerActiveHold, viewerAuthenticated } = view;
  const canSelect =
    eligibility.sellable && viewerAuthenticated && !viewerActiveHold;

  return (
    <Section className="bg-slate-50">
      <Container className="max-w-6xl">
        <nav className="text-sm text-slate-500">
          <Link href={ROUTES.eventDetail(view.event.publicSlug)} className="hover:text-slate-950">
            {view.event.title}
          </Link>{" "}
          / Select seats
        </nav>

        <header className="mt-5 rounded-[2rem] bg-slate-950 p-7 text-white sm:p-9">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="bg-white/10 text-slate-200 ring-white/15">
              {view.session.venueName} · {view.session.spaceName}
            </Badge>
            <Badge className="bg-emerald-500/15 text-emerald-200 ring-emerald-400/20">
              MAP V{view.session.seatMapVersion}
            </Badge>
          </div>
          <h1 className="mt-4 text-3xl font-black tracking-[-0.04em] sm:text-4xl">
            {formatVenueDateTime(view.session.startAt, view.session.timeZone)}
          </h1>
          <p className="mt-3 text-slate-300">
            {view.session.venueName} · {view.session.spaceName} · {view.session.city}
          </p>
          <dl className="mt-6 grid gap-3 sm:grid-cols-3">
            {[
              ["Available", view.counts.available],
              ["Held", view.counts.heldByYou + (view.counts.unavailable)],
              ["Total seats", view.counts.total],
            ].map(([label, value]) => (
              <div key={label} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <dt className="text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</dt>
                <dd className="mt-1 text-2xl font-black">{value}</dd>
              </div>
            ))}
          </dl>
        </header>

        <div className="mt-6 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900" role="note">
          Availability is confirmed the moment your hold is created — this page is not a
          live-synced view. If a seat is taken while you choose, SeatFlow will tell you and
          keep the rest of your selection intact.
        </div>

        {viewerActiveHold ? (
          <div className="mt-6 rounded-3xl border border-indigo-200 bg-indigo-50 p-6" role="status">
            <h2 className="text-lg font-black text-indigo-950">You already have an active hold</h2>
            <p className="mt-1 text-sm text-indigo-900">
              You can hold seats for one session at a time. Your held seats are highlighted below.
            </p>
            <div className="mt-3 flex items-center gap-3 text-sm">
              <span className="text-indigo-900">Time remaining:</span>
              <HoldCountdown expiresAt={viewerActiveHold.expiresAt} className="text-lg text-indigo-950" />
              <Link href={ROUTES.customerHold(viewerActiveHold.publicToken)} className={buttonStyles({ size: "sm" })}>
                View your hold
              </Link>
            </div>
          </div>
        ) : !eligibility.sellable ? (
          <div className="mt-6 rounded-3xl border border-amber-200 bg-amber-50 p-6" role="status">
            <h2 className="text-lg font-black text-amber-950">Seat selection is unavailable</h2>
            <p className="mt-1 text-sm text-amber-900">{eligibility.message}</p>
          </div>
        ) : !viewerAuthenticated ? (
          <div className="mt-6 rounded-3xl border border-slate-200 bg-white p-6">
            <h2 className="text-lg font-black text-slate-950">Sign in to hold seats</h2>
            <p className="mt-1 text-sm text-slate-600">
              You need a SeatFlow account to reserve seats. Your selection is confirmed when the hold is created.
            </p>
            <Link
              href={`${ROUTES.login}?redirectTo=${encodeURIComponent(seatsPath)}`}
              className={buttonStyles({ className: "mt-4" })}
            >
              <Icon name="ticket" className="size-4" />
              Sign in to continue
            </Link>
          </div>
        ) : null}

        <div className="mt-8">
          {canSelect ? (
            <SelectableSeatMap
              sections={view.sections}
              maxSeats={view.maxSeatsPerHold}
              currency={view.currency}
              action={createHoldAction.bind(null, { publicSlug: slug, sessionId })}
            />
          ) : (
            <SeatSelectionPreview sections={view.sections} />
          )}
        </div>
      </Container>
    </Section>
  );
}
