import { readOperationsEnvironment } from "@/env/schema";

/**
 * Liveness probe.
 *
 * Answers one question: is this process running and able to serve a request?
 *
 * It deliberately performs no database, Redis, or provider I/O. A liveness probe
 * that touched dependencies would let a transient PostgreSQL or Redis blip
 * convince an orchestrator to restart every healthy instance, converting a
 * dependency incident into a full outage. Fitness to serve is readiness's job.
 */

export const dynamic = "force-dynamic";

const startedAt = Date.now();

export async function GET() {
  let service = "seatflow-web";
  try {
    service = readOperationsEnvironment().SEATFLOW_SERVICE_NAME;
  } catch {
    // A configuration problem is a readiness concern, not a liveness one: the
    // process is demonstrably alive if it answered at all.
  }

  return Response.json(
    {
      status: "alive",
      service,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1_000),
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "Content-Type": "application/json",
      },
    },
  );
}
