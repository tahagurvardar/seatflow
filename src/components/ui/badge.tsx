import type { HTMLAttributes } from "react";

import type { AvailabilityStatus } from "@/domain/event";
import { cn } from "@/lib/utils";

const availabilityContent: Record<
  AvailabilityStatus,
  { label: string; className: string }
> = {
  "on-sale": {
    label: "On sale",
    className: "bg-emerald-50 text-emerald-800 ring-emerald-600/15",
  },
  limited: {
    label: "Selling fast",
    className: "bg-amber-50 text-amber-800 ring-amber-600/15",
  },
  "sold-out": {
    label: "Sold out",
    className: "bg-slate-100 text-slate-600 ring-slate-500/15",
  },
  "coming-soon": {
    label: "Coming soon",
    className: "bg-violet-50 text-violet-800 ring-violet-600/15",
  },
};

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset",
        className,
      )}
      {...props}
    />
  );
}

export function AvailabilityBadge({ status }: { status: AvailabilityStatus }) {
  const content = availabilityContent[status];
  return <Badge className={content.className}>{content.label}</Badge>;
}
