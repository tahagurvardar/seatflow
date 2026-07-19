import { readTicketEnvironment } from "@/env/schema";
import { safeTicketPdfFilename } from "@/features/tickets/pdf";
import { CORRELATION_HEADER, correlationIdFromHeaders } from "@/features/observability/correlation";
import { getDatabase } from "@/lib/database";
import { getCurrentSession } from "@/lib/session";
import { applyRateLimit } from "@/server/security/route-guard";
import { consumeBookingPdfGrant } from "@/server/tickets/download-grant-service";

export const dynamic = "force-dynamic";

/**
 * Single-use PDF grant consumption.
 *
 * The rate limit bounds token-guessing attempts. It is not the security
 * boundary: the token is 256 bits of CSPRNG entropy, only its keyed hash is
 * stored, and consumption still requires the matching authenticated owner.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const correlationId = correlationIdFromHeaders(request.headers);
  const auth = await getCurrentSession();
  if (!auth) {
    return Response.json(
      { error: "Authentication is required." },
      { status: 401, headers: { [CORRELATION_HEADER]: correlationId } },
    );
  }

  const limited = await applyRateLimit({
    policyName: "ticket.pdf_download",
    request,
    subjectId: auth.user.id,
    operation: "ticket.pdf_download",
  });
  if (limited) return limited;

  const token = (await context.params).token;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return Response.json({ error: "Download link is invalid or expired." }, { status: 404 });
  }
  const environment = readTicketEnvironment();
  const result = await consumeBookingPdfGrant(getDatabase(), {
    userId: auth.user.id,
    token,
    credentialSecret: environment.TICKET_CREDENTIAL_SECRET,
  });
  if (!result) {
    return Response.json({ error: "Download link is invalid, expired, or already used." }, { status: 404 });
  }
  const filename = safeTicketPdfFilename(result.view.eventTitle, result.view.bookingReference);
  return new Response(Buffer.from(result.bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(result.bytes.byteLength),
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      [CORRELATION_HEADER]: correlationId,
    },
  });
}
