import type { SupportedCurrency } from "@/config/site";
import type { BookingPaymentSummary as Summary } from "@/features/bookings/payment-summary";
import { formatMinorCurrency } from "@/features/events/money";

/**
 * Booking total, refunded amount and net paid, read together.
 *
 * Without refunds this is the original single total row. With refunds it adds
 * the settled refund and the resulting net; an in-flight refund is described as
 * in progress and is never subtracted, because no money has moved yet.
 */
export function BookingPaymentSummary({
  summary,
  currency,
}: {
  summary: Summary;
  currency: SupportedCurrency;
}) {
  const format = (value: number) => formatMinorCurrency(value, currency);
  const hasRefunds = summary.refundState !== "NONE";

  return (
    <div className="mt-4 border-t border-slate-200 pt-4">
      <dl className="space-y-2">
        <div className="flex items-center justify-between">
          <dt className="text-sm font-bold uppercase tracking-wide text-slate-500">
            {hasRefunds ? "Paid" : "Confirmed total"}
          </dt>
          <dd className={hasRefunds ? "text-lg font-black text-slate-950" : "text-2xl font-black text-slate-950"}>
            {format(summary.paidMinor)}
          </dd>
        </div>
        {hasRefunds ? (
          <>
            <div className="flex items-center justify-between">
              <dt className="text-sm font-bold uppercase tracking-wide text-slate-500">Refunded</dt>
              <dd className="text-lg font-black text-slate-950">−{format(summary.refundedMinor)}</dd>
            </div>
            <div className="flex items-center justify-between border-t border-slate-200 pt-2">
              <dt className="text-sm font-bold uppercase tracking-wide text-slate-500">Net paid</dt>
              <dd className="text-2xl font-black text-slate-950">{format(summary.netPaidMinor)}</dd>
            </div>
          </>
        ) : null}
      </dl>
      {summary.refundInProgress ? (
        <p className="mt-3 rounded-2xl bg-sky-50 p-3 text-sm text-sky-900">
          A refund of {format(summary.inFlightMinor)} is in progress. It is not included above until
          your payment provider confirms it.
        </p>
      ) : null}
    </div>
  );
}
