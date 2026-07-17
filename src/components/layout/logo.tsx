import Link from "next/link";

import { ROUTES, SITE_CONFIG } from "@/config/site";
import { cn } from "@/lib/utils";

export function Logo({ inverted = false }: { inverted?: boolean }) {
  return (
    <Link
      href={ROUTES.home}
      aria-label={`${SITE_CONFIG.name} home`}
      className={cn(
        "inline-flex items-center gap-2.5 rounded-lg text-lg font-black tracking-[-0.04em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2",
        inverted ? "text-white" : "text-slate-950",
      )}
    >
      <span className="relative flex size-8 items-center justify-center overflow-hidden rounded-[10px] bg-orange-500 text-white shadow-[0_6px_18px_rgba(246,87,34,0.3)]">
        <svg aria-hidden="true" viewBox="0 0 32 32" className="size-6 fill-none">
          <path
            d="M9 10.5c2-2.7 9.6-2.8 12.4.1 2.3 2.4-1.3 4.2-5.3 4.6-3.7.4-7.2 2.1-5.2 4.5 2.4 2.8 9.5 2.3 12-.5"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
      </span>
      {SITE_CONFIG.name}
    </Link>
  );
}
