import "dotenv/config";

import { readTicketEnvironment } from "../src/env/schema";
import { disconnectDatabase, getDatabase } from "../src/lib/database";
import { processTicketIssuanceBatch } from "../src/server/tickets/issuance-service";

const environment = readTicketEnvironment();
try {
  const result = await processTicketIssuanceBatch(getDatabase(), {
    credentialSecret: environment.TICKET_CREDENTIAL_SECRET,
    configuration: {
      batchSize: environment.TICKET_ISSUANCE_BATCH_SIZE,
      maximumAttempts: environment.TICKET_ISSUANCE_MAX_ATTEMPTS,
      backoffBaseMs: environment.TICKET_ISSUANCE_BACKOFF_BASE_MS,
      backoffMaximumMs: environment.TICKET_ISSUANCE_BACKOFF_MAX_MS,
    },
  });
  console.info(`Ticket issuance: claimed=${result.claimed} completed=${result.completed} failed=${result.failed} deadLettered=${result.deadLettered}.`);
} finally {
  await disconnectDatabase();
}
