import Image from "next/image";
import Link from "next/link";

import { AvailabilityBadge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { ROUTES } from "@/config/site";
import type { Event } from "@/domain/event";
import { formatMinorCurrency } from "@/features/events/money";
import { formatEventDate, getDateBadge } from "@/lib/formatters";

export function EventCard({
  event,
  priority = false,
}: {
  event: Event;
  priority?: boolean;
}) {
  const dateBadge = getDateBadge(event.startDate, event.timeZone);

  return (
    <article className="group flex h-full flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_16px_50px_rgba(15,23,42,0.06)] transition duration-300 hover:-translate-y-1 hover:shadow-[0_22px_60px_rgba(15,23,42,0.11)]">
      <Link
        href={ROUTES.eventDetail(event.slug)}
        className="relative block aspect-[4/3] overflow-hidden bg-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-inset"
        aria-label={`View ${event.title}`}
      >
        <Image
          src={event.image.src}
          alt={event.image.alt}
          fill
          priority={priority}
          sizes="(min-width: 1024px) 30vw, (min-width: 640px) 46vw, 100vw"
          className="object-cover transition duration-500 group-hover:scale-[1.035]"
        />
        <span className="absolute left-4 top-4 grid min-w-14 place-items-center rounded-2xl bg-white/95 px-2.5 py-2 text-center shadow-lg backdrop-blur">
          <span className="text-[10px] font-black tracking-[0.16em] text-orange-600">
            {dateBadge.month}
          </span>
          <span className="text-xl font-black leading-none text-slate-950">
            {dateBadge.day}
          </span>
        </span>
      </Link>

      <div className="flex flex-1 flex-col p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-orange-600">
            {event.category}
          </p>
          <AvailabilityBadge status={event.availability} />
        </div>
        <h3 className="mt-4 text-xl font-bold tracking-[-0.03em] text-slate-950">
          <Link
            href={ROUTES.eventDetail(event.slug)}
            className="rounded-md transition hover:text-orange-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          >
            {event.title}
          </Link>
        </h3>
        <p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-600">
          {event.shortDescription}
        </p>
        <dl className="mt-5 space-y-2 border-t border-slate-100 pt-4 text-sm text-slate-600">
          <div className="flex items-center gap-2">
            <Icon name="calendar" className="size-4 shrink-0 text-slate-400" />
            <dt className="sr-only">Date</dt>
            <dd>{formatEventDate(event.startDate, event.timeZone)}</dd>
          </div>
          <div className="flex items-center gap-2">
            <Icon name="map-pin" className="size-4 shrink-0 text-slate-400" />
            <dt className="sr-only">Venue</dt>
            <dd className="truncate">
              {event.venue}, {event.city}
            </dd>
          </div>
        </dl>
        <div className="mt-auto flex items-end justify-between gap-4 pt-5">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
              From
            </p>
            <p className="mt-0.5 text-lg font-black text-slate-950">
              {formatMinorCurrency(event.minimumPriceMinor, event.currency)}
            </p>
          </div>
          <span className="flex size-10 items-center justify-center rounded-full bg-slate-950 text-white transition group-hover:bg-orange-500">
            <Icon name="arrow-up-right" className="size-4" />
          </span>
        </div>
      </div>
    </article>
  );
}
