import "dotenv/config";

import { disconnectDatabase, getDatabase } from "../src/lib/database";
import { retryPendingNotifications } from "../src/server/notifications/dispatcher-service";

const outboxId = process.argv.find((value) => value.startsWith("--outbox-id="))?.slice(12);
if (outboxId && !/^[A-Za-z0-9_-]{1,191}$/.test(outboxId)) {
  throw new Error("--outbox-id is invalid.");
}
try {
  const count = await retryPendingNotifications(getDatabase(), { outboxId });
  console.info(`Notification retry scheduled: rows=${count}.`);
} finally {
  await disconnectDatabase();
}
