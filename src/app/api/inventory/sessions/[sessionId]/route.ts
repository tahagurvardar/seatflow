import { z } from "zod";

import { getServerEnvironment } from "@/env/server";
import { createRealtimeRoomTicket } from "@/features/inventory-events/room-ticket";
import { getDatabase } from "@/lib/database";
import { getCurrentSession } from "@/lib/session";
import { getSeatSelectionView } from "@/server/holds/hold-queries";
import {
  clientAddressFromRequest,
  consumeRateLimit,
} from "@/server/realtime/request-rate-limit";

export const dynamic = "force-dynamic";

const requestSchema = z.object({
  sessionId: z.string().min(1).max(128).regex(/^[a-z0-9_-]+$/i),
  eventSlug: z.string().min(1).max(180),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const rateLimit = consumeRateLimit(
    `customer-snapshot:${clientAddressFromRequest(request)}`,
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

  const { sessionId } = await context.params;
  const url = new URL(request.url);
  const parsed = requestSchema.safeParse({
    sessionId,
    eventSlug: url.searchParams.get("eventSlug"),
  });
  if (!parsed.success) {
    return Response.json({ error: "Invalid inventory snapshot request." }, { status: 400 });
  }

  const authSession = await getCurrentSession();
  const view = await getSeatSelectionView(
    getDatabase(),
    authSession ? { userId: authSession.user.id } : null,
    { publicSlug: parsed.data.eventSlug, sessionId: parsed.data.sessionId },
  );
  if (!view) return Response.json({ error: "Session not found." }, { status: 404 });

  return Response.json(
    {
      sections: view.sections,
      counts: view.counts,
      eligibility: view.eligibility,
      currency: view.currency,
      viewerActiveHold: view.viewerActiveHold,
      snapshotAt: new Date().toISOString(),
      realtimeTicket: createRealtimeRoomTicket({
        sessionId: view.session.id,
        secret: getServerEnvironment().BETTER_AUTH_SECRET,
      }),
    },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } },
  );
}
