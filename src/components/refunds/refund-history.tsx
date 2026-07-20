import type { SupportedCurrency } from "@/config/site";
import { formatMinorCurrency } from "@/features/events/money";

/**
 * Customer-visible refund history.
 *
 * Statuses are shown honestly: a refund that has been requested is described as
 * requested, not as money already returned. No provider identifier, internal
 * idempotency key, webhook detail, or dispute evidence appears here.
 */

export interface RefundHistoryEntry {
  publicReference: string;
  status: string;
  scope: string;
  requestedAmountMinor: number;
  currency: SupportedCurrency;
  requestedAt: string;
  succeededAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  reviewRequiredAt: string | null;
}

const STATUS_PRESENTATION: Record<
  string,
  { label: string; description: string; className: string }
> = {
  REQUESTED: {
    label: "Requested",
    description: "We have your request and are sending it to your payment provider.",
    className: "bg-slate-100 text-slate-800 ring-slate-600/10",
  },
  SUBMITTING: {
    label: "Processing",
    description: "Your request is being sent to your payment provider.",
    className: "bg-sky-50 text-sky-900 ring-sky-600/15",
  },
  PROCESSING: {
    label: "Processing",
    description:
      "Your payment provider is processing this refund. We will update this page once they confirm it.",
    className: "bg-sky-50 text-sky-900 ring-sky-600/15",
  },
  SUCCEEDED: {
    label: "Succeeded",
    description:
      "Your provider has confirmed this refund. It may take a few days to appear on your statement.",
    className: "bg-emerald-50 text-emerald-900 ring-emerald-600/15",
  },
  FAILED: {
    label: "Failed",
    description:
      "This refund did not go through and no money was taken back. You can request it again.",
    className: "bg-rose-50 text-rose-900 ring-rose-600/15",
  },
  CANCELLED: {
    label: "Cancelled",
    description: "This refund request was cancelled.",
    className: "bg-slate-100 text-slate-700 ring-slate-600/10",
  },
  REQUIRES_REVIEW: {
    label: "Requires review",
    description:
      "This refund needs a manual check by our team. We will contact you; nothing further is needed from you.",
    className: "bg-amber-50 text-amber-900 ring-amber-600/15",
  },
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

export function RefundHistory({ refunds }: { refunds: RefundHistoryEntry[] }) {
  if (refunds.length === 0) {
    return (
      <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-2xl font-black text-slate-950">Refund history</h2>
        <p className="mt-3 text-sm text-slate-600">
          You have not requested a refund for this booking.
        </p>
      </section>
    );
  }

  return (
    <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-2xl font-black text-slate-950">Refund history</h2>
      <ul className="mt-5 space-y-4">
        {refunds.map((refund) => {
          const presentation =
            STATUS_PRESENTATION[refund.status] ?? STATUS_PRESENTATION.REQUESTED!;
          return (
            <li
              key={refund.publicReference}
              className="rounded-2xl border border-slate-200 p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <span
                    className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ring-1 ring-inset ${presentation.className}`}
                  >
                    {presentation.label}
                  </span>
                  <p className="mt-2 text-sm text-slate-600">
                    Requested {formatDate(refund.requestedAt)}
                    {refund.scope === "SELECTED_SEATS" ? " · selected seats" : " · whole booking"}
                  </p>
                </div>
                <span className="text-xl font-black text-slate-950">
                  {formatMinorCurrency(refund.requestedAmountMinor, refund.currency)}
                </span>
              </div>
              <p className="mt-3 text-sm text-slate-700">{presentation.description}</p>
              {refund.succeededAt ? (
                <p className="mt-2 text-xs text-slate-500">
                  Confirmed by your provider on {formatDate(refund.succeededAt)}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
