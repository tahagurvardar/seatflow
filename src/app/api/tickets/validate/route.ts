import { readTicketEnvironment } from "@/env/schema";
import { ticketScanRequestSchema } from "@/features/tickets/schema";
import { getDatabase } from "@/lib/database";
import { getCurrentSession } from "@/lib/session";
import {
  clientAddressFromRequest,
  consumeRateLimit,
} from "@/server/realtime/request-rate-limit";
import { validateTicketEntry } from "@/server/tickets/validation-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await getCurrentSession();
  if (!auth) return Response.json({ error: "Authentication is required." }, { status: 401 });
  const environment = readTicketEnvironment();
  const rateLimit = consumeRateLimit(
    `ticket-scan:${auth.user.id}:${clientAddressFromRequest(request)}`,
    { limit: environment.TICKET_SCAN_RATE_LIMIT_PER_MINUTE, windowMs: 60_000 },
  );
  if (!rateLimit.allowed) {
    return Response.json(
      { error: "Ticket validation is temporarily rate limited." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > environment.TICKET_SCAN_MAX_BYTES) {
    return Response.json({ error: "Ticket scan request is too large." }, { status: 413 });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > environment.TICKET_SCAN_MAX_BYTES) {
    return Response.json({ error: "Ticket scan request is too large." }, { status: 413 });
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return Response.json({ error: "Ticket scan request is invalid." }, { status: 400 });
  }
  const parsed = ticketScanRequestSchema.safeParse(value);
  if (!parsed.success) return Response.json({ error: "Ticket scan request is invalid." }, { status: 400 });
  const result = await validateTicketEntry(getDatabase(), {
    scannerUserId: auth.user.id,
    ...parsed.data,
    credentialSecret: environment.TICKET_CREDENTIAL_SECRET,
    earlyMinutes: environment.TICKET_ENTRY_EARLY_MINUTES,
    lateMinutes: environment.TICKET_ENTRY_LATE_MINUTES,
  });
  return Response.json(result, {
    status: result.outcome === "UNAUTHORIZED_SCANNER" ? 403 : 200,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}
