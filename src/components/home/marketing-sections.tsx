import Link from "next/link";

import { buttonStyles } from "@/components/ui/button";
import { Container, Section } from "@/components/ui/container";
import { Icon, type IconName } from "@/components/ui/icon";
import { ROUTES } from "@/config/site";

const steps: ReadonlyArray<{
  number: string;
  title: string;
  description: string;
  icon: IconName;
}> = [
  {
    number: "01",
    title: "Find the right event",
    description: "Search a considered programme by category, city, venue, or name.",
    icon: "search",
  },
  {
    number: "02",
    title: "Review the event details",
    description: "Check the date, time, venue, availability, and representative starting price.",
    icon: "calendar",
  },
  {
    number: "03",
    title: "Preview the room",
    description: "Review the configured section layout; seat selection and checkout arrive in later phases.",
    icon: "ticket",
  },
];

export function HowItWorksSection() {
  return (
    <Section className="bg-slate-50">
      <Container>
        <div className="max-w-2xl">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-orange-600">
            How it works
          </p>
          <h2 className="mt-3 text-3xl font-black tracking-[-0.045em] text-slate-950 sm:text-4xl">
            From “what’s on?” to “see you there.”
          </h2>
        </div>
        <ol className="mt-10 grid gap-px overflow-hidden rounded-3xl border border-slate-200 bg-slate-200 lg:grid-cols-3">
          {steps.map((step) => (
            <li key={step.number} className="bg-white p-7 sm:p-8">
              <div className="flex items-center justify-between">
                <span className="flex size-11 items-center justify-center rounded-2xl bg-slate-950 text-white">
                  <Icon name={step.icon} className="size-5" />
                </span>
                <span className="font-mono text-xs font-bold text-slate-400">
                  {step.number}
                </span>
              </div>
              <h3 className="mt-8 text-xl font-bold tracking-tight text-slate-950">
                {step.title}
              </h3>
              <p className="mt-3 text-sm leading-6 text-slate-600">
                {step.description}
              </p>
            </li>
          ))}
        </ol>
      </Container>
    </Section>
  );
}

export function OrganizerSection() {
  return (
    <Section id="organizers" className="bg-white">
      <Container>
        <div className="relative overflow-hidden rounded-[2rem] bg-orange-500 px-6 py-12 text-white sm:px-10 lg:grid lg:grid-cols-[1fr_auto] lg:items-center lg:gap-12 lg:px-14 lg:py-16">
          <div
            aria-hidden="true"
            className="absolute -right-20 -top-24 size-72 rounded-full border-[44px] border-white/10"
          />
          <div className="relative max-w-2xl">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-orange-100">
              Built for organizers, too
            </p>
            <h2 className="mt-3 text-3xl font-black tracking-[-0.045em] sm:text-4xl">
              Put the experience first. We’ll build the operations around it.
            </h2>
            <p className="mt-5 max-w-xl text-sm leading-6 text-orange-50 sm:text-base">
              Publish persistent events and priced sessions against venues that
              have explicitly approved your organization. Booking, payments,
              reporting, and team invitations remain on the roadmap.
            </p>
          </div>
          <div className="relative mt-8 lg:mt-0">
            <Link
              href={ROUTES.organizerDashboard}
              className={buttonStyles({
                variant: "outline",
                size: "lg",
                className: "border-white bg-white text-slate-950 hover:bg-orange-50",
              })}
            >
              Open organizer workspace
              <Icon name="arrow-right" className="size-4" />
            </Link>
          </div>
        </div>
      </Container>
    </Section>
  );
}

export function TrustSection() {
  const values = [
    {
      icon: "shield" as const,
      title: "Trust by design",
      description: "Clear states and honest product language—especially before checkout exists.",
    },
    {
      icon: "users" as const,
      title: "Every role considered",
      description: "Customers, organizers, venue teams, and admins have deliberate boundaries.",
    },
    {
      icon: "sparkles" as const,
      title: "Moments over mechanics",
      description: "The interface keeps attention on the event, not on platform complexity.",
    },
  ];

  return (
    <Section className="border-t border-slate-100 bg-white pt-8 sm:pt-10">
      <Container>
        <div className="grid gap-8 lg:grid-cols-3">
          {values.map((value) => (
            <div key={value.title} className="flex gap-4">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-orange-50 text-orange-600">
                <Icon name={value.icon} className="size-5" />
              </span>
              <div>
                <h2 className="font-bold text-slate-950">{value.title}</h2>
                <p className="mt-1.5 text-sm leading-6 text-slate-600">
                  {value.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </Container>
    </Section>
  );
}
