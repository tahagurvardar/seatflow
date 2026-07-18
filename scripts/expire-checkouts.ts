import "dotenv/config";

import { expireCheckoutCommandSchema } from "../src/features/checkout/schema";
import { disconnectDatabase, getDatabase } from "../src/lib/database";
import { expireUnpaidCheckoutOrders } from "../src/server/payments/operations-service";

function flagValue(name: string) {
  const argument = process.argv.find((value) => value.startsWith(`${name}=`));
  return argument?.split("=")[1];
}

const parsed = expireCheckoutCommandSchema.parse({
  batchSize: flagValue("--batch-size"),
  maxBatches: flagValue("--max-batches"),
});

try {
  const result = await expireUnpaidCheckoutOrders(getDatabase(), parsed);
  console.info(`Checkout expiry: expired=${result.expiredOrders} batches=${result.batches}.`);
} finally {
  await disconnectDatabase();
}

