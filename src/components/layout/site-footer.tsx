import Link from "next/link";

import { Logo } from "@/components/layout/logo";
import { Container } from "@/components/ui/container";
import {
  EVENT_CATEGORIES,
  NAVIGATION,
  ROUTES,
  SITE_CONFIG,
} from "@/config/site";

export function SiteFooter() {
  return (
    <footer className="bg-slate-950 text-white">
      <Container className="py-14 sm:py-18">
        <div className="grid gap-12 border-b border-white/10 pb-12 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr]">
          <div>
            <Logo inverted />
            <p className="mt-5 max-w-sm text-sm leading-6 text-slate-400">
              {SITE_CONFIG.description} Hold seats and complete a verified booking;
              securely receive digital tickets and validate entry online.
            </p>
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white">Explore</h2>
            <ul className="mt-4 space-y-3 text-sm text-slate-400">
              {NAVIGATION.map((item) => (
                <li key={item.label}>
                  <Link className="inline-block py-1 transition hover:text-white" href={item.href}>
                    {item.label}
                  </Link>
                </li>
              ))}
              <li>
                <Link className="inline-block py-1 transition hover:text-white" href={ROUTES.register}>
                  Create Account
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white">Categories</h2>
            <ul className="mt-4 space-y-3 text-sm text-slate-400">
              {EVENT_CATEGORIES.map((category) => (
                <li key={category.id}>
                  <Link
                    className="inline-block py-1 transition hover:text-white"
                    href={`${ROUTES.events}?category=${category.id}`}
                  >
                    {category.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="flex flex-col gap-2 pt-7 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getUTCFullYear()} SeatFlow. Seat selection, simulated checkout, and secure digital tickets.</p>
          <p>Built for memorable rooms, screens, stages, and stands.</p>
        </div>
      </Container>
    </footer>
  );
}
