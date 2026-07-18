import { formatMinorCurrency } from "@/features/events/money";
import type { OrganizerBookingSummary as OrganizerBookingSummaryView } from "@/server/payments/booking-queries";

export function OrganizerBookingSummary({ summary }: { summary: OrganizerBookingSummaryView }) {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-xl font-black text-slate-950">Booking summary</h2>
      <p className="mt-1 text-sm text-slate-600">Read-only confirmed commerce totals. No payment method or unnecessary customer identity is exposed.</p>
      <dl className="mt-5 grid gap-3 sm:grid-cols-3">
        {[
          ["Confirmed bookings", summary.confirmedBookingCount],
          ["Booked seats", summary.bookedSeatCount],
          ["Paid — review required", summary.paidUnfulfilledReviewCount],
        ].map(([label, value]) => (
          <div key={label} className="rounded-2xl bg-slate-50 p-4"><dt className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</dt><dd className="mt-2 font-mono text-2xl font-black text-slate-950">{value}</dd></div>
        ))}
      </dl>
      <div className="mt-4 rounded-2xl bg-emerald-50 p-4">
        <p className="text-xs font-bold uppercase tracking-wide text-emerald-800">Gross confirmed by currency</p>
        {summary.grossByCurrency.length ? <ul className="mt-2 flex flex-wrap gap-3">{summary.grossByCurrency.map((entry) => <li key={entry.currency} className="font-mono font-bold text-emerald-950">{formatMinorCurrency(entry.totalMinor, entry.currency)}</li>)}</ul> : <p className="mt-2 text-sm text-emerald-900">No confirmed revenue yet.</p>}
      </div>
    </section>
  );
}

