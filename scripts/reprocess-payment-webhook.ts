import "dotenv/config";

import { disconnectDatabase, getDatabase } from "../src/lib/database";
import { reprocessVerifiedWebhook } from "../src/server/payments/operations-service";

const idArgument = process.argv.find((argument) => argument.startsWith("--event-id="));
const eventId = idArgument?.split("=")[1];
if (!eventId || eventId.length > 191 || !/^[A-Za-z0-9_-]+$/.test(eventId)) {
  throw new Error("Usage: npm run payments:webhook:reprocess -- --event-id=<internal-webhook-id>");
}

try {
  const result = await reprocessVerifiedWebhook(getDatabase(), eventId);
  console.info(`Verified webhook reprocess outcome=${result.outcome}.`);
} finally {
  await disconnectDatabase();
}

