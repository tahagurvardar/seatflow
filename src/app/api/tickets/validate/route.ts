import { readTicketEnvironment } from "@/env/schema";
import { ticketScanRequestSchema } from "@/features/tickets/schema";
import { correlationIdFromHeaders, CORRELATION_HEADER } from "@/features/observability/correlation";
import { getDatabase } from "@/lib/database";
import { getCurrentSession } from "@/lib/session";
import { getLogger } from "@/server/observability/logger";
import {
  clientAddressFromRequest,
  consumeRateLimit,
} from "@/server/realtime/request-rate-limit";
import { applyRateLimit } from "@/server/security/route-guard";
import { validateTicketEntry } from "@/server/tickets/validation-service";

export const dynamic = "force-dynamic";

/**
 * Entry validation ingress.
 *
 * Phase 5C1 adds correlation, distributed abuse control, and structured
 * outcome logging around the Phase 5B contract. The security ordering is
 * unchanged and deliberate: authenticate, bound the body, validate the schema,
 * then let the service authorize the target session *before* any credential
 * lookup happens.
 *
 * Rate limiting here is defence in depth only. It can never cause a false
 * acceptance: acceptance still requires the stored keyed hash to match and the
 * single-accepted-redemption partial unique index to be free, both of which are
 * decided inside one PostgreSQL transaction.
 */
export async function POST(request: Request) {
  const correlationId = correlationIdFromHeaders(request.headers);
  const logger = getLogger().child({ operation: "ticket.validate", correlationId });
  const startedAt = Date.now();
  const headers: Record<string, string> = {
    "Cache-Control": "private, no-store, max-age=0",
    [CORRELATION_HEADER]: correlationId,
  };

  const auth = await getCurrentSession();
  if (!auth) {
    return Response.json({ error: "Authentication is required." }, { status: 401, headers });
  }

  const environment = readTicketEnvironment();

  // Distributed limit first, so abuse is throttled across every web instance.
  const limited = await applyRateLimit({
    policyName: "ticket.validate",
    request,
    subjectId: auth.user.id,
    operation: "ticket.validate",
  });
  if (limited) return limited;

  // Retained Phase 5B process-local limiter. It remains meaningful when Redis
  // is unavailable and keeps the operator-tunable per-minute scan bound.
  const rateLimit = consumeRateLimit(
    `ticket-scan:${auth.user.id}:${clientAddressFromRequest(request)}`,
    { limit: environment.TICKET_SCAN_RATE_LIMIT_PER_MINUTE, windowMs: 60_000 },
  );
  if (!rateLimit.allowed) {
    logger.warn("ticket scan rejected by local limiter", { outcome: "rate_limited" });
    return Response.json(
      { error: "Ticket validation is temporarily rate limited." },
      { status: 429, headers: { ...headers, "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > environment.TICKET_SCAN_MAX_BYTES) {
    return Response.json({ error: "Ticket scan request is too large." }, { status: 413, headers });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > environment.TICKET_SCAN_MAX_BYTES) {
    return Response.json({ error: "Ticket scan request is too large." }, { status: 413, headers });
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return Response.json({ error: "Ticket scan request is invalid." }, { status: 400, headers });
  }
  const parsed = ticketScanRequestSchema.safeParse(value);
  if (!parsed.success) {
    return Response.json({ error: "Ticket scan request is invalid." }, { status: 400, headers });
  }

  const result = await validateTicketEntry(getDatabase(), {
    scannerUserId: auth.user.id,
    ...parsed.data,
    credentialSecret: environment.TICKET_CREDENTIAL_SECRET,
    earlyMinutes: environment.TICKET_ENTRY_EARLY_MINUTES,
    lateMinutes: environment.TICKET_ENTRY_LATE_MINUTES,
  });

  // The outcome is a closed enum, so it is a safe bounded label. No credential,
  // ticket reference, seat, or customer identity is logged.
  logger.info("ticket validation completed", {
    outcome: result.outcome.toLowerCase(),
    durationMs: Date.now() - startedAt,
  });

  return Response.json(result, {
    status: result.outcome === "UNAUTHORIZED_SCANNER" ? 403 : 200,
    headers,
  });
}
