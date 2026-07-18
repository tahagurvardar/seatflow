import type { Metadata } from "next";
import Link from "next/link";

import { TicketSummaryCard } from "@/components/tickets/ticket-summary-card";
import { buttonStyles } from "@/components/ui/button";
import { Container, Section } from "@/components/ui/container";
import { EmptyState } from "@/components/ui/empty-state";
import { ROUTES } from "@/config/site";
import { requireAuth } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";
import { listCustomerTickets } from "@/server/tickets/ticket-queries";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your tickets" };

export default async function CustomerTicketsPage() {
  const auth = await requireAuth(ROUTES.customerTickets);
  const tickets = await listCustomerTickets(getDatabase(), auth.user.id);
  return (
    <Section className="bg-slate-50">
      <Container>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-700">Secure admission</p>
            <h1 className="mt-3 text-4xl font-black tracking-[-0.05em] text-slate-950 sm:text-5xl">Your tickets</h1>
            <p className="mt-3 max-w-2xl text-slate-600">Each booked seat has its own controlled credential. QR images and PDFs are generated only after ownership checks.</p>
          </div>
          <Link href={ROUTES.customerBookings} className={buttonStyles({ variant: "outline", size: "sm" })}>View bookings</Link>
        </div>
        {tickets.length ? (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {tickets.map((ticket) => <TicketSummaryCard key={ticket.publicReference} ticket={ticket} />)}
          </div>
        ) : (
          <div className="mt-8"><EmptyState icon="ticket" title="No tickets yet" description="Tickets appear after a confirmed booking is issued. A temporary issuance backlog never changes the booking itself." action={<Link href={ROUTES.customerBookings} className={buttonStyles({ size: "sm" })}>View bookings</Link>} /></div>
        )}
      </Container>
    </Section>
  );
}
