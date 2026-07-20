import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import { Container } from "@/components/ui/container";
import { ROUTES } from "@/config/site";
import { requirePlatformAdmin } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";
import { collectFinancialProbes } from "@/server/operations/financial-probes";
import {
  reportDisputeBacklog,
  reportRefundBacklog,
} from "@/server/refunds/reconciliation-service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Financial operations",
  description: "SeatFlow refund, dispute, and reconciliation queues.",
};

/**
 * Platform-admin financial operations.
 *
 * Everything shown is a bounded aggregate queried from PostgreSQL at request
 * time. Deliberately absent: provider identifiers, refund and booking
 * references, customer identity, raw provider payloads, webhook signatures, and
 * credentials of any kind. An operator can screenshot this page into a ticket
 * without leaking anything.
 *
 * There is intentionally no control here that adjusts money. Refund settlement
 * belongs to verified provider webhooks, and the reconciliation commands are
 * deliberately CLI-only so every financial action is an audited, deliberate act.
 */

function formatMinor(amountMinor: number, currency: string) {
  return new Intl.NumberFormat("en", { style: "currency", currency }).format(amountMinor / 100);
}

export default async function AdminFinancialPage() {
  const { user } = await requirePlatformAdmin(ROUTES.admin);
  const database = getDatabase();
  const now = new Date();

  const [refunds, disputes, probes, refundedByCurrency, disputedByCurrency, paidUnfulfilled] =
    await Promise.all([
      reportRefundBacklog(database, now),
      reportDisputeBacklog(database, now),
      collectFinancialProbes(database, { now }),
      database.refund.groupBy({
        by: ["currency"],
        where: { succeededAt: { not: null } },
        _sum: { requestedAmountMinor: true },
      }),
      database.paymentDispute.groupBy({
        by: ["currency"],
        where: { status: { notIn: ["WON"] } },
        _sum: { disputedAmountMinor: true },
      }),
      database.checkoutOrder.count({
        where: { status: { in: ["PAID_UNFULFILLED", "REQUIRES_REVIEW"] } },
      }),
    ]);

  const refundQueue = [
    { label: "Requested", value: refunds.requested },
    { label: "Submitting", value: refunds.submitting },
    { label: "Processing", value: refunds.processing },
    { label: "Requires review", value: refunds.requiresReview },
    { label: "Failed", value: refunds.failed },
  ];

  const disputeQueue = [
    { label: "Open", value: disputes.open },
    { label: "Needs response", value: disputes.needsResponse },
    { label: "Under review", value: disputes.underReview },
    { label: "Lost / chargeback", value: disputes.lost },
    { label: "Requires review", value: disputes.requiresReview },
    { label: "Evidence due < 48h", value: disputes.evidenceDueWithin48Hours },
  ];

  const integrity = [
    {
      label: "Ledger divergence",
      value: probes.financialDivergences,
      caution: (probes.financialDivergences ?? 0) > 0,
    },
    {
      label: "Reconciliation backlog",
      value: probes.refundReconciliationBacklog,
      caution: (probes.refundReconciliationBacklog ?? 0) > 0,
    },
    {
      label: "Unresolved chargebacks",
      value: probes.unresolvedChargebacks,
      caution: (probes.unresolvedChargebacks ?? 0) > 0,
    },
    {
      label: "Ticket revocation backlog",
      value: probes.ticketRevocationBacklog,
      caution: (probes.ticketRevocationBacklog ?? 0) > 0,
    },
    { label: "Paid but unfulfilled", value: paidUnfulfilled, caution: paidUnfulfilled > 0 },
  ];

  return (
    <section className="bg-slate-950 py-14 text-white sm:py-20">
      <Container>
        <Badge className="bg-orange-500/15 text-orange-200 ring-orange-400/20">
          Platform administrator
        </Badge>
        <h1 className="mt-4 text-4xl font-black tracking-[-0.05em] sm:text-5xl">
          Financial operations
        </h1>
        <p className="mt-3 max-w-2xl leading-7 text-slate-300">
          Signed in as {user.email}. Every figure is an aggregate queried from
          PostgreSQL at request time. No provider identifier, customer record, or
          credential appears on this page.
        </p>

        {probes.failures.length > 0 ? (
          <div
            role="alert"
            className="mt-8 rounded-3xl border border-amber-400/30 bg-amber-500/10 p-6 text-sm leading-6 text-amber-100"
          >
            <p className="font-bold">Some probes could not be evaluated.</p>
            <p className="mt-2">
              {probes.failures.join(", ")} returned no result. Treat those figures
              as unknown rather than zero, and resolve the probe failure before
              trusting this page.
            </p>
          </div>
        ) : null}

        <h2 className="mt-12 text-xs font-bold uppercase tracking-[0.14em] text-slate-400">
          Refund queue
        </h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {refundQueue.map((entry) => (
            <div
              key={entry.label}
              className="rounded-3xl border border-white/10 bg-white/5 p-6"
            >
              <dt className="text-xs font-bold uppercase tracking-[0.14em] text-slate-400">
                {entry.label}
              </dt>
              <dd className="mt-4 text-4xl font-black tracking-tight">
                {entry.value.toLocaleString("en")}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-sm text-slate-400">
          Oldest unsettled refund:{" "}
          {refunds.oldestPendingAgeSeconds === null
            ? "none"
            : `${Math.floor(refunds.oldestPendingAgeSeconds / 60)} minutes`}
        </p>

        <h2 className="mt-12 text-xs font-bold uppercase tracking-[0.14em] text-slate-400">
          Dispute and chargeback queue
        </h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
          {disputeQueue.map((entry) => (
            <div
              key={entry.label}
              className="rounded-3xl border border-white/10 bg-white/5 p-6"
            >
              <dt className="text-xs font-bold uppercase tracking-[0.14em] text-slate-400">
                {entry.label}
              </dt>
              <dd className="mt-4 text-4xl font-black tracking-tight">
                {entry.value.toLocaleString("en")}
              </dd>
            </div>
          ))}
        </dl>

        <h2 className="mt-12 text-xs font-bold uppercase tracking-[0.14em] text-slate-400">
          Integrity and reconciliation
        </h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {integrity.map((entry) => (
            <div
              key={entry.label}
              className={`rounded-3xl border p-6 ${
                entry.caution
                  ? "border-amber-400/30 bg-amber-500/10"
                  : "border-white/10 bg-white/5"
              }`}
            >
              <dt className="text-xs font-bold uppercase tracking-[0.14em] text-slate-400">
                {entry.label}
              </dt>
              <dd className="mt-4 text-4xl font-black tracking-tight">
                {entry.value === null ? "unknown" : entry.value.toLocaleString("en")}
              </dd>
            </div>
          ))}
        </dl>

        <div className="mt-12 grid gap-4 lg:grid-cols-2">
          <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
            <h2 className="text-xs font-bold uppercase tracking-[0.14em] text-slate-400">
              Total refunded by currency
            </h2>
            {refundedByCurrency.length === 0 ? (
              <p className="mt-4 text-sm text-slate-400">No settled refunds.</p>
            ) : (
              <ul className="mt-4 space-y-2">
                {refundedByCurrency.map((row) => (
                  <li key={row.currency} className="flex justify-between text-lg font-bold">
                    <span className="text-slate-300">{row.currency}</span>
                    <span>
                      {formatMinor(row._sum.requestedAmountMinor ?? 0, row.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
            <h2 className="text-xs font-bold uppercase tracking-[0.14em] text-slate-400">
              Disputed amount by currency
            </h2>
            {disputedByCurrency.length === 0 ? (
              <p className="mt-4 text-sm text-slate-400">No open disputes.</p>
            ) : (
              <ul className="mt-4 space-y-2">
                {disputedByCurrency.map((row) => (
                  <li key={row.currency} className="flex justify-between text-lg font-bold">
                    <span className="text-slate-300">{row.currency}</span>
                    <span>
                      {formatMinor(row._sum.disputedAmountMinor ?? 0, row.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="mt-8 rounded-3xl border border-white/10 bg-white/5 p-6 text-sm leading-6 text-slate-300">
          There is no financial adjustment control on this page by design. A
          refund is settled only by a cryptographically verified provider
          webhook, and reconciliation runs through audited command-line
          operations. Nothing here can mark a refund successful, fabricate a
          dispute, reopen inventory, or rewrite financial history.
        </div>
      </Container>
    </section>
  );
}
