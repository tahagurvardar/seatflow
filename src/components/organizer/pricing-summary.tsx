import { Badge } from "@/components/ui/badge";
import { formatMinorCurrency } from "@/features/events/money";
import type { SupportedCurrency } from "@/config/site";

interface PricingSummaryProps {
  tiers: Array<{
    id: string;
    name: string;
    code: string;
    priceMinor: number;
    currency: SupportedCurrency;
    sellableCapacity: number;
  }>;
  totalSellable: number;
  pricedSellable: number;
  unpricedSellable: number;
}

export function PricingSummary({
  tiers,
  totalSellable,
  pricedSellable,
  unpricedSellable,
}: PricingSummaryProps) {
  return (
    <div>
      <dl className="grid gap-3 sm:grid-cols-3">
        {[
          ["Total sellable", totalSellable],
          ["Priced", pricedSellable],
          ["Unpriced", unpricedSellable],
        ].map(([label, value]) => (
          <div key={label} className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
            <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</dt>
            <dd className="mt-1 font-mono text-2xl font-black text-slate-950">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-5 space-y-3">
        {tiers.map((tier) => (
          <article key={tier.id} className="flex flex-col gap-3 rounded-2xl border border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2"><h3 className="font-bold text-slate-950">{tier.name}</h3><Badge className="bg-slate-100 text-slate-700 ring-slate-500/15">{tier.code}</Badge></div>
              <p className="mt-1 text-sm text-slate-600">{formatMinorCurrency(tier.priceMinor, tier.currency)}</p>
            </div>
            <p className="font-mono text-sm font-bold text-slate-700">{tier.sellableCapacity} seats</p>
          </article>
        ))}
      </div>
    </div>
  );
}
