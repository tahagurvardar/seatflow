import "dotenv/config";

import { readTicketEnvironment } from "../src/env/schema";
import { disconnectDatabase, getDatabase } from "../src/lib/database";
import { revokeTicket, rotateTicketCredential } from "../src/server/tickets/management-service";

function argument(name: string) {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const action = argument("action");
const ticketReference = argument("ticket-reference");
const actorEmail = argument("actor-email")?.trim().toLowerCase();
if (!ticketReference || !/^[A-Za-z0-9_-]{24,80}$/.test(ticketReference)) {
  throw new Error("--ticket-reference must be a valid public ticket reference.");
}
if (!actorEmail || /[\r\n\t]/.test(actorEmail)) throw new Error("--actor-email is required.");

const database = getDatabase();
try {
  const actor = await database.user.findUnique({ where: { email: actorEmail }, select: { id: true } });
  if (!actor) throw new Error("Authorized actor account was not found.");
  if (action === "rotate") {
    const environment = readTicketEnvironment();
    const result = await rotateTicketCredential(database, {
      actorUserId: actor.id,
      ticketReference,
      credentialSecret: environment.TICKET_CREDENTIAL_SECRET,
    });
    console.info(`Ticket credential rotated: ticket=${result.ticketReference} version=${result.credentialVersion}. No credential was printed.`);
  } else if (action === "revoke") {
    const reason = argument("reason");
    if (!reason) throw new Error("--reason is required for revocation.");
    const result = await revokeTicket(database, {
      actorUserId: actor.id,
      ticketReference,
      reason,
    });
    console.info(`Ticket revoked: ticket=${result.ticketReference} duplicate=${result.duplicate}.`);
  } else {
    throw new Error("--action must be rotate or revoke.");
  }
} finally {
  await disconnectDatabase();
}
