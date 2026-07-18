import { Queue, Worker, type JobsOptions } from "bullmq";
import type Redis from "ioredis";

import type { InventoryEventEnvironment } from "@/env/schema";
import type { PrismaClient } from "@/generated/prisma/client";
import { getHoldConfiguration } from "@/features/holds/config";
import { sweepExpiredHolds } from "@/server/holds/expiry-service";

export const HOLD_EXPIRY_JOB_NAME = "sweep-expired-holds";
export const HOLD_EXPIRY_SCHEDULER_ID = "seatflow-authoritative-hold-expiry";

function queueOptions(connection: Redis, environment: InventoryEventEnvironment) {
  return {
    connection,
    prefix: `${environment.REDIS_STREAM_PREFIX}:bullmq`,
  };
}

export function createHoldExpiryQueue(
  connection: Redis,
  environment: InventoryEventEnvironment,
) {
  return new Queue(environment.HOLD_EXPIRY_QUEUE_NAME, {
    ...queueOptions(connection, environment),
    defaultJobOptions: holdExpiryJobOptions(environment),
  });
}

export function holdExpiryJobOptions(
  environment: InventoryEventEnvironment,
): JobsOptions {
  return {
    attempts: environment.HOLD_EXPIRY_JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  };
}

export async function registerHoldExpirySchedule(
  queue: Queue,
  environment: InventoryEventEnvironment,
) {
  return queue.upsertJobScheduler(
    HOLD_EXPIRY_SCHEDULER_ID,
    { every: environment.HOLD_EXPIRY_SWEEP_INTERVAL_MS },
    {
      name: HOLD_EXPIRY_JOB_NAME,
      data: {},
      opts: holdExpiryJobOptions(environment),
    },
  );
}

export function createHoldExpiryWorker(input: {
  database: PrismaClient;
  connection: Redis;
  environment: InventoryEventEnvironment;
}) {
  return new Worker(
    input.environment.HOLD_EXPIRY_QUEUE_NAME,
    async (job) => {
      if (job.name !== HOLD_EXPIRY_JOB_NAME) {
        throw new Error("Unsupported hold-expiry job.");
      }
      return sweepExpiredHolds(input.database, {
        batchSize: getHoldConfiguration().sweepBatchSize,
        maxBatches: 10,
      });
    },
    {
      ...queueOptions(input.connection, input.environment),
      concurrency: 1,
    },
  );
}
