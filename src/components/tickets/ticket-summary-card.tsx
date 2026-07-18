import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { ROUTES } from "@/config/site";
import { formatVenueDateTime } from "@/features/events/date-time";
import { ticketEntryLabel } from "@/features/tickets/lifecycle";
import type { CustomerTicketView } from "@/server/tickets/ticket-queries";

const statusStyles = {
  ACTIVE: "bg-emerald-50 text-emerald-800 ring-emerald-600/15",
  USED: "bg-sky-50 text-sky-800 ring-sky-600/15",
  REVOKED: "bg-red-50 text-red-800 ring-red-600/15",
} as const;

export function TicketSummaryCard({ ticket }: { ticket: CustomerTicketView }) {
  return (
    <article className="min-w-0 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words font-black text-slate-950">{ticket.event.title}</p>
          <p className="mt-1 text-sm text-slate-600">
            {formatVenueDateTime(ticket.session.startAt, ticket.session.timeZone)}
          </p>
        </div>
        <Badge className={statusStyles[ticket.status]}>{ticket.status}</Badge>
      </div>
      <p className="mt-4 text-sm font-bold text-slate-950">
        {ticket.seat.sectionName} · Row {ticket.seat.rowLabel} · Seat {ticket.seat.seatLabel}
      </p>
      <p className="mt-1 text-xs text-slate-500">{ticket.session.venueName} · {ticketEntryLabel(ticket.status)}</p>
      <p className="mt-4 break-all font-mono text-xs text-slate-500">Ticket {ticket.publicReference}</p>
      <div className="mt-5 flex justify-end">
        <Link href={ROUTES.customerTicket(ticket.publicReference)} className={buttonStyles({ variant: "outline", size: "sm" })}>
          View ticket
        </Link>
      </div>
    </article>
  );
}
