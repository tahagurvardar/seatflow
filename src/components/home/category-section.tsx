import Link from "next/link";

import { Container, Section } from "@/components/ui/container";
import { Icon, type IconName } from "@/components/ui/icon";
import { EVENT_CATEGORIES, ROUTES } from "@/config/site";

const categoryPresentation: Record<
  (typeof EVENT_CATEGORIES)[number]["id"],
  { icon: IconName; className: string }
> = {
  concert: { icon: "music", className: "bg-orange-100 text-orange-700" },
  cinema: { icon: "film", className: "bg-cyan-100 text-cyan-700" },
  theatre: { icon: "stage", className: "bg-violet-100 text-violet-700" },
  sport: { icon: "sport", className: "bg-lime-100 text-lime-800" },
  other: { icon: "sparkles", className: "bg-slate-200 text-slate-700" },
};

export function CategorySection() {
  return (
    <Section id="categories" className="bg-white">
      <Container>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-orange-600">
              Pick your atmosphere
            </p>
            <h2 className="mt-3 text-3xl font-black tracking-[-0.045em] text-slate-950 sm:text-4xl">
              What are you in the mood for?
            </h2>
          </div>
          <p className="max-w-md text-sm leading-6 text-slate-600">
            Five ways to spend a great night. Transportation ticketing is outside
            SeatFlow’s v1 scope.
          </p>
        </div>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {EVENT_CATEGORIES.map((category) => {
            const presentation = categoryPresentation[category.id];
            return (
              <Link
                key={category.id}
                href={`${ROUTES.events}?category=${category.id}`}
                className="group rounded-3xl border border-slate-200 bg-slate-50 p-6 transition hover:-translate-y-1 hover:border-slate-300 hover:bg-white hover:shadow-xl hover:shadow-slate-950/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
              >
                <span
                  className={`flex size-12 items-center justify-center rounded-2xl ${presentation.className}`}
                >
                  <Icon name={presentation.icon} className="size-5" />
                </span>
                <span className="mt-6 flex items-center justify-between">
                  <span className="text-lg font-bold text-slate-950">
                    {category.label}
                  </span>
                  <Icon
                    name="arrow-up-right"
                    className="size-4 text-slate-400 transition group-hover:text-orange-600"
                  />
                </span>
                <span className="mt-2 block text-sm leading-6 text-slate-600">
                  {category.description}
                </span>
              </Link>
            );
          })}
        </div>
      </Container>
    </Section>
  );
}
