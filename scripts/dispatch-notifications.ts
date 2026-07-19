import "dotenv/config";

import {
  readApplicationEnvironment,
  readNotificationEnvironment,
  readTicketEnvironment,
} from "../src/env/schema";
import { disconnectDatabase, getDatabase } from "../src/lib/database";
import {
  dispatchNotificationBatch,
  getNotificationDispatcherConfiguration,
} from "../src/server/notifications/dispatcher-service";
import { createNotificationProvider } from "../src/server/notifications/provider-registry";
import { recordWorkerHeartbeat } from "../src/server/operations/worker-heartbeat";

const application = readApplicationEnvironment();
const notification = readNotificationEnvironment();
const ticket = readTicketEnvironment();
const startedAt = new Date();
try {
  const result = await dispatchNotificationBatch(
    getDatabase(),
    createNotificationProvider(notification),
    getNotificationDispatcherConfiguration(notification, {
      applicationBaseUrl: application.BETTER_AUTH_URL,
      credentialSecret: ticket.TICKET_CREDENTIAL_SECRET,
      downloadGrantTtlMinutes: ticket.TICKET_DOWNLOAD_GRANT_TTL_MINUTES,
    }),
  );
  console.info(`Notification outbox: claimed=${result.claimed} processed=${result.processed} failed=${result.failed} deadLettered=${result.deadLettered}.`);
  // Phase 5C1: a bounded one-shot dispatcher records liveness per invocation.
  await recordWorkerHeartbeat(getDatabase(), {
    workerType: "NOTIFICATION_DISPATCHER",
    status: result.failed > 0 ? "DEGRADED" : "HEALTHY",
    startedAt,
    lastRunDurationMs: Date.now() - startedAt.getTime(),
    consecutiveFailures: result.failed,
  });
} finally {
  await disconnectDatabase();
}
