import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Container, Section } from "@/components/ui/container";
import { ROUTES } from "@/config/site";
import { formatVenueDateTime } from "@/features/events/date-time";
import { formatMinorCurrency } from "@/features/events/money";
import { requireAuth } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";
import { getCustomerBookingByReference } from "@/server/payments/booking-queries";
import { CheckoutAuthorizationError } from "@/server/payments/errors";
import { listCustomerBookingTickets } from "@/server/tickets/ticket-queries";
import { TicketSummaryCard } from "@/components/tickets/ticket-summary-card";
import { PdfDownloadButton } from "@/components/tickets/pdf-download-button";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Booking detail" };

export default async function BookingDetailPage({ params }: { params: Promise<{ bookingReference: string }> }) {
  const { bookingReference } = await params;
  const path = ROUTES.customerBooking(bookingReference);
  const auth = await requireAuth(path);
  let booking;
  try {
    booking = await getCustomerBookingByReference(getDatabase(), { userId: auth.user.id }, bookingReference);
  } catch (error) {
    if (error instanceof CheckoutAuthorizationError) notFound();
    throw error;
  }
  const tickets = await listCustomerBookingTickets(getDatabase(), {
    userId: auth.user.id,
    bookingReference,
  });
  return (
    <Section className="bg-slate-50">
      <Container className="max-w-3xl">
        <nav className="text-sm text-slate-500"><Link href={ROUTES.customerBookings} className="hover:text-slate-950">Bookings</Link> / Detail</nav>
        <header className="mt-5 rounded-[2rem] bg-slate-950 p-7 text-white sm:p-9">
          <Badge className="bg-emerald-500/15 text-emerald-200 ring-emerald-400/20">CONFIRMED BOOKING</Badge>
          <h1 className="mt-4 break-words text-3xl font-black tracking-[-0.04em] sm:text-4xl">{booking.event.title}</h1>
          <p className="mt-3 text-slate-300">{formatVenueDateTime(booking.session.startAt, booking.session.timeZone)}</p>
          <p className="mt-1 text-slate-400">{booking.session.venueName} · {booking.session.spaceName} · {booking.session.city}</p>
        </header>
        <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap gap-2"><Badge className="bg-emerald-50 text-emerald-800 ring-emerald-600/15">Payment {booking.paymentStatus}</Badge><Badge className="bg-slate-100 text-slate-700 ring-slate-600/10">{booking.seats.length} {booking.seats.length === 1 ? "seat" : "seats"}</Badge></div>
          <ul className="mt-5 divide-y divide-slate-100">
            {booking.seats.map((seat) => (
              <li key={`${seat.sectionCode}-${seat.rowLabel}-${seat.seatLabel}`} className="flex items-start justify-between gap-4 py-3">
                <div><p className="font-bold text-slate-950">{seat.sectionName} · Row {seat.rowLabel} · Seat {seat.seatLabel}</p><p className="mt-1 text-xs text-slate-500">{seat.tierName}</p></div>
                <span className="font-semibold text-slate-950">{formatMinorCurrency(seat.priceMinor, seat.currency)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-center justify-between border-t border-slate-200 pt-4"><span className="text-sm font-bold uppercase tracking-wide text-slate-500">Confirmed total</span><span className="text-2xl font-black text-slate-950">{formatMinorCurrency(booking.totalMinor, booking.currency)}</span></div>
        </section>
        <section className="mt-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-xs font-bold uppercase tracking-wide text-emerald-700">Issued credentials</p><h2 className="mt-1 text-2xl font-black text-slate-950">Tickets</h2></div>{tickets.length ? <PdfDownloadButton bookingReference={booking.publicReference} size="sm" /> : null}</div>
          {tickets.length ? <div className="mt-4 grid gap-4 sm:grid-cols-2">{tickets.map((ticket) => <TicketSummaryCard key={ticket.publicReference} ticket={ticket} />)}</div> : <p className="mt-4 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900">This confirmed booking is waiting for secure ticket issuance. The booking remains valid while operations retries the idempotent issuance request.</p>}
        </section>
      </Container>
    </Section>
  );
}
