import "dotenv/config";

import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import { Server } from "socket.io";

import {
  readApplicationEnvironment,
  readInventoryEventEnvironment,
} from "../src/env/schema";
import { parseInventoryEvent } from "../src/features/inventory-events/event";
import { verifyRealtimeRoomTicket } from "../src/features/inventory-events/room-ticket";
import { getDatabase } from "../src/lib/database";
import { startWorkerHeartbeat } from "../src/server/operations/worker-heartbeat";
import {
  createRedisConnection,
  ensureRedisConnected,
  inventoryStreamKey,
  realtimeClientCountKey,
} from "../src/lib/redis";

const applicationEnvironment = readApplicationEnvironment();
const environment = readInventoryEventEnvironment();
const allowedOrigin = new URL(
  process.env.NEXT_PUBLIC_APP_URL ?? applicationEnvironment.BETTER_AUTH_URL,
).origin;
const redis = createRedisConnection({
  environment,
  connectionName: `${environment.REDIS_WORKER_ID}:realtime-gateway`,
});
const streamKey = inventoryStreamKey(environment.REDIS_STREAM_PREFIX);
const clientMetricKey = realtimeClientCountKey(
  environment.REDIS_STREAM_PREFIX,
  environment.REDIS_WORKER_ID,
);
const connectionsByAddress = new Map<string, number>();
const seenEventIds = new Set<string>();
let connectedClients = 0;
let redisLive = false;
let stopping = false;

const httpServer = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(redisLive ? 200 : 503, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        status: redisLive ? "live" : "fallback",
        redis: redisLive,
        connectedClients,
      }),
    );
    return;
  }
  response.writeHead(404).end();
});

const io = new Server(httpServer, {
  cors: { origin: allowedOrigin, methods: ["GET", "POST"], credentials: false },
  maxHttpBufferSize: 4_096,
  transports: ["websocket", "polling"],
  allowRequest(request, callback) {
    const origin = request.headers.origin;
    callback(null, origin === allowedOrigin);
  },
});

io.use((socket, next) => {
  const ticket = typeof socket.handshake.auth.ticket === "string"
    ? socket.handshake.auth.ticket
    : "";
  const payload = verifyRealtimeRoomTicket({
    ticket,
    secret: applicationEnvironment.BETTER_AUTH_SECRET,
  });
  if (!payload) return next(new Error("Unauthorized inventory room."));

  const address = socket.handshake.address.slice(0, 128);
  const current = connectionsByAddress.get(address) ?? 0;
  if (current >= environment.REALTIME_MAX_CONNECTIONS_PER_IP) {
    return next(new Error("Inventory connection limit reached."));
  }
  socket.data.sessionId = payload.sessionId;
  socket.data.address = address;
  return next();
});

async function publishClientMetric() {
  try {
    await ensureRedisConnected(redis);
    await redis.set(clientMetricKey, String(connectedClients), "EX", 60);
  } catch {
    // The gateway health response still exposes its local count during outage.
  }
}

io.on("connection", (socket) => {
  const sessionId = String(socket.data.sessionId);
  const address = String(socket.data.address);
  connectionsByAddress.set(address, (connectionsByAddress.get(address) ?? 0) + 1);
  connectedClients += 1;
  void socket.join(`inventory:${sessionId}`);
  socket.emit("inventory:transport-state", {
    state: redisLive ? "live" : "fallback",
    serverTimestamp: new Date().toISOString(),
  });
  void publishClientMetric();

  socket.once("disconnect", () => {
    const remaining = Math.max(0, (connectionsByAddress.get(address) ?? 1) - 1);
    if (remaining === 0) connectionsByAddress.delete(address);
    else connectionsByAddress.set(address, remaining);
    connectedClients = Math.max(0, connectedClients - 1);
    void publishClientMetric();
  });
});

function setRedisState(live: boolean) {
  if (redisLive === live) return;
  redisLive = live;
  io.emit("inventory:transport-state", {
    state: live ? "live" : "fallback",
    serverTimestamp: new Date().toISOString(),
  });
}

redis.on("close", () => setRedisState(false));
redis.on("reconnecting", () => setRedisState(false));
redis.on("error", () => setRedisState(false));

async function consumeInventoryEvents() {
  // Snapshot an explicit stream ID before announcing readiness. Unlike `$`,
  // an explicit ID cannot lose an event published between initialization and
  // the first blocking XREAD call.
  let cursor: string | null = null;
  while (!stopping) {
    try {
      await ensureRedisConnected(redis);
      if (cursor === null) {
        const latest = await redis.xrevrange(streamKey, "+", "-", "COUNT", 1);
        cursor = latest[0]?.[0] ?? "0-0";
      }
      setRedisState(true);
      const response = (await redis.xread(
        "COUNT",
        100,
        "BLOCK",
        5_000,
        "STREAMS",
        streamKey,
        cursor,
      )) as Array<[string, Array<[string, string[]]>]> | null;
      setRedisState(true);
      for (const [, entries] of response ?? []) {
        for (const [streamId, fields] of entries) {
          cursor = streamId;
          const eventIndex = fields.indexOf("event");
          if (eventIndex < 0 || !fields[eventIndex + 1]) continue;
          try {
            const event = parseInventoryEvent(fields[eventIndex + 1]);
            if (seenEventIds.has(event.eventId)) continue;
            seenEventIds.add(event.eventId);
            if (seenEventIds.size > 2_000) {
              const oldest = seenEventIds.values().next().value;
              if (oldest) seenEventIds.delete(oldest);
            }
            io.to(`inventory:${event.sessionId}`).emit(
              "inventory:invalidated",
              event,
            );
          } catch {
            // Forged or oversized stream entries are never broadcast.
          }
        }
      }
    } catch {
      setRedisState(false);
      await delay(1_000);
    }
  }
}

// Phase 5C1: durable gateway heartbeat. The ephemeral Redis client gauge
// disappears during exactly the Redis outage an operator most needs to see, so
// gateway liveness is recorded in PostgreSQL instead.
const gatewayDatabase = getDatabase();
const stopHeartbeat = startWorkerHeartbeat(gatewayDatabase, {
  workerType: "REALTIME_GATEWAY",
});

const metricInterval = setInterval(() => void publishClientMetric(), 30_000);
httpServer.listen(environment.REALTIME_GATEWAY_PORT, () => {
  console.info(
    `SeatFlow realtime gateway listening on port ${environment.REALTIME_GATEWAY_PORT}.`,
  );
});
void consumeInventoryEvents();

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(metricInterval);
  await stopHeartbeat();
  await io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await redis.quit().catch(() => redis.disconnect());
  await gatewayDatabase.$disconnect();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
