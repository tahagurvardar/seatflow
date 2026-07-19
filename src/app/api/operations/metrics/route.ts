import { readOperationsEnvironment } from "@/env/schema";
import { getDatabase } from "@/lib/database";
import { collectOperationalMetrics } from "@/server/operations/metrics";
import { requirePlatformAdmin } from "@/server/operations/require-platform-admin";

/**
 * Protected aggregate metrics.
 *
 * Platform-administrator only. Every value is a count, an age, or a duration
 * under a bounded label; nothing is keyed by user, ticket, booking reference,
 * event slug, session, email, or address.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requirePlatformAdmin();
  if (!guard.ok) return guard.response;

  const operations = readOperationsEnvironment();
  const metrics = await collectOperationalMetrics(getDatabase(), {
    staleAfterSeconds: operations.WORKER_HEARTBEAT_STALE_SECONDS,
  });

  return Response.json(metrics, {
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}
