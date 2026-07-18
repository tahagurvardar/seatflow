import { readTicketEnvironment } from "@/env/schema";
import { ticketReferenceSchema } from "@/features/tickets/schema";
import { getDatabase } from "@/lib/database";
import { getCurrentSession } from "@/lib/session";
import { renderCustomerTicketQr } from "@/server/tickets/qr-service";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ ticketReference: string }> },
) {
  const auth = await getCurrentSession();
  if (!auth) return Response.json({ error: "Authentication is required." }, { status: 401 });
  const parsed = ticketReferenceSchema.safeParse((await context.params).ticketReference);
  if (!parsed.success) return Response.json({ error: "Ticket not found." }, { status: 404 });
  const environment = readTicketEnvironment();
  const svg = await renderCustomerTicketQr(getDatabase(), {
    userId: auth.user.id,
    ticketReference: parsed.data,
    credentialSecret: environment.TICKET_CREDENTIAL_SECRET,
  });
  if (!svg) return Response.json({ error: "Ticket QR is unavailable." }, { status: 404 });
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
