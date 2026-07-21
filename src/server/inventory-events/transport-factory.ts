import "server-only";

import type { InventoryEventEnvironment } from "@/env/schema";
import type { InventoryInvalidationEvent } from "@/features/inventory-events/event";
import { serializeInventoryEvent } from "@/features/inventory-events/event";
import { createRedisConnection } from "@/lib/redis";
import {
  RedisInventoryEventTransport,
  type InventoryEventTransport,
} from "@/server/inventory-events/redis-transport";
import {
  inventoryEventDedupKey,
  inventoryStreamKey,
} from "@/lib/redis";

/**
 * Transport selection for inventory invalidation events.
 *
 * A resident worker opens one Redis connection and keeps it for its lifetime.
 * A serverless function cannot: it may be invoked concurrently across many
 * isolates, each with its own module scope, and an unbounded socket per
 * invocation is how a free-tier Redis connection limit gets exhausted in one
 * traffic spike.
 *
 * So this module offers three transports and picks the safest available:
 *
 *  1. **REST** (`UPSTASH_REDIS_REST_URL`) — stateless HTTP, no socket
 *     lifecycle, ideal for a request or job path. Preferred when configured.
 *  2. **TCP** (`REDIS_URL`) — a lazily created, module-scoped connection reused
 *     across invocations of the same warm isolate. Required by BullMQ and the
 *     realtime gateway, which need real Redis semantics.
 *  3. **Noop** — Redis is unavailable or unconfigured.
 *
 * The third deserves explanation, because "silently dropping events" would
 * normally be indefensible. It is safe here specifically because the outbox is
 * the authority: `dispatchInventoryEventBatch` marks a row processed only if
 * `publish` resolved, so a transport that *throws* leaves the row pending for
 * retry. The noop transport therefore throws rather than pretending to succeed.
 * Redis is a delivery accelerator; PostgreSQL decides what is true, and clients
 * that never hear an event fall back to authoritative polling.
 */

/** A transport that refuses rather than silently discarding an event. */
export class UnavailableInventoryEventTransport implements InventoryEventTransport {
  constructor(private readonly reason: string) {}

  async publish(): Promise<void> {
    // Throwing keeps the outbox row pending and retryable. Returning quietly
    // would mark it processed and lose the invalidation permanently.
    throw new Error(`Inventory event transport unavailable: ${this.reason}`);
  }
}

/**
 * Upstash REST transport.
 *
 * Runs the same dedup-then-XADD sequence as the TCP transport, via Upstash's
 * Lua endpoint, so both paths share one deduplication and stream-trimming
 * policy. No socket is opened and nothing is retained between calls.
 */
export class UpstashRestInventoryEventTransport implements InventoryEventTransport {
  private static readonly SCRIPT = `
local inserted = redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1])
if inserted then
  return redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[2], '*', 'event', ARGV[3])
end
return ''
`;

  constructor(
    private readonly restUrl: string,
    private readonly restToken: string,
    private readonly environment: InventoryEventEnvironment,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async publish(event: InventoryInvalidationEvent): Promise<void> {
    const body = [
      "EVAL",
      UpstashRestInventoryEventTransport.SCRIPT,
      "2",
      inventoryEventDedupKey(this.environment.REDIS_STREAM_PREFIX, event.eventId),
      inventoryStreamKey(this.environment.REDIS_STREAM_PREFIX),
      String(this.environment.REDIS_EVENT_DEDUP_TTL_SECONDS),
      String(this.environment.REDIS_STREAM_MAX_LENGTH),
      serializeInventoryEvent(event),
    ];

    const response = await this.fetchImpl(this.restUrl, {
      method: "POST",
      headers: {
        // The token is a bearer credential; it appears only here and is never
        // logged, echoed into an error, or attached to a metric.
        Authorization: `Bearer ${this.restToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      // The status alone. An Upstash error body can quote the command, which
      // carries the stream key and the serialized event.
      throw new Error(`Upstash REST publish failed with status ${response.status}`);
    }
  }
}

/**
 * Module-scoped connection reused across invocations of a warm isolate.
 *
 * `lazyConnect` means constructing this opens nothing; the socket appears on
 * first use and is then shared, which is the behaviour that keeps a serverless
 * deployment inside a free-tier connection limit.
 */
let sharedConnection: ReturnType<typeof createRedisConnection> | null = null;

function getSharedRedisConnection(environment: InventoryEventEnvironment) {
  sharedConnection ??= createRedisConnection({
    environment,
    connectionName: "seatflow-serverless",
  });
  return sharedConnection;
}

/** Test seam. Production code never needs to reset the shared connection. */
export function resetSharedRedisConnection() {
  const previous = sharedConnection;
  sharedConnection = null;
  return previous;
}

export type TransportKind = "rest" | "tcp" | "unavailable";

export function selectTransportKind(environment: {
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  REDIS_URL?: string;
}): TransportKind {
  if (environment.UPSTASH_REDIS_REST_URL && environment.UPSTASH_REDIS_REST_TOKEN) {
    return "rest";
  }
  if (environment.REDIS_URL) return "tcp";
  return "unavailable";
}

export async function createInventoryEventTransport(
  environment: InventoryEventEnvironment,
): Promise<InventoryEventTransport> {
  switch (selectTransportKind(environment)) {
    case "rest":
      return new UpstashRestInventoryEventTransport(
        environment.UPSTASH_REDIS_REST_URL!,
        environment.UPSTASH_REDIS_REST_TOKEN!,
        environment,
      );
    case "tcp":
      return new RedisInventoryEventTransport(
        getSharedRedisConnection(environment),
        environment,
      );
    case "unavailable":
      return new UnavailableInventoryEventTransport("no Redis endpoint is configured");
  }
}
