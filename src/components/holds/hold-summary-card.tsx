import Link from "next/link";

import { HoldCountdown } from "@/components/holds/hold-countdown";
import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { ROUTES } from "@/config/site";
import { formatVenueDateTime } from "@/features/events/date-time";
import { formatMinorCurrency } from "@/features/events/money";
import type { CustomerHoldView } from "@/features/holds/view-models";

export function HoldSummaryCard({ hold }: { hold: CustomerHoldView }) {
  const isLive = hold.status === "ACTIVE" && hold.live;
  const displayStatus =
    isLive ? "ACTIVE" : hold.status === "ACTIVE" && hold.expired ? "EXPIRED" : hold.status;

  return (
    <article className="rounded-2xl border border-slate-200 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-bold text-slate-950">{hold.event.title}</p>
          <p className="mt-1 text-sm text-slate-600">
            {formatVenueDateTime(hold.session.startAt, hold.session.timeZone)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {hold.session.venueName} · {hold.seatCount}{" "}
            {hold.seatCount === 1 ? "seat" : "seats"} ·{" "}
            {formatMinorCurrency(hold.totalMinor, hold.currency)}
          </p>
        </div>
        <Badge
          className={
            isLive
              ? "bg-emerald-50 text-emerald-800 ring-emerald-600/15"
              : "bg-slate-100 text-slate-600 ring-slate-600/10"
          }
        >
          {displayStatus}
        </Badge>
      </div>
      <div className="mt-4 flex items-center justify-between">
        {isLive ? (
          <span className="text-sm text-slate-600">
            Expires in{" "}
            <span className="font-mono font-bold text-slate-950">
              <HoldCountdown expiresAt={hold.expiresAt} />
            </span>
          </span>
        ) : (
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            {displayStatus.toLowerCase()}
          </span>
        )}
        <Link
          href={ROUTES.customerHold(hold.publicToken)}
          className={buttonStyles({ variant: "outline", size: "sm" })}
        >
          View hold
        </Link>
      </div>
    </article>
  );
}
