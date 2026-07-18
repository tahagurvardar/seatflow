import { z } from "zod";

import { getServerEnvironment } from "@/env/server";
import { createRealtimeRoomTicket } from "@/features/inventory-events/room-ticket";
import { getDatabase } from "@/lib/database";
import { getCurrentSession } from "@/lib/session";
import { findAuthorizedEventSession } from "@/server/authorization/event-resources";
import { getSessionInventorySummary } from "@/server/holds/hold-queries";
import {
  clientAddressFromRequest,
  consumeRateLimit,
} from "@/server/realtime/request-rate-limit";

export const dynamic = "force-dynamic";

const requestSchema = z.object({
  sessionId: z.string().min(1).max(128).regex(/^[a-z0-9_-]+$/i),
  organizationSlug: z.string().min(1).max(80),
  eventSlug: z.string().min(1).max(120),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const rateLimit = consumeRateLimit(
    `organizer-snapshot:${clientAddressFromRequest(request)}`,
    { limit: 120, windowMs: 60_000 },
  );
  if (!rateLimit.allowed) {
    return Response.json(
      { error: "Inventory refresh is temporarily rate limited." },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  const authSession = await getCurrentSession();
  if (!authSession) {
    return Response.json({ error: "Authentication is required." }, { status: 401 });
  }
  const { sessionId } = await context.params;
  const url = new URL(request.url);
  const parsed = requestSchema.safeParse({
    sessionId,
    organizationSlug: url.searchParams.get("organizationSlug"),
    eventSlug: url.searchParams.get("eventSlug"),
  });
  if (!parsed.success) {
    return Response.json({ error: "Invalid organizer snapshot request." }, { status: 400 });
  }

  const access = await findAuthorizedEventSession(getDatabase(), {
    userId: authSession.user.id,
    organizationSlug: parsed.data.organizationSlug,
    eventSlug: parsed.data.eventSlug,
    sessionId: parsed.data.sessionId,
  });
  if (!access) {
    return Response.json({ error: "You do not have access to this session." }, { status: 403 });
  }

  return Response.json(
    {
      summary: await getSessionInventorySummary(getDatabase(), parsed.data.sessionId),
      snapshotAt: new Date().toISOString(),
      realtimeTicket: createRealtimeRoomTicket({
        sessionId: parsed.data.sessionId,
        secret: getServerEnvironment().BETTER_AUTH_SECRET,
      }),
    },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } },
  );
}
