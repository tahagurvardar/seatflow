import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { ROUTES } from "@/config/site";
import { bookingStatusLabel, summarizeBookingPayment } from "@/features/bookings/payment-summary";
import { formatVenueDateTime } from "@/features/events/date-time";
import { formatMinorCurrency } from "@/features/events/money";
import type { CustomerBookingView } from "@/server/payments/booking-queries";

const refundStateStyles = {
  NONE: "bg-emerald-50 text-emerald-800 ring-emerald-600/15",
  PARTIAL: "bg-sky-50 text-sky-800 ring-sky-600/15",
  FULL: "bg-amber-50 text-amber-800 ring-amber-600/15",
} as const;

export function BookingSummaryCard({ booking }: { booking: CustomerBookingView }) {
  const summary = summarizeBookingPayment({ bookingStatus: booking.status, figures: booking.payment });
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="break-words font-bold text-slate-950">{booking.event.title}</p>
          <p className="mt-1 text-sm text-slate-600">
            {formatVenueDateTime(booking.session.startAt, booking.session.timeZone)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {booking.session.venueName} · {booking.seats.length} {booking.seats.length === 1 ? "seat" : "seats"} · {formatMinorCurrency(booking.totalMinor, booking.currency)}
          </p>
        </div>
        <Badge className={refundStateStyles[summary.refundState]}>
          {bookingStatusLabel(summary.refundState).toUpperCase()}
        </Badge>
      </div>
      <div className="mt-4 flex justify-end">
        <Link href={ROUTES.customerBooking(booking.publicReference)} className={buttonStyles({ variant: "outline", size: "sm" })}>
          View booking
        </Link>
      </div>
    </article>
  );
}
