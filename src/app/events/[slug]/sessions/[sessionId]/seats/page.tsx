import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { createHoldAction } from "@/app/customer/hold-actions";
import { HoldCountdown } from "@/components/holds/hold-countdown";
import { RealtimeSeatSelection } from "@/components/holds/realtime-seat-selection";
import { Container } from "@/components/ui/container";
import { Icon } from "@/components/ui/icon";
import { ROUTES } from "@/config/site";
import { getServerEnvironment } from "@/env/server";
import { formatVenueDateTimeRange } from "@/features/events/date-time";
import { realtimeUrlForClient } from "@/features/inventory-events/realtime-endpoint";
import { createRealtimeRoomTicket } from "@/features/inventory-events/room-ticket";
import type { EventCategory } from "@/generated/prisma/enums";
import { getCurrentSession } from "@/lib/session";
import { getDatabase } from "@/lib/database";
import { cn } from "@/lib/utils";
import { getSeatSelectionView } from "@/server/holds/hold-queries";

export const dynamic = "force-dynamic";

// "Other" says nothing about the event, so no badge is shown for it.
const CATEGORY_LABELS: Readonly<Record<EventCategory, string | null>> = {
  CONCERT: "Concert",
  CINEMA: "Cinema",
  THEATRE: "Theatre",
  SPORT: "Sport",
  OTHER: null,
};

const PRIMARY_LINK =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--sf-radius-button)] bg-[var(--sf-brand)] px-5 text-sm font-black text-[var(--sf-on-brand)] outline-none hover:bg-[var(--sf-brand-hover)] focus-visible:ring-4 focus-visible:ring-[var(--sf-focus)]";
const NOTICE = "rounded-[var(--sf-radius-card)] border bg-[var(--sf-surface)] p-5";

interface SeatsPageProps {
  params: Promise<{ slug: string; sessionId: string }>;
}

function ActiveHoldNotice({
  expiresAt,
  publicToken,
  className,
}: {
  expiresAt: string;
  publicToken: string;
  className?: string;
}) {
  return (
    <div className={cn(NOTICE, "border-[var(--sf-seat-held-by-you)]", className)} role="status">
      <h2 className="text-lg font-black">You already have an active hold</h2>
      <p className="mt-1 text-sm text-[var(--sf-text-secondary)]">
        You can hold seats for one session at a time. Your held seats are highlighted on the map.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <span className="text-[var(--sf-text-secondary)]">Time remaining:</span>
        <HoldCountdown expiresAt={expiresAt} className="text-lg text-[var(--sf-link)]" />
        <Link href={ROUTES.customerHold(publicToken)} className={PRIMARY_LINK}>
          View your hold
        </Link>
      </div>
    </div>
  );
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
  const eventPath = ROUTES.eventDetail(view.event.publicSlug);
  const { eligibility, viewerActiveHold, viewerAuthenticated } = view;
  const canSelect =
    eligibility.sellable && viewerAuthenticated && !viewerActiveHold;
  const realtimeTicket = createRealtimeRoomTicket({
    sessionId,
    secret: getServerEnvironment().BETTER_AUTH_SECRET,
  });
  // Empty means "no gateway, poll instead". A hosted deployment must never
  // fall back to a loopback URL: that points at the visitor's own machine.
  const realtimeUrl = realtimeUrlForClient(process.env, {
    hosted: process.env.NODE_ENV === "production",
  });
  const categoryLabel = CATEGORY_LABELS[view.event.category];

  return (
    <div data-theme-scope="customer" className="bg-[var(--sf-canvas)] text-[var(--sf-text)]">
      <Container className="max-w-7xl py-6 sm:py-8">
        <Link
          href={eventPath}
          className="inline-flex min-h-11 items-center gap-2 rounded-[var(--sf-radius-button)] text-sm font-semibold text-[var(--sf-link)] outline-none hover:underline focus-visible:ring-4 focus-visible:ring-[var(--sf-focus)]"
        >
          <span aria-hidden="true">←</span>
          Back to event details
        </Link>

        <header className="mt-3 flex items-start gap-4 sm:gap-6">
          {view.event.imagePath ? (
            <div className="relative aspect-[4/3] w-24 shrink-0 overflow-hidden rounded-[var(--sf-radius-card)] border border-[var(--sf-border)] bg-[var(--sf-surface)] sm:w-44">
              <Image
                src={view.event.imagePath}
                alt=""
                fill
                priority
                sizes="(min-width: 640px) 176px, 96px"
                className="object-cover"
              />
            </div>
          ) : null}
          <div className="min-w-0">
            {categoryLabel ? (
              <span className="inline-flex rounded-full border border-[var(--sf-border)] px-2.5 py-0.5 text-xs font-bold uppercase tracking-wider text-[var(--sf-text-secondary)]">
                {categoryLabel}
              </span>
            ) : null}
            <h1 className="mt-2 break-words text-2xl font-black tracking-[-0.03em] sm:text-4xl">
              {view.event.title}
            </h1>
            <p className="mt-1 text-sm font-semibold text-[var(--sf-text-secondary)]">Select seats</p>
            <dl className="mt-3 grid gap-1 text-sm text-[var(--sf-text-secondary)] sm:flex sm:flex-wrap sm:gap-x-6">
              <div>
                <dt className="sr-only">Date and time</dt>
                <dd>{formatVenueDateTimeRange(view.session.startAt, view.session.endAt, view.session.timeZone)}</dd>
              </div>
              <div>
                <dt className="sr-only">Venue</dt>
                <dd>
                  {view.session.venueName} · {view.session.spaceName}, {view.session.city}
                </dd>
              </div>
            </dl>
            <Link
              href={eventPath}
              className="mt-2 inline-flex min-h-11 items-center text-sm font-bold text-[var(--sf-link)] outline-none hover:underline focus-visible:ring-4 focus-visible:ring-[var(--sf-focus)]"
            >
              Change session
            </Link>
          </div>
        </header>

        <p className="mt-6 text-sm text-[var(--sf-text-secondary)]" role="note">
          Availability on this page refreshes automatically. Every seat is checked
          again the moment you hold it, so a seat shown as available is never
          promised until your hold is confirmed.
        </p>

        {viewerActiveHold ? (
          // Desktop shows this notice in the side column next to the map.
          <ActiveHoldNotice
            expiresAt={viewerActiveHold.expiresAt}
            publicToken={viewerActiveHold.publicToken}
            className="mt-6 lg:hidden"
          />
        ) : !eligibility.sellable ? (
          <div className={cn(NOTICE, "mt-6 border-[var(--sf-warning)]")} role="status">
            <h2 className="text-lg font-black">Seat selection is unavailable</h2>
            <p className="mt-1 text-sm text-[var(--sf-text-secondary)]">{eligibility.message}</p>
          </div>
        ) : !viewerAuthenticated ? (
          <div className={cn(NOTICE, "mt-6 border-[var(--sf-border)]")}>
            <h2 className="text-lg font-black">Sign in to hold seats</h2>
            <p className="mt-1 text-sm text-[var(--sf-text-secondary)]">
              You need a SeatFlow account to reserve seats. Your selection is confirmed when the hold is created.
            </p>
            <Link
              href={`${ROUTES.login}?redirectTo=${encodeURIComponent(seatsPath)}`}
              className={cn(PRIMARY_LINK, "mt-4")}
            >
              <Icon name="ticket" className="size-4" />
              Sign in to continue
            </Link>
          </div>
        ) : null}

        <div className="mt-6">
          <RealtimeSeatSelection
            sessionId={sessionId}
            eventSlug={slug}
            initialSections={view.sections}
            initialCounts={view.counts}
            priceTiers={view.priceTiers}
            maxSeats={view.maxSeatsPerHold}
            action={canSelect ? createHoldAction.bind(null, { publicSlug: slug, sessionId }) : undefined}
            initialTicket={realtimeTicket}
            realtimeUrl={realtimeUrl}
            railNotice={
              viewerActiveHold ? (
                <ActiveHoldNotice
                  expiresAt={viewerActiveHold.expiresAt}
                  publicToken={viewerActiveHold.publicToken}
                  className="hidden lg:block"
                />
              ) : undefined
            }
          />
        </div>
      </Container>
    </div>
  );
}
