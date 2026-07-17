import Link from "next/link";

import { SignOutButton } from "@/components/auth/sign-out-button";
import { Logo } from "@/components/layout/logo";
import { NavigationLink } from "@/components/layout/navigation-link";
import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { Icon } from "@/components/ui/icon";
import { NAVIGATION, ROUTES } from "@/config/site";
import { getDatabase } from "@/lib/database";
import { getCurrentSession } from "@/lib/session";

export async function SiteHeader() {
  const session = await getCurrentSession();
  const user = session
    ? await getDatabase().user.findUnique({
        where: { id: session.user.id },
        select: { name: true, platformRole: true },
      })
    : null;

  return (
    <header className="sticky top-0 z-50 border-b border-slate-200/80 bg-white/90 backdrop-blur-xl">
      <Container className="flex h-18 items-center justify-between">
        <Logo />

        <nav aria-label="Primary navigation" className="hidden items-center gap-5 lg:flex">
          {NAVIGATION.map((item) => (
            <NavigationLink key={item.label} {...item} />
          ))}
        </nav>

        <div className="hidden items-center gap-2 sm:flex">
          {session ? (
            <>
              <span className="hidden max-w-36 truncate px-2 text-sm font-semibold text-slate-600 xl:inline">
                {user?.name ?? session.user.name}
              </span>
              <Link
                href={ROUTES.customerDashboard}
                className={buttonStyles({ variant: "ghost", size: "sm" })}
              >
                Customer
              </Link>
              <Link
                href={ROUTES.organizerDashboard}
                className={buttonStyles({ variant: "ghost", size: "sm" })}
              >
                Organizer
              </Link>
              <Link
                href={ROUTES.venueOperatorDashboard}
                className={buttonStyles({ variant: "ghost", size: "sm" })}
              >
                Venues
              </Link>
              {user?.platformRole === "ADMIN" ? (
                <Link
                  href={ROUTES.admin}
                  className={buttonStyles({ variant: "secondary", size: "sm" })}
                >
                  Admin
                </Link>
              ) : null}
              <SignOutButton />
            </>
          ) : (
            <>
              <Link
                href={ROUTES.login}
                className={buttonStyles({ variant: "ghost", size: "sm" })}
              >
                Sign In
              </Link>
              <Link
                href={ROUTES.register}
                className={buttonStyles({ variant: "secondary", size: "sm" })}
              >
                Create Account
              </Link>
            </>
          )}
        </div>

        <details className="group relative sm:hidden">
          <summary className="flex size-10 cursor-pointer list-none items-center justify-center rounded-full border border-slate-200 text-slate-900 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 [&::-webkit-details-marker]:hidden">
            <span className="sr-only">Open navigation</span>
            <Icon name="menu" className="size-5 group-open:hidden" />
            <Icon name="x" className="hidden size-5 group-open:block" />
          </summary>
          <div className="absolute right-0 mt-3 w-[min(20rem,calc(100vw-2.5rem))] rounded-2xl border border-slate-200 bg-white p-3 shadow-2xl shadow-slate-950/10">
            <nav aria-label="Mobile navigation" className="grid">
              {NAVIGATION.map((item) => (
                <NavigationLink key={item.label} {...item} mobile />
              ))}
            </nav>
            <div className="mt-3 grid gap-2 border-t border-slate-100 pt-3">
              {session ? (
                <>
                  <p className="truncate px-2 text-sm font-semibold text-slate-700">
                    {user?.name ?? session.user.name}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <Link
                      href={ROUTES.customerDashboard}
                      className={buttonStyles({ variant: "outline", size: "sm" })}
                    >
                      Customer
                    </Link>
                    <Link
                      href={ROUTES.organizerDashboard}
                      className={buttonStyles({ variant: "outline", size: "sm" })}
                    >
                      Organizer
                    </Link>
                    <Link
                      href={ROUTES.venueOperatorDashboard}
                      className={buttonStyles({ variant: "outline", size: "sm", className: "col-span-2" })}
                    >
                      Venue operator
                    </Link>
                  </div>
                  {user?.platformRole === "ADMIN" ? (
                    <Link
                      href={ROUTES.admin}
                      className={buttonStyles({ variant: "secondary", size: "sm" })}
                    >
                      Admin workspace
                    </Link>
                  ) : null}
                  <SignOutButton compact />
                </>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <Link
                    href={ROUTES.login}
                    className={buttonStyles({ variant: "outline", size: "sm" })}
                  >
                    Sign In
                  </Link>
                  <Link
                    href={ROUTES.register}
                    className={buttonStyles({ variant: "secondary", size: "sm" })}
                  >
                    Join
                  </Link>
                </div>
              )}
            </div>
          </div>
        </details>
      </Container>
    </header>
  );
}
