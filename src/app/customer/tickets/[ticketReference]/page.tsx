import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PdfDownloadButton } from "@/components/tickets/pdf-download-button";
import { Badge } from "@/components/ui/badge";
import { Container, Section } from "@/components/ui/container";
import { ROUTES } from "@/config/site";
import { formatVenueDateTime } from "@/features/events/date-time";
import { ticketEntryLabel } from "@/features/tickets/lifecycle";
import { requireAuth } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";
import { getCustomerTicketByReference } from "@/server/tickets/ticket-queries";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Ticket detail" };

export default async function CustomerTicketDetailPage({
  params,
}: {
  params: Promise<{ ticketReference: string }>;
}) {
  const { ticketReference } = await params;
  const path = ROUTES.customerTicket(ticketReference);
  const auth = await requireAuth(path);
  const ticket = await getCustomerTicketByReference(getDatabase(), {
    userId: auth.user.id,
    publicReference: ticketReference,
  });
  if (!ticket) notFound();
  return (
    <Section className="bg-slate-50">
      <Container className="max-w-5xl">
        <nav className="text-sm text-slate-500"><Link href={ROUTES.customerTickets} className="hover:text-slate-950">Tickets</Link> / Detail</nav>
        <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0">
            <header className="rounded-[2rem] bg-slate-950 p-7 text-white sm:p-9">
              <Badge className={ticket.status === "ACTIVE" ? "bg-emerald-500/15 text-emerald-200 ring-emerald-400/20" : ticket.status === "USED" ? "bg-sky-500/15 text-sky-200 ring-sky-400/20" : "bg-red-500/15 text-red-200 ring-red-400/20"}>{ticket.status}</Badge>
              <h1 className="mt-4 break-words text-3xl font-black tracking-[-0.04em] sm:text-4xl">{ticket.event.title}</h1>
              <p className="mt-3 text-slate-300">{formatVenueDateTime(ticket.session.startAt, ticket.session.timeZone)}</p>
              <p className="mt-1 text-slate-400">{ticket.session.venueName} · {ticket.session.spaceName} · {ticket.session.city}</p>
            </header>
            <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Assigned seat</p>
              <p className="mt-2 text-2xl font-black text-slate-950">{ticket.seat.sectionName} · Row {ticket.seat.rowLabel} · Seat {ticket.seat.seatLabel}</p>
              <p className="mt-1 text-sm text-slate-500">{ticket.seat.tierName}</p>
              <dl className="mt-6 grid gap-4 sm:grid-cols-2">
                <div><dt className="text-xs font-bold uppercase tracking-wide text-slate-500">Ticket reference</dt><dd className="mt-1 break-all font-mono text-sm text-slate-900">{ticket.publicReference}</dd></div>
                <div><dt className="text-xs font-bold uppercase tracking-wide text-slate-500">Entry</dt><dd className="mt-1 font-bold text-slate-900">{ticketEntryLabel(ticket.status)}</dd></div>
              </dl>
              {ticket.status === "REVOKED" ? <p className="mt-5 rounded-2xl bg-red-50 p-4 text-sm text-red-800">This ticket is revoked and cannot be used for entry. {ticket.revocationReason ? `Reason: ${ticket.revocationReason}` : "Contact the organizer for help."}</p> : null}
              {ticket.status === "USED" ? <p className="mt-5 rounded-2xl bg-sky-50 p-4 text-sm text-sky-800">Entry has already been accepted for this ticket. Its credential cannot be rotated or reused.</p> : null}
              <div className="mt-6"><PdfDownloadButton bookingReference={ticket.bookingReference} /></div>
            </section>
          </div>
          <aside className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm lg:sticky lg:top-24 lg:self-start">
            <h2 className="text-lg font-black text-slate-950">Entry QR</h2>
            {ticket.status === "ACTIVE" && ticket.credentialAvailable ? (
              <>
                <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white p-2">
                  <Image unoptimized src={ROUTES.customerTicketQr(ticket.publicReference)} alt={`Entry QR for ticket ${ticket.publicReference}`} width={512} height={512} className="h-auto w-full" priority />
                </div>
                <p className="mt-4 text-sm text-slate-600">Show this code at entry. Validation requires a network connection to SeatFlow.</p>
              </>
            ) : (
              <div className="mt-4 rounded-2xl bg-slate-100 p-5 text-sm text-slate-700">The QR is unavailable because this ticket is {ticket.status.toLowerCase()}.</div>
            )}
          </aside>
        </div>
      </Container>
    </Section>
  );
}
