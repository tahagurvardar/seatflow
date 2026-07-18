import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { releaseHoldAction } from "@/app/customer/hold-actions";
import { HoldCountdown } from "@/components/holds/hold-countdown";
import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Container, Section } from "@/components/ui/container";
import { ROUTES } from "@/config/site";
import { formatVenueDateTime } from "@/features/events/date-time";
import { formatMinorCurrency } from "@/features/events/money";
import { requireAuth } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";
import { getCustomerHoldByToken } from "@/server/holds/hold-queries";
import { HoldAuthorizationError } from "@/server/holds/errors";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Your seat hold" };

interface HoldPageProps {
  params: Promise<{ holdToken: string }>;
  searchParams: Promise<{ released?: string; error?: string }>;
}

export default async function HoldDetailPage({ params, searchParams }: HoldPageProps) {
  const { holdToken } = await params;
  const notices = await searchParams;
  const authSession = await requireAuth(ROUTES.customerHold(holdToken));

  let view;
  try {
    view = await getCustomerHoldByToken(
      getDatabase(),
      { userId: authSession.user.id },
      holdToken,
    );
  } catch (error) {
    if (error instanceof HoldAuthorizationError) notFound();
    throw error;
  }

  const isLive = view.status === "ACTIVE" && view.live;
  const isReleased = view.status === "RELEASED";

  return (
    <Section className="bg-slate-50">
      <Container className="max-w-3xl">
        <nav className="text-sm text-slate-500">
          <Link href={ROUTES.customerDashboard} className="hover:text-slate-950">
            Dashboard
          </Link>{" "}
          / Seat hold
        </nav>

        {notices.released ? (
          <p className="mt-5 rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-800">
            Your hold was released and the seats are available to others again.
          </p>
        ) : null}
        {notices.error ? (
          <p className="mt-5 rounded-2xl bg-red-50 p-4 text-sm text-red-800" role="alert">
            {notices.error}
          </p>
        ) : null}

        <header className="mt-5 rounded-[2rem] bg-slate-950 p-7 text-white sm:p-9">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              className={
                isLive
                  ? "bg-emerald-500/15 text-emerald-200 ring-emerald-400/20"
                  : isReleased
                    ? "bg-slate-500/20 text-slate-200 ring-white/15"
                    : "bg-red-500/15 text-red-200 ring-red-400/20"
              }
            >
              {isLive ? "ACTIVE HOLD" : isReleased ? "RELEASED" : "EXPIRED"}
            </Badge>
          </div>
          <h1 className="mt-4 text-3xl font-black tracking-[-0.04em] sm:text-4xl">
            {view.event.title}
          </h1>
          <p className="mt-3 text-slate-300">
            {formatVenueDateTime(view.session.startAt, view.session.timeZone)}
          </p>
          <p className="mt-1 text-slate-400">
            {view.session.venueName} · {view.session.spaceName} · {view.session.city}
          </p>
        </header>

        {isLive ? (
          <div className="mt-6 flex flex-col items-center gap-2 rounded-3xl border border-emerald-200 bg-emerald-50 p-6 text-center">
            <p className="text-xs font-bold uppercase tracking-wider text-emerald-800">
              Time remaining to check out
            </p>
            <HoldCountdown expiresAt={view.expiresAt} className="text-4xl text-slate-950" />
            <p className="text-xs text-emerald-800">
              Held until {formatVenueDateTime(view.expiresAt, view.session.timeZone)}. The
              countdown is a guide; SeatFlow confirms your hold from the server.
            </p>
          </div>
        ) : (
          <div className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 text-center" role="status">
            <p className="text-sm font-semibold text-slate-700">
              {isReleased
                ? "This hold was released. The seats are no longer reserved for you."
                : "This hold has expired. The seats have been returned to availability."}
            </p>
            <Link
              href={ROUTES.eventSessionSeats(view.event.publicSlug, view.session.id)}
              className={buttonStyles({ variant: "outline", size: "sm", className: "mt-4" })}
            >
              Choose seats again
            </Link>
          </div>
        )}

        <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-black text-slate-950">
            {view.seatCount} {view.seatCount === 1 ? "seat" : "seats"}
          </h2>
          <ul className="mt-4 divide-y divide-slate-100">
            {view.seats.map((seat, index) => (
              <li key={`${seat.sectionCode}-${seat.rowLabel}-${seat.seatLabel}-${index}`} className="flex items-center justify-between py-3">
                <div>
                  <p className="font-bold text-slate-950">
                    {seat.sectionName} · Row {seat.rowLabel} · Seat {seat.seatLabel}
                  </p>
                  <p className="text-xs text-slate-500">{seat.seatType.toLowerCase()}</p>
                </div>
                <span className="font-semibold text-slate-950">
                  {formatMinorCurrency(seat.priceMinor, seat.currency)}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-center justify-between border-t border-slate-200 pt-4">
            <span className="text-sm font-bold uppercase tracking-wide text-slate-500">Total</span>
            <span className="text-2xl font-black text-slate-950">
              {formatMinorCurrency(view.totalMinor, view.currency)}
            </span>
          </div>
        </section>

        <div className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-900">
            Checkout and payment arrive in Phase 5. No payment is taken and no ticket is
            issued yet — this is a temporary seat hold only.
          </div>
          <button
            type="button"
            disabled
            className={buttonStyles({ size: "lg", className: "mt-4 w-full" })}
          >
            Checkout arrives in Phase 5
          </button>
          {isLive ? (
            <form action={releaseHoldAction.bind(null, view.publicToken)} className="mt-3">
              <button
                type="submit"
                className={buttonStyles({ variant: "ghost", size: "sm", className: "w-full text-red-700" })}
              >
                Release these seats
              </button>
            </form>
          ) : null}
        </div>
      </Container>
    </Section>
  );
}
