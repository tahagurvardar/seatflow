import Link from "next/link";

import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { Icon } from "@/components/ui/icon";
import { ROUTES } from "@/config/site";
import { events } from "@/data/events";
import { formatEventDate } from "@/lib/formatters";

const heroEvents = events.filter((event) => event.featured).slice(0, 3);

export function HeroSection() {
  return (
    <section className="relative overflow-hidden bg-slate-950 text-white">
      <div
        aria-hidden="true"
        className="absolute -left-24 top-12 size-96 rounded-full bg-orange-500/20 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="absolute right-0 top-0 h-full w-1/2 bg-[radial-gradient(circle_at_top_right,rgba(124,58,237,0.24),transparent_65%)]"
      />
      <Container className="relative grid min-h-[44rem] items-center gap-14 py-16 lg:grid-cols-[1.08fr_0.92fr] lg:py-24">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-orange-200 backdrop-blur">
            <Icon name="sparkles" className="size-3.5" />
            A new way to find your next live moment
          </div>
          <h1 className="mt-7 max-w-3xl text-5xl font-black leading-[0.98] tracking-[-0.06em] sm:text-6xl lg:text-7xl">
            Your next story starts with a seat.
          </h1>
          <p className="mt-6 max-w-xl text-base leading-7 text-slate-300 sm:text-lg">
            Find concerts, screenings, theatre, and sport worth showing up for.
            SeatFlow brings the programme together—clearly, beautifully, and
            without the noise.
          </p>

          <form
            action={ROUTES.events}
            className="mt-9 grid gap-2 rounded-2xl bg-white p-2 text-slate-950 shadow-2xl shadow-black/25 sm:grid-cols-[1.35fr_1fr_auto]"
          >
            <label className="relative block">
              <span className="sr-only">Search events</span>
              <Icon
                name="search"
                className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-slate-400"
              />
              <input
                name="q"
                type="search"
                placeholder="Event, artist, or venue"
                className="h-13 w-full rounded-xl border-0 bg-slate-50 pl-12 pr-4 text-sm outline-none ring-0 placeholder:text-slate-400 focus:bg-orange-50/60"
              />
            </label>
            <label className="relative block">
              <span className="sr-only">City</span>
              <Icon
                name="map-pin"
                className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-slate-400"
              />
              <input
                name="city"
                placeholder="Any city"
                className="h-13 w-full rounded-xl border-0 bg-slate-50 pl-12 pr-4 text-sm outline-none ring-0 placeholder:text-slate-400 focus:bg-orange-50/60"
              />
            </label>
            <button
              type="submit"
              className={buttonStyles({
                size: "lg",
                className: "w-full sm:w-auto",
              })}
            >
              Find events
            </button>
          </form>

          <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-400">
            <span className="font-semibold text-slate-200">Explore:</span>
            <Link className="transition hover:text-white" href="/events?category=concert">
              Live music
            </Link>
            <Link className="transition hover:text-white" href="/events?category=theatre">
              Theatre
            </Link>
            <Link className="transition hover:text-white" href="/events?category=sport">
              Sports
            </Link>
          </div>
        </div>

        <div className="relative mx-auto w-full max-w-lg lg:mr-0">
          <div className="absolute -inset-5 rotate-2 rounded-[2.25rem] border border-white/10 bg-white/5" />
          <div className="relative overflow-hidden rounded-[2rem] border border-white/15 bg-white/[0.08] p-4 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-6">
            <div className="flex items-center justify-between border-b border-white/10 pb-5">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-orange-300">
                  On your radar
                </p>
                <p className="mt-1 text-xl font-bold">Nights worth leaving home for</p>
              </div>
              <span className="grid size-11 place-items-center rounded-full bg-orange-500 text-white">
                <Icon name="ticket" className="size-5" />
              </span>
            </div>
            <div className="mt-2 divide-y divide-white/10">
              {heroEvents.map((event, index) => (
                <Link
                  key={event.id}
                  href={ROUTES.eventDetail(event.slug)}
                  className="group grid grid-cols-[auto_1fr_auto] items-center gap-4 rounded-xl py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
                >
                  <span
                    className={`grid size-12 place-items-center rounded-xl text-sm font-black ${
                      index === 0
                        ? "bg-orange-500 text-white"
                        : index === 1
                          ? "bg-violet-500/25 text-violet-200"
                          : "bg-cyan-500/20 text-cyan-200"
                    }`}
                  >
                    0{index + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-bold text-white transition group-hover:text-orange-200">
                      {event.title}
                    </span>
                    <span className="mt-1 block text-xs text-slate-400">
                      {formatEventDate(event.startDate)} · {event.city}
                    </span>
                  </span>
                  <Icon
                    name="arrow-up-right"
                    className="size-4 text-slate-500 transition group-hover:text-white"
                  />
                </Link>
              ))}
            </div>
            <Link
              href={ROUTES.events}
              className="mt-3 flex items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm font-semibold transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
            >
              Browse the full programme
              <Icon name="arrow-right" className="size-4" />
            </Link>
          </div>
        </div>
      </Container>
    </section>
  );
}
