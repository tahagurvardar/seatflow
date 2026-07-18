"use server";

import { ROUTES } from "@/config/site";
import { readTicketEnvironment } from "@/env/schema";
import { requireAuth } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";
import { createBookingPdfGrant } from "@/server/tickets/download-grant-service";

export async function createBookingPdfDownloadAction(bookingReference: string) {
  const auth = await requireAuth(ROUTES.customerBookings);
  const environment = readTicketEnvironment();
  const grant = await createBookingPdfGrant(getDatabase(), {
    userId: auth.user.id,
    bookingReference,
    credentialSecret: environment.TICKET_CREDENTIAL_SECRET,
    ttlMinutes: environment.TICKET_DOWNLOAD_GRANT_TTL_MINUTES,
  });
  if (!grant) return null;
  return { downloadUrl: `/api/tickets/download/${encodeURIComponent(grant.token)}` };
}
