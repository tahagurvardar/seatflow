import Link from "next/link";

import { buttonStyles } from "@/components/ui/button";
import { ROUTES } from "@/config/site";
import type { getOrganizerTicketSummary } from "@/server/tickets/ticket-queries";

type Summary = NonNullable<Awaited<ReturnType<typeof getOrganizerTicketSummary>>>;

export function OrganizerTicketSummary({
  summary,
  scope,
  canScan,
}: {
  summary: Summary;
  scope: { organizationSlug: string; eventSlug: string; sessionId: string };
  canScan: boolean;
}) {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div><h2 className="text-xl font-black text-slate-950">Ticket operations</h2><p className="mt-1 text-sm text-slate-600">Aggregate admission state only. Credentials and customer identities are never listed.</p></div>
        {canScan ? <Link href={ROUTES.organizerScanner(scope.organizationSlug, scope.eventSlug, scope.sessionId)} className={buttonStyles({ size: "sm" })}>Open scanner</Link> : null}
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ["Issued", summary.confirmed],
          ["Active", summary.active],
          ["Used", summary.used],
          ["Revoked", summary.revoked],
          ["Issuance backlog", summary.issuanceBacklog],
          ["Email backlog", summary.notificationBacklog],
        ].map(([label, value]) => <div key={label} className="min-w-0 rounded-2xl bg-slate-50 p-4"><dt className="break-words text-xs font-bold uppercase tracking-wide text-slate-500">{label}</dt><dd className="mt-2 font-mono text-2xl font-black text-slate-950">{value}</dd></div>)}
      </dl>
      <div className="mt-4 rounded-2xl bg-slate-50 p-4"><p className="text-xs font-bold uppercase tracking-wide text-slate-500">Redemption outcomes</p>{summary.recentOutcomes.length ? <ul className="mt-2 flex flex-wrap gap-2">{summary.recentOutcomes.map((entry) => <li key={entry.outcome} className="rounded-full bg-white px-3 py-1 font-mono text-xs font-bold text-slate-700 ring-1 ring-slate-200">{entry.outcome}: {entry.count}</li>)}</ul> : <p className="mt-2 text-sm text-slate-600">No scans recorded.</p>}</div>
    </section>
  );
}
