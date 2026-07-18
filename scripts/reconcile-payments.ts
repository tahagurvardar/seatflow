import "dotenv/config";

import { disconnectDatabase, getDatabase } from "../src/lib/database";
import { reconcilePendingPaymentIntents } from "../src/server/payments/operations-service";
import { getConfiguredPaymentProvider } from "../src/server/payments/provider-registry";

const limitArgument = process.argv.find((argument) => argument.startsWith("--limit="));
const limit = limitArgument ? Number(limitArgument.split("=")[1]) : 100;
if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
  throw new Error("--limit must be an integer from 1 to 1000.");
}

try {
  const result = await reconcilePendingPaymentIntents(
    getDatabase(),
    getConfiguredPaymentProvider(),
    limit,
  );
  console.info(
    `Payment reconciliation: inspected=${result.inspected} initialized=${result.initialized} refreshed=${result.refreshed} awaitingVerifiedWebhook=${result.awaitingVerifiedWebhook} failed=${result.failed}.`,
  );
} finally {
  await disconnectDatabase();
}

