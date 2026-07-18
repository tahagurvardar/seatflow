import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  retryPaymentInitializationAction,
  simulateLocalPaymentAction,
} from "@/app/customer/checkout-actions";
import { CheckoutSummary } from "@/components/checkout/checkout-summary";
import { PendingSubmitButton } from "@/components/checkout/pending-submit-button";
import { SimulatedPaymentWarning } from "@/components/checkout/simulated-payment-warning";
import { buttonStyles } from "@/components/ui/button";
import { Container, Section } from "@/components/ui/container";
import { ROUTES } from "@/config/site";
import { requireAuth } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";
import { getCustomerCheckoutByReference } from "@/server/payments/checkout-queries";
import { CheckoutAuthorizationError } from "@/server/payments/errors";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Secure checkout" };

export default async function CheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderReference: string }>;
  searchParams: Promise<{ error?: string; providerReturn?: string }>;
}) {
  const { orderReference } = await params;
  const notices = await searchParams;
  const path = ROUTES.customerCheckout(orderReference);
  const auth = await requireAuth(path);
  let checkout;
  try {
    checkout = await getCustomerCheckoutByReference(
      getDatabase(),
      { userId: auth.user.id },
      orderReference,
    );
  } catch (error) {
    if (error instanceof CheckoutAuthorizationError) notFound();
    throw error;
  }

  const pending = checkout.displayState === "PENDING";
  return (
    <Section className="bg-slate-50">
      <Container className="max-w-3xl">
        <nav className="text-sm text-slate-500">
          <Link href={ROUTES.customerDashboard} className="hover:text-slate-950">Dashboard</Link> / Checkout
        </nav>
        <header className="mt-5 rounded-[2rem] bg-slate-950 p-7 text-white sm:p-9">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-300">Server-owned checkout</p>
          <h1 className="mt-3 text-3xl font-black tracking-[-0.04em] sm:text-4xl">Secure checkout</h1>
          <p className="mt-3 text-sm text-slate-300">Prices, seats, currency, payment state, and booking state come from PostgreSQL.</p>
        </header>

        {notices.error ? <p className="mt-5 rounded-2xl bg-red-50 p-4 text-sm text-red-800" role="alert">{notices.error}</p> : null}
        {notices.providerReturn && pending ? (
          <p className="mt-5 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900">
            Provider flow returned. Payment remains pending until a verified webhook creates the booking.
          </p>
        ) : null}

        <div className="mt-6"><CheckoutSummary checkout={checkout} /></div>

        {pending ? (
          <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            {checkout.simulatedProvider ? (
              <SimulatedPaymentWarning />
            ) : null}
            {!checkout.payment?.initialized ? (
              <form action={retryPaymentInitializationAction.bind(null, orderReference)} className="mt-4">
                <PendingSubmitButton pendingLabel="Initializing…" className="w-full">Retry payment initialization</PendingSubmitButton>
              </form>
            ) : checkout.simulatedProvider ? (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <form action={simulateLocalPaymentAction.bind(null, orderReference, "success")}>
                  <PendingSubmitButton pendingLabel="Sending signed webhook…" className="w-full">Simulate successful payment</PendingSubmitButton>
                </form>
                <form action={simulateLocalPaymentAction.bind(null, orderReference, "failure")}>
                  <PendingSubmitButton pendingLabel="Sending signed webhook…" variant="outline" className="w-full">Simulate failed payment</PendingSubmitButton>
                </form>
              </div>
            ) : (
              <p className="mt-4 text-sm text-slate-600">Continue in the payment provider’s hosted checkout. This page will show confirmation only after SeatFlow records the verified webhook and booking.</p>
            )}
          </section>
        ) : null}

        {checkout.displayState === "EXPIRED" || checkout.displayState === "FAILED" ? (
          <Link href={ROUTES.eventSessionSeats(checkout.event.publicSlug, checkout.session.id)} className={buttonStyles({ variant: "outline", size: "sm", className: "mt-6" })}>Choose available seats again</Link>
        ) : null}
      </Container>
    </Section>
  );
}
