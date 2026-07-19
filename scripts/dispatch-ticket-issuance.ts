import "dotenv/config";

import { readTicketEnvironment } from "../src/env/schema";
import { disconnectDatabase, getDatabase } from "../src/lib/database";
import { recordWorkerHeartbeat } from "../src/server/operations/worker-heartbeat";
import { processTicketIssuanceBatch } from "../src/server/tickets/issuance-service";

const environment = readTicketEnvironment();
const startedAt = new Date();
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
  // Phase 5C1: a bounded one-shot dispatcher records liveness per invocation.
  // A scheduler that stops calling it therefore shows up as a stale heartbeat.
  await recordWorkerHeartbeat(getDatabase(), {
    workerType: "TICKET_ISSUANCE_DISPATCHER",
    status: result.failed > 0 ? "DEGRADED" : "HEALTHY",
    startedAt,
    lastRunDurationMs: Date.now() - startedAt.getTime(),
    consecutiveFailures: result.failed,
  });
} finally {
  await disconnectDatabase();
}
