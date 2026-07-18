import Link from "next/link";

import { HoldCountdown } from "@/components/holds/hold-countdown";
import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { ROUTES } from "@/config/site";
import { formatVenueDateTime } from "@/features/events/date-time";
import { formatMinorCurrency } from "@/features/events/money";
import type { CustomerCheckoutView } from "@/server/payments/checkout-queries";

const stateCopy = {
  PENDING: {
    label: "PAYMENT PENDING",
    title: "Complete payment to confirm your booking",
    detail: "Your seats are still a temporary hold. A verified provider webhook must arrive before SeatFlow can confirm a booking.",
    tone: "bg-amber-50 text-amber-900",
  },
  FAILED: {
    label: "PAYMENT FAILED",
    title: "Payment was not successful",
    detail: "No booking was created and the seats remain governed by the original hold expiry.",
    tone: "bg-red-50 text-red-900",
  },
  CONFIRMED: {
    label: "BOOKING CONFIRMED",
    title: "Your booking is confirmed",
    detail: "SeatFlow received a verified payment webhook and permanently booked these seats.",
    tone: "bg-emerald-50 text-emerald-900",
  },
  REQUIRES_REVIEW: {
    label: "PAYMENT UNDER REVIEW",
    title: "Payment succeeded, but booking needs review",
    detail: "No booking is being claimed. SeatFlow preserved this paid-but-unfulfilled order for protected operations follow-up.",
    tone: "bg-violet-50 text-violet-900",
  },
  EXPIRED: {
    label: "CHECKOUT EXPIRED",
    title: "This checkout has expired",
    detail: "Payment cannot complete from this page. Select available seats again to create a new hold.",
    tone: "bg-slate-100 text-slate-800",
  },
  CANCELLED: {
    label: "PAYMENT CANCELLED",
    title: "Payment was cancelled",
    detail: "No booking was created.",
    tone: "bg-slate-100 text-slate-800",
  },
} as const;

export function CheckoutSummary({ checkout }: { checkout: CustomerCheckoutView }) {
  const state = stateCopy[checkout.displayState];
  return (
    <div>
      <section className={`rounded-3xl p-6 ${state.tone}`} role="status">
        <Badge className="bg-white/70 text-current ring-black/10">{state.label}</Badge>
        <h2 className="mt-4 text-2xl font-black tracking-tight">{state.title}</h2>
        <p className="mt-2 text-sm leading-6">{state.detail}</p>
        {checkout.displayState === "PENDING" ? (
          <p className="mt-4 font-mono text-2xl font-black">
            <HoldCountdown expiresAt={checkout.checkoutExpiresAt} />
          </p>
        ) : null}
        {checkout.bookingReference ? (
          <Link
            href={ROUTES.customerBooking(checkout.bookingReference)}
            className={buttonStyles({ size: "sm", className: "mt-5" })}
          >
            View confirmed booking
          </Link>
        ) : null}
      </section>

      <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="break-words text-xl font-black text-slate-950">{checkout.event.title}</h2>
        <p className="mt-2 text-sm text-slate-600">
          {formatVenueDateTime(checkout.session.startAt, checkout.session.timeZone)}
        </p>
        <p className="mt-1 text-sm text-slate-500">
          {checkout.session.venueName} · {checkout.session.spaceName} · {checkout.session.city}
        </p>
        <ul className="mt-5 divide-y divide-slate-100">
          {checkout.seats.map((seat) => (
            <li key={seat.inventoryId} className="flex items-start justify-between gap-4 py-3">
              <div>
                <p className="font-bold text-slate-950">
                  {seat.sectionName} · Row {seat.rowLabel} · Seat {seat.seatLabel}
                </p>
                <p className="mt-1 text-xs text-slate-500">{seat.tierName}</p>
              </div>
              <span className="font-semibold text-slate-950">
                {formatMinorCurrency(seat.priceMinor, seat.currency)}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex items-center justify-between border-t border-slate-200 pt-4">
          <span className="text-sm font-bold uppercase tracking-wide text-slate-500">Official total</span>
          <span className="text-2xl font-black text-slate-950">
            {formatMinorCurrency(checkout.totalMinor, checkout.currency)}
          </span>
        </div>
      </section>
    </div>
  );
}
