import Link from "next/link";

import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { Icon } from "@/components/ui/icon";
import { ROUTES } from "@/config/site";

export default function NotFound() {
  return (
    <section className="bg-white py-20 sm:py-28">
      <Container>
        <div className="mx-auto max-w-2xl text-center">
          <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-orange-50 text-orange-600">
            <Icon name="ticket" className="size-6" />
          </span>
          <p className="mt-6 font-mono text-xs font-bold uppercase tracking-[0.2em] text-orange-600">
            404 · No event here
          </p>
          <h1 className="mt-4 text-4xl font-black tracking-[-0.05em] text-slate-950 sm:text-5xl">
            This seat isn’t on the map.
          </h1>
          <p className="mx-auto mt-5 max-w-lg text-base leading-7 text-slate-600">
            The page may have moved, or this event has no publicly eligible
            published session.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Link href={ROUTES.events} className={buttonStyles({ size: "lg" })}>
              Discover events
            </Link>
            <Link
              href={ROUTES.home}
              className={buttonStyles({ variant: "outline", size: "lg" })}
            >
              Back home
            </Link>
          </div>
        </div>
      </Container>
    </section>
  );
}
