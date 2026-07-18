import "dotenv/config";

import { disconnectDatabase, getDatabase } from "../src/lib/database";
import { retryTicketIssuanceRequest } from "../src/server/tickets/issuance-service";

const requestId = process.argv.find((value) => value.startsWith("--request-id="))?.slice(13);
if (!requestId || !/^[A-Za-z0-9_-]{1,191}$/.test(requestId)) {
  throw new Error("--request-id is required and must be a valid internal issuance request ID.");
}

try {
  const count = await retryTicketIssuanceRequest(getDatabase(), { requestId });
  console.info(`Ticket issuance retry scheduled: rows=${count}.`);
} finally {
  await disconnectDatabase();
}
