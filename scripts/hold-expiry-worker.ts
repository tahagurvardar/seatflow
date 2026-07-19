import "dotenv/config";

import { readInventoryEventEnvironment } from "../src/env/schema";
import { getDatabase } from "../src/lib/database";
import { createRedisConnection } from "../src/lib/redis";
import { createHoldExpiryWorker } from "../src/server/holds/expiry-queue";
import { startWorkerHeartbeat } from "../src/server/operations/worker-heartbeat";

const environment = readInventoryEventEnvironment();
const connection = createRedisConnection({
  environment,
  connectionName: `${environment.REDIS_WORKER_ID}:expiry-worker`,
  bullMq: true,
});
const database = getDatabase();
const worker = createHoldExpiryWorker({ database, connection, environment });

worker.on("completed", (job, result) => {
  console.info(
    `Hold expiry job ${job.id ?? "unknown"} completed: expired=${result.holdsExpired} seats=${result.seatsReleased} batches=${result.batches}.`,
  );
});
worker.on("failed", (job, error) => {
  console.error(
    `Hold expiry job ${job?.id ?? "unknown"} failed: ${error.message.slice(0, 300)}.`,
  );
});

// Phase 5C1: periodic heartbeat. BullMQ is event driven, so liveness is
// reported on a timer rather than per job; a crashed worker simply stops
// updating and readiness reports it stale.
const stopHeartbeat = startWorkerHeartbeat(database, {
  workerType: "HOLD_EXPIRY_WORKER",
});

async function shutdown() {
  await stopHeartbeat();
  await worker.close();
  await connection.quit().catch(() => connection.disconnect());
  await database.$disconnect();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
