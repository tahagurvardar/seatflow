import "dotenv/config";

import { readInventoryEventEnvironment } from "../src/env/schema";
import { createRedisConnection } from "../src/lib/redis";
import {
  createHoldExpiryQueue,
  registerHoldExpirySchedule,
} from "../src/server/holds/expiry-queue";

const environment = readInventoryEventEnvironment();
const connection = createRedisConnection({
  environment,
  connectionName: `${environment.REDIS_WORKER_ID}:expiry-scheduler`,
  bullMq: true,
});
const queue = createHoldExpiryQueue(connection, environment);

try {
  await registerHoldExpirySchedule(queue, environment);
  console.info(
    `Registered authoritative hold expiry every ${environment.HOLD_EXPIRY_SWEEP_INTERVAL_MS}ms on queue ${environment.HOLD_EXPIRY_QUEUE_NAME}.`,
  );
} finally {
  await queue.close();
  await connection.quit().catch(() => connection.disconnect());
}
