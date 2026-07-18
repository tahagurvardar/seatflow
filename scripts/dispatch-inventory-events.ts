import "dotenv/config";

import { setTimeout as delay } from "node:timers/promises";

import { readInventoryEventEnvironment } from "../src/env/schema";
import { getDatabase } from "../src/lib/database";
import { createRedisConnection } from "../src/lib/redis";
import {
  dispatchInventoryEventBatch,
  getOutboxDispatcherConfiguration,
} from "../src/server/inventory-events/dispatcher-service";
import { RedisInventoryEventTransport } from "../src/server/inventory-events/redis-transport";

const continuous = process.argv.includes("--continuous");
const intervalArgument = process.argv.find((argument) =>
  argument.startsWith("--interval-ms="),
);
const intervalMs = intervalArgument
  ? Number(intervalArgument.split("=")[1])
  : 1_000;
if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000) {
  throw new Error("--interval-ms must be an integer from 100 to 60000.");
}

const environment = readInventoryEventEnvironment();
const redis = createRedisConnection({
  environment,
  connectionName: `${environment.REDIS_WORKER_ID}:dispatcher`,
});
const transport = new RedisInventoryEventTransport(redis, environment);
const configuration = getOutboxDispatcherConfiguration(environment);
const database = getDatabase();
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

try {
  do {
    const result = await dispatchInventoryEventBatch(
      database,
      transport,
      configuration,
    );
    console.info(
      `Inventory outbox: claimed=${result.claimed} processed=${result.processed} failed=${result.failed} deadLettered=${result.deadLettered} durationMs=${Math.round(result.durationMs)}`,
    );
    if (continuous && !stopping) await delay(intervalMs);
  } while (continuous && !stopping);
} finally {
  await redis.quit().catch(() => redis.disconnect());
  await database.$disconnect();
}
