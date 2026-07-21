import { getDatabase } from "@/lib/database";
import { getCurrentSession } from "@/lib/session";
import { readinessHttpStatus } from "@/features/operations/health";
import { evaluateReadiness } from "@/server/operations/readiness";

/**
 * Readiness probe.
 *
 * Answers whether this process can safely serve its role right now. A hard
 * failure returns 503 so the instance leaves rotation while staying alive to
 * recover; a degraded result still returns 200 because a backlog needs the
 * instance to keep working, not to be removed.
 *
 * The unauthenticated body is deliberately minimal — an overall status only.
 * The per-check breakdown is available to platform administrators, so an
 * anonymous caller cannot enumerate which dependency is currently unhealthy.
 * No URL, hostname, username, schema name, internal ID, secret, or stack trace
 * appears in either form.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const report = await evaluateReadiness(getDatabase());

  let detailed = false;
  try {
    const auth = await getCurrentSession();
    if (auth) {
      const user = await getDatabase().user.findUnique({
        where: { id: auth.user.id },
        select: { platformRole: true },
      });
      detailed = user?.platformRole === "ADMIN";
    }
  } catch {
    // Readiness must answer even when the session layer is unavailable.
  }

  return Response.json(
    detailed
      ? {
          status: report.status,
          role: report.role,
          profile: report.profile,
          jobMode: report.jobMode,
          checkedAt: report.checkedAt,
          checks: report.checks,
        }
      : { status: report.status, checkedAt: report.checkedAt },
    {
      status: readinessHttpStatus(report.status),
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "Content-Type": "application/json",
      },
    },
  );
}
