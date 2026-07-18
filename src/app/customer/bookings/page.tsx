import type { Metadata } from "next";
import Link from "next/link";

import { BookingSummaryCard } from "@/components/bookings/booking-summary-card";
import { buttonStyles } from "@/components/ui/button";
import { Container, Section } from "@/components/ui/container";
import { EmptyState } from "@/components/ui/empty-state";
import { ROUTES } from "@/config/site";
import { requireAuth } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";
import { listCustomerBookings } from "@/server/payments/booking-queries";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your bookings" };

export default async function CustomerBookingsPage() {
  const auth = await requireAuth(ROUTES.customerBookings);
  const bookings = await listCustomerBookings(getDatabase(), auth.user.id);
  return (
    <Section className="bg-slate-50">
      <Container>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-700">Confirmed bookings</p>
            <h1 className="mt-3 text-4xl font-black tracking-[-0.05em] text-slate-950 sm:text-5xl">Your bookings</h1>
            <p className="mt-3 text-slate-600">Confirmed seats and immutable prices. QR tickets are not part of this phase.</p>
          </div>
          <Link href={ROUTES.events} className={buttonStyles({ variant: "outline", size: "sm" })}>Browse events</Link>
        </div>
        {bookings.length ? (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {bookings.map((booking) => <BookingSummaryCard key={booking.publicReference} booking={booking} />)}
          </div>
        ) : (
          <div className="mt-8"><EmptyState icon="ticket" title="No confirmed bookings" description="A booking appears only after SeatFlow verifies a successful payment webhook and atomically books the held seats." action={<Link href={ROUTES.events} className={buttonStyles({ size: "sm" })}>Browse events</Link>} /></div>
        )}
      </Container>
    </Section>
  );
}

