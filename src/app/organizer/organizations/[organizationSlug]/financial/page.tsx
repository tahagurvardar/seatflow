import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Container, Section } from "@/components/ui/container";
import { ROUTES } from "@/config/site";
import { formatMinorCurrency } from "@/features/events/money";
import { requireAuth } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";
import {
  getOrganizerFinancialSummary,
  OrganizerFinancialAccessError,
} from "@/server/refunds/organizer-queries";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Financial summary" };

/**
 * Organizer financial summary, scoped to one organization.
 *
 * The slug in the URL is not trusted. It is resolved through the actor's
 * membership, and a slug the actor is not a member of renders as not-found —
 * identical to a slug that does not exist, so tenant existence cannot be probed
 * by changing the URL.
 *
 * There is no control on this page that can move money. Organizers review; they
 * cannot mark a refund successful, fabricate a dispute, or adjust a balance.
 */
export default async function OrganizerFinancialPage({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}) {
  const { organizationSlug } = await params;
  const auth = await requireAuth(ROUTES.organizerFinancial(organizationSlug));

  let summary;
  try {
    summary = await getOrganizerFinancialSummary(getDatabase(), {
      userId: auth.user.id,
      organizationSlug,
    });
  } catch (error) {
    if (error instanceof OrganizerFinancialAccessError) notFound();
    throw error;
  }

  const refundQueue = [
    { label: "Awaiting review", value: summary.refunds.awaitingReview },
    { label: "Processing", value: summary.refunds.processing },
    { label: "Succeeded", value: summary.refunds.succeeded },
    { label: "Failed or review", value: summary.refunds.failedOrReview },
  ];
  const disputeQueue = [
    { label: "Open disputes", value: summary.disputes.open },
    { label: "Lost / chargeback", value: summary.disputes.lost },
    { label: "Requires review", value: summary.disputes.requiresReview },
    { label: "Evidence due < 48h", value: summary.disputes.evidenceDueSoon },
  ];
  const operational = [
    { label: "Tickets pending revocation", value: summary.ticketRevocationBacklog },
    { label: "Financial review queue", value: summary.financialReviewQueue },
  ];

  return (
    <Section className="bg-slate-50">
      <Container>
        <Badge className="bg-slate-900 text-white ring-slate-900/10">Organizer</Badge>
        <h1 className="mt-4 text-4xl font-black tracking-[-0.05em] text-slate-950">
          Financial summary
        </h1>
        <p className="mt-3 max-w-2xl leading-7 text-slate-600">
          {summary.organizationName}. These totals cover only this organization
          and are queried from PostgreSQL at request time. Customer identity and
          payment details are deliberately not shown.
        </p>

        {summary.refundDisputeOverlap ? (
          <div
            role="alert"
            className="mt-8 rounded-3xl border border-amber-300 bg-amber-50 p-6 text-sm leading-6 text-amber-900"
          >
            <p className="font-bold">Refunds and disputes overlap.</p>
            <p className="mt-2">
              This organization has both settled refunds and open disputes. Where
              they cover the same payment, a customer could be compensated twice.
              The platform team reviews these; no action is needed from you.
            </p>
          </div>
        ) : null}

        {[
          { heading: "Refunds", entries: refundQueue },
          { heading: "Disputes", entries: disputeQueue },
          { heading: "Operational", entries: operational },
        ].map((group) => (
          <section key={group.heading} className="mt-10">
            <h2 className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
              {group.heading}
            </h2>
            <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {group.entries.map((entry) => (
                <div
                  key={entry.label}
                  className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
                >
                  <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">
                    {entry.label}
                  </dt>
                  <dd className="mt-3 text-3xl font-black tracking-tight text-slate-950">
                    {entry.value.toLocaleString("en")}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}

        <div className="mt-10 grid gap-4 lg:grid-cols-2">
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500">
              Total refunded by currency
            </h2>
            {summary.refundedByCurrency.length === 0 ? (
              <p className="mt-4 text-sm text-slate-600">No settled refunds.</p>
            ) : (
              <ul className="mt-4 space-y-2">
                {summary.refundedByCurrency.map((row) => (
                  <li
                    key={row.currency}
                    className="flex justify-between text-lg font-bold text-slate-950"
                  >
                    <span className="text-slate-600">{row.currency}</span>
                    <span>{formatMinorCurrency(row.totalMinor, row.currency)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500">
              Disputed amount by currency
            </h2>
            {summary.disputedByCurrency.length === 0 ? (
              <p className="mt-4 text-sm text-slate-600">No open disputes.</p>
            ) : (
              <ul className="mt-4 space-y-2">
                {summary.disputedByCurrency.map((row) => (
                  <li
                    key={row.currency}
                    className="flex justify-between text-lg font-bold text-slate-950"
                  >
                    <span className="text-slate-600">{row.currency}</span>
                    <span>{formatMinorCurrency(row.totalMinor, row.currency)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <p className="mt-8 rounded-3xl border border-slate-200 bg-white p-6 text-sm leading-6 text-slate-600 shadow-sm">
          Refunds are settled only by a cryptographically verified event from the
          payment provider. Nothing on this page, and no organizer action, can
          mark a refund successful, create a dispute, or change a customer&apos;s
          financial state.
        </p>
      </Container>
    </Section>
  );
}
