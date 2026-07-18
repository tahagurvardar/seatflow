import QRCode from "qrcode";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  compareTicketCredentialHash,
  deriveTicketCredential,
  hashTicketCredential,
} from "@/features/tickets/credential";

export async function renderCustomerTicketQr(
  database: PrismaClient,
  input: { userId: string; ticketReference: string; credentialSecret: string },
) {
  const ticket = await database.ticket.findFirst({
    where: { publicReference: input.ticketReference, userId: input.userId },
    include: {
      credentials: { where: { status: "ACTIVE" }, orderBy: { version: "desc" }, take: 1 },
    },
  });
  if (!ticket || ticket.status !== "ACTIVE") return null;
  const stored = ticket.credentials[0];
  if (!stored) return null;
  const credential = deriveTicketCredential({
    ticketReference: ticket.publicReference,
    version: stored.version,
    secret: input.credentialSecret,
  });
  const actualHash = hashTicketCredential(credential, input.credentialSecret);
  if (!compareTicketCredentialHash(stored.credentialHash, actualHash)) {
    throw new Error("TICKET_CREDENTIAL_INTEGRITY_FAILURE");
  }
  return QRCode.toString(credential, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 512,
    color: { dark: "#020617", light: "#ffffff" },
  });
}
