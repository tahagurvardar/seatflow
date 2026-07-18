import type Redis from "ioredis";

import type { InventoryEventEnvironment } from "@/env/schema";
import {
  inventoryEventPayloadSchema,
  serializeInventoryEvent,
  type InventoryInvalidationEvent,
} from "@/features/inventory-events/event";
import {
  ensureRedisConnected,
  inventoryEventDedupKey,
  inventoryStreamKey,
} from "@/lib/redis";

export interface InventoryEventTransport {
  publish(event: InventoryInvalidationEvent): Promise<void>;
}

const publishScript = `
local inserted = redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1])
if inserted then
  return redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[2], '*', 'event', ARGV[3])
end
return ''
`;

export class RedisInventoryEventTransport implements InventoryEventTransport {
  constructor(
    private readonly redis: Redis,
    private readonly environment: InventoryEventEnvironment,
  ) {}

  async publish(rawEvent: InventoryInvalidationEvent) {
    const event = inventoryEventPayloadSchema.parse(rawEvent);
    await ensureRedisConnected(this.redis);
    await this.redis.eval(
      publishScript,
      2,
      inventoryEventDedupKey(this.environment.REDIS_STREAM_PREFIX, event.eventId),
      inventoryStreamKey(this.environment.REDIS_STREAM_PREFIX),
      String(this.environment.REDIS_EVENT_DEDUP_TTL_SECONDS),
      String(this.environment.REDIS_STREAM_MAX_LENGTH),
      serializeInventoryEvent(event),
    );
  }
}
