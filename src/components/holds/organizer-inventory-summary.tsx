import { formatVenueDateTime } from "@/features/events/date-time";
import type { OrganizerInventorySummary as OrganizerInventorySummaryView } from "@/features/holds/view-models";

export function OrganizerInventorySummary({
  summary,
  timeZone,
}: {
  summary: OrganizerInventorySummaryView;
  timeZone: string;
}) {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div>
        <h2 className="text-xl font-black text-slate-950">Live inventory</h2>
        <p className="mt-1 text-sm text-slate-600">
          Read-only availability from the authoritative session inventory. Holds are
          temporary reservations awaiting checkout — never sales, and no customer
          identities are shown.
        </p>
      </div>

      {summary.total > 0 ? (
        <>
          <dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Sellable inventory", summary.total],
              ["Available", summary.available],
              ["Currently held", summary.held],
              ["Active holds", summary.activeHolds],
            ].map(([label, value]) => (
              <div key={label} className="rounded-2xl border border-slate-200 p-4">
                <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">
                  {label}
                </dt>
                <dd className="mt-2 text-2xl font-black text-slate-950">{value}</dd>
              </div>
            ))}
          </dl>
          {summary.earliestHoldExpiresAt ? (
            <p className="mt-3 text-xs text-slate-500">
              Earliest active hold expires{" "}
              {formatVenueDateTime(summary.earliestHoldExpiresAt, timeZone)}.
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-4 rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">
          Authoritative inventory is materialized when this session is published.
        </p>
      )}
    </section>
  );
}
