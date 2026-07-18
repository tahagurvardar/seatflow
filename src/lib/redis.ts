import Redis from "ioredis";

import {
  readInventoryEventEnvironment,
  type InventoryEventEnvironment,
} from "@/env/schema";

export function createRedisConnection(input: {
  environment?: InventoryEventEnvironment;
  connectionName: string;
  bullMq?: boolean;
}) {
  const environment = input.environment ?? readInventoryEventEnvironment();
  return new Redis(environment.REDIS_URL, {
    connectionName: input.connectionName,
    enableReadyCheck: true,
    lazyConnect: true,
    maxRetriesPerRequest: input.bullMq ? null : 2,
    retryStrategy(attempt) {
      return Math.min(250 * 2 ** Math.min(attempt - 1, 5), 5_000);
    },
  });
}

export async function ensureRedisConnected(redis: Redis) {
  if (redis.status === "wait") await redis.connect();
  if (redis.status === "ready") return;
  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      redis.off("ready", onReady);
      redis.off("error", onError);
    };
    redis.once("ready", onReady);
    redis.once("error", onError);
  });
}

export function inventoryStreamKey(prefix: string) {
  return `${prefix}:inventory-events`;
}

export function inventoryEventDedupKey(prefix: string, eventId: string) {
  return `${prefix}:inventory-event-dedup:${eventId}`;
}

export function realtimeClientCountKey(prefix: string, workerId: string) {
  return `${prefix}:realtime-clients:${workerId}`;
}
