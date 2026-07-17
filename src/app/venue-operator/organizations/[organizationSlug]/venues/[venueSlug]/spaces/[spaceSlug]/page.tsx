import Link from "next/link";

import {
  archiveSpaceAction,
  restoreSpaceAction,
} from "@/app/venue-operator/actions";
import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { EmptyState } from "@/components/ui/empty-state";
import { ROUTES } from "@/config/site";
import { calculateSeatMapCapacity } from "@/features/seat-maps/capacity";
import { hasMinimumMembershipRole } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";
import { requireSpaceAccess } from "@/lib/venue-authorization";
import { seatMapGraphInclude } from "@/server/seat-maps/seat-map-service";

interface SpacePageProps {
  params: Promise<{
    organizationSlug: string;
    venueSlug: string;
    spaceSlug: string;
  }>;
  searchParams: Promise<{ error?: string; success?: string }>;
}

export default async function SpacePage({
  params,
  searchParams,
}: SpacePageProps) {
  const scope = await params;
  const notices = await searchParams;
  const path = ROUTES.venueOperatorSpace(
    scope.organizationSlug,
    scope.venueSlug,
    scope.spaceSlug,
  );
  const { membership, space } = await requireSpaceAccess(scope, path);
  const [seatMaps, publishedSeatMap] = await Promise.all([
    getDatabase().seatMap.findMany({
      where: { spaceId: space.id },
      include: { _count: { select: { sections: true } } },
      orderBy: { version: "desc" },
    }),
    getDatabase().seatMap.findFirst({
      where: { spaceId: space.id, status: "PUBLISHED" },
      include: seatMapGraphInclude,
    }),
  ]);
  const publishedCapacity = publishedSeatMap
    ? calculateSeatMapCapacity(publishedSeatMap)
    : null;
  const canManage = hasMinimumMembershipRole(membership.role, "ADMIN");
  const parentsOperational =
    space.status !== "ARCHIVED" && space.venue.status !== "ARCHIVED";
  const newSeatMapPath = ROUTES.venueOperatorNewSeatMap(
    scope.organizationSlug,
    scope.venueSlug,
    scope.spaceSlug,
  );

  return (
    <section className="bg-slate-50 py-12 sm:py-16">
      <Container>
        <nav aria-label="Breadcrumb" className="text-sm text-slate-500">
          <Link
            href={ROUTES.venueOperatorVenue(
              scope.organizationSlug,
              scope.venueSlug,
            )}
            className="hover:text-slate-950"
          >
            {space.venue.name}
          </Link>{" "}
          / {space.name}
        </nav>

        {notices.error ? (
          <p
            className="mt-5 rounded-2xl bg-red-50 p-4 text-sm text-red-800"
            role="alert"
          >
            {notices.error}
          </p>
        ) : null}
        {notices.success ? (
          <p className="mt-5 rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-800">
            Space {notices.success}.
          </p>
        ) : null}

        <div className="mt-6 flex flex-col gap-5 rounded-[2rem] border border-slate-200 bg-white p-7 shadow-sm sm:p-9 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex flex-wrap gap-2">
              <Badge className="bg-violet-50 text-violet-800 ring-violet-600/15">
                {space.type.replaceAll("_", " ")}
              </Badge>
              <Badge className="bg-slate-100 text-slate-700 ring-slate-500/10">
                {space.status}
              </Badge>
            </div>
            <h1 className="mt-4 text-4xl font-black tracking-[-0.05em] text-slate-950">
              {space.name}
            </h1>
            <p className="mt-3 max-w-2xl text-slate-600">
              {space.description || "No space description has been added."}
            </p>
          </div>
          {canManage && parentsOperational ? (
            <div className="flex flex-wrap gap-2">
              <Link
                href={ROUTES.venueOperatorSpaceEdit(
                  scope.organizationSlug,
                  scope.venueSlug,
                  scope.spaceSlug,
                )}
                className={buttonStyles({ variant: "outline", size: "sm" })}
              >
                Edit space
              </Link>
              <Link href={newSeatMapPath} className={buttonStyles({ size: "sm" })}>
                New draft map
              </Link>
            </div>
          ) : null}
        </div>

        {publishedCapacity && publishedSeatMap ? (
          <section
            className="mt-6 rounded-3xl border border-emerald-200 bg-emerald-50/60 p-5 sm:p-6"
            aria-labelledby="published-capacity-heading"
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-700">
                  Current published configuration
                </p>
                <h2
                  id="published-capacity-heading"
                  className="mt-1 text-xl font-black text-slate-950"
                >
                  Capacity from {publishedSeatMap.name} v{publishedSeatMap.version}
                </h2>
              </div>
              <p className="text-xs text-slate-600">
                Blocked seats count physically, but are excluded from sellable
                capacity.
              </p>
            </div>
            <dl className="mt-5 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {[
                { label: "Physical", value: publishedCapacity.total },
                { label: "Sellable", value: publishedCapacity.sellable },
                { label: "Blocked", value: publishedCapacity.blocked },
                {
                  label: "Accessible",
                  value: publishedCapacity.byType.ACCESSIBLE.total,
                },
                {
                  label: "Companion",
                  value: publishedCapacity.byType.COMPANION.total,
                },
                {
                  label: "Premium",
                  value: publishedCapacity.byType.PREMIUM.total,
                },
              ].map((metric) => (
                <div
                  key={metric.label}
                  className="rounded-2xl bg-white p-4 ring-1 ring-emerald-200"
                >
                  <dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                    {metric.label}
                  </dt>
                  <dd className="mt-1 font-mono text-2xl font-black text-slate-950">
                    {metric.value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ) : (
          <p className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-white p-5 text-sm text-slate-600">
            Capacity is unavailable until this space has a published seat map.
          </p>
        )}

        <div className="mt-8 grid gap-6 lg:grid-cols-[1.4fr_0.6fr]">
          <div>
            <h2 className="text-2xl font-black text-slate-950">
              Seat-map versions
            </h2>
            {seatMaps.length === 0 ? (
              <div className="mt-4">
                <EmptyState
                  icon="ticket"
                  title="No seat maps yet"
                  description="Create a draft, design its sections, rows, and seats, then publish it."
                  action={
                    canManage && parentsOperational ? (
                      <Link
                        href={newSeatMapPath}
                        className={buttonStyles({ size: "sm" })}
                      >
                        Create draft map
                      </Link>
                    ) : undefined
                  }
                />
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                {seatMaps.map((seatMap) => (
                  <Link
                    key={seatMap.id}
                    href={ROUTES.venueOperatorSeatMap(
                      scope.organizationSlug,
                      scope.venueSlug,
                      scope.spaceSlug,
                      seatMap.version,
                    )}
                    className="flex items-center justify-between gap-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-orange-300"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-black text-slate-950">
                          {seatMap.name}
                        </h3>
                        <span className="font-mono text-xs text-slate-500">
                          v{seatMap.version}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {seatMap._count.sections} sections
                        {seatMap.publishedAt
                          ? ` · published ${seatMap.publishedAt.toLocaleDateString("en-GB")}`
                          : ""}
                      </p>
                    </div>
                    <Badge
                      className={
                        seatMap.status === "PUBLISHED"
                          ? "bg-emerald-50 text-emerald-800 ring-emerald-600/15"
                          : seatMap.status === "DRAFT"
                            ? "bg-amber-50 text-amber-800 ring-amber-600/15"
                            : "bg-slate-100 text-slate-600 ring-slate-500/15"
                      }
                    >
                      {seatMap.status}
                    </Badge>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <aside className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="font-black text-slate-950">Space lifecycle</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Historical seat maps remain intact when a space is archived.
            </p>
            {canManage ? (
              space.venue.status === "ARCHIVED" ? (
                <p className="mt-5 text-xs font-semibold text-amber-700">
                  Restore the venue before changing this space.
                </p>
              ) : space.status === "ARCHIVED" ? (
                <form action={restoreSpaceAction.bind(null, scope)} className="mt-5">
                  <button
                    type="submit"
                    className={buttonStyles({ variant: "secondary", size: "sm" })}
                  >
                    Restore space
                  </button>
                </form>
              ) : (
                <form
                  action={archiveSpaceAction.bind(null, scope)}
                  className="mt-5 space-y-3"
                >
                  <label className="flex items-start gap-2 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      name="confirmation"
                      value="archive"
                      required
                      className="mt-0.5"
                    />
                    I understand this space will become read-only until restored.
                  </label>
                  <button
                    type="submit"
                    className={buttonStyles({ variant: "outline", size: "sm" })}
                  >
                    Archive space
                  </button>
                </form>
              )
            ) : (
              <p className="mt-5 text-xs font-semibold text-amber-700">
                Read-only MEMBER access
              </p>
            )}
          </aside>
        </div>
      </Container>
    </section>
  );
}
