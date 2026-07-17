import Link from "next/link";

import { EventCard } from "@/components/events/event-card";
import { CategorySection } from "@/components/home/category-section";
import { HeroSection } from "@/components/home/hero-section";
import {
  HowItWorksSection,
  OrganizerSection,
  TrustSection,
} from "@/components/home/marketing-sections";
import { buttonStyles } from "@/components/ui/button";
import { Container, Section } from "@/components/ui/container";
import { Icon } from "@/components/ui/icon";
import { ROUTES } from "@/config/site";
import { events } from "@/data/events";

export default function HomePage() {
  const featuredEvents = events.filter((event) => event.featured).slice(0, 3);

  return (
    <>
      <HeroSection />

      <Section>
        <Container>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-orange-600">
                Curated for right now
              </p>
              <h2 className="mt-3 text-3xl font-black tracking-[-0.045em] text-slate-950 sm:text-4xl">
                Featured events
              </h2>
              <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600">
                Distinct rooms, original programmes, and the kind of energy that
                doesn’t translate through a screen.
              </p>
            </div>
            <Link
              href={ROUTES.events}
              className={buttonStyles({ variant: "outline" })}
            >
              View all events
              <Icon name="arrow-right" className="size-4" />
            </Link>
          </div>
          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {featuredEvents.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </div>
        </Container>
      </Section>

      <CategorySection />
      <HowItWorksSection />
      <OrganizerSection />
      <TrustSection />
    </>
  );
}
