import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import type Redis from "ioredis";
import { io as createSocketClient, type Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readInventoryEventEnvironment } from "../../src/env/schema";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { DEFAULT_HOLD_CONFIGURATION } from "../../src/features/holds/config";
import { createSafeInventoryEventPayload, parseInventoryEvent } from "../../src/features/inventory-events/event";
import { createRealtimeRoomTicket } from "../../src/features/inventory-events/room-ticket";
import { createDatabaseClient } from "../../src/lib/database";
import { createRedisConnection, inventoryStreamKey } from "../../src/lib/redis";
import { acquireSeatHold } from "../../src/server/holds/hold-service";
import { createCheckoutAndPayment } from "../../src/server/payments/checkout-service";
import { LocalSignedPaymentProvider } from "../../src/server/payments/local-signed-provider";
import { processPaymentWebhook } from "../../src/server/payments/webhook-service";
import {
  createHoldExpiryQueue,
  createHoldExpiryWorker,
  HOLD_EXPIRY_JOB_NAME,
  registerHoldExpirySchedule,
} from "../../src/server/holds/expiry-queue";
import { dispatchInventoryEventBatch, getOutboxDispatcherConfiguration } from "../../src/server/inventory-events/dispatcher-service";
import { RedisInventoryEventTransport } from "../../src/server/inventory-events/redis-transport";
import { resetIntegrationDatabase } from "../integration/reset-database";
import { createRedisInventoryFixture, createRedisTestCustomer } from "./inventory-fixture";

const environment = readInventoryEventEnvironment();
const streamKey = inventoryStreamKey(environment.REDIS_STREAM_PREFIX);
const paymentProviderSecret = "phase-5a-redis-provider-secret-000000000000000000";
let database: PrismaClient;
let connections: Redis[] = [];
let gateway: ChildProcess | null = null;
let sockets: Socket[] = [];

function redisConnection(name: string, bullMq = false) {
  const connection = createRedisConnection({
    environment,
    connectionName: `${environment.REDIS_WORKER_ID}:${name}`,
    bullMq,
  });
  connection.on("error", () => {});
  connections.push(connection);
  return connection;
}

async function cleanRedisPrefix() {
  const redis = redisConnection("cleanup");
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      `${environment.REDIS_STREAM_PREFIX}:*`,
      "COUNT",
      200,
    );
    cursor = nextCursor;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== "0");
}

function event(input: { id: string; sessionId: string; type?: "HOLD_CREATED" | "HOLD_RELEASED" }) {
  return createSafeInventoryEventPayload({
    eventId: input.id,
    sessionId: input.sessionId,
    eventType: input.type ?? "HOLD_CREATED",
    now: new Date(),
  });
}

beforeEach(async () => {
  database = createDatabaseClient();
  await resetIntegrationDatabase(database);
  await cleanRedisPrefix();
});

afterEach(async () => {
  for (const socket of sockets) socket.disconnect();
  sockets = [];
  if (gateway && !gateway.killed) {
    gateway.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => gateway?.once("exit", resolve)),
      delay(2_000),
    ]);
  }
  gateway = null;
  await cleanRedisPrefix().catch(() => {});
  for (const connection of connections) connection.disconnect();
  connections = [];
  await database.$disconnect();
});

describe("Phase 4B real Redis Streams transport", () => {
  it("publishes safe events, preserves session identity, and deduplicates delivery", async () => {
    const redis = redisConnection("transport");
    const transport = new RedisInventoryEventTransport(redis, environment);
    const first = event({
      id: "550e8400-e29b-41d4-a716-446655440000",
      sessionId: "session-a",
    });
    const second = event({
      id: "59f6f47b-eec4-49fa-9b31-c4ea63f70a17",
      sessionId: "session-b",
    });
    await transport.publish(first);
    await transport.publish(second);
    await transport.publish(first);

    const entries = await redis.xrange(streamKey, "-", "+");
    expect(entries).toHaveLength(2);
    const events = entries.map(([, fields]) => {
      const index = fields.indexOf("event");
      return parseInventoryEvent(fields[index + 1]!);
    });
    expect(events.map((entry) => entry.sessionId)).toEqual(["session-a", "session-b"]);
    expect(new Set(events.map((entry) => entry.eventId)).size).toBe(2);
    expect(JSON.stringify(events)).not.toMatch(/email|userId|publicToken/i);
  });

  it("resumes a durable stream cursor after a client reconnect", async () => {
    const producer = redisConnection("reconnect-producer");
    const transport = new RedisInventoryEventTransport(producer, environment);
    await transport.publish(event({
      id: "7af81ca3-d7f0-46cd-8cfc-d00cd6406b30",
      sessionId: "session-a",
    }));
    const firstConsumer = redisConnection("reconnect-consumer-a");
    const first = await firstConsumer.xread("COUNT", 1, "STREAMS", streamKey, "0-0");
    const cursor = first?.[0]?.[1]?.[0]?.[0];
    expect(cursor).toBeTruthy();
    firstConsumer.disconnect();

    await transport.publish(event({
      id: "1210ca18-e5a5-43e2-ad41-bc43bc8bc1c4",
      sessionId: "session-a",
      type: "HOLD_RELEASED",
    }));
    const secondConsumer = redisConnection("reconnect-consumer-b");
    const resumed = await secondConsumer.xread(
      "COUNT",
      10,
      "STREAMS",
      streamKey,
      cursor!,
    );
    expect(resumed?.[0]?.[1]).toHaveLength(1);
    const fields = resumed![0]![1]![0]![1];
    expect(parseInventoryEvent(fields[fields.indexOf("event") + 1]!)).toMatchObject({
      eventType: "HOLD_RELEASED",
    });
  });
});

describe("Phase 4B realtime gateway with real Redis", () => {
  it("isolates session rooms and rejects an unsigned subscription", async () => {
    const port = 3_137;
    gateway = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "scripts/realtime-gateway.ts"],
      {
        cwd: process.cwd(),
        env: { ...process.env, REALTIME_GATEWAY_PORT: String(port) },
        stdio: "ignore",
      },
    );
    const healthUrl = `http://127.0.0.1:${port}/health`;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        if ((await fetch(healthUrl)).status === 200) break;
      } catch {}
      await delay(100);
    }
    expect((await fetch(healthUrl)).status).toBe(200);

    const secret = process.env.BETTER_AUTH_SECRET!;
    const socketOptions = (ticket: string) => ({
      auth: { ticket },
      transports: ["websocket" as const],
      extraHeaders: { Origin: process.env.BETTER_AUTH_URL! },
      reconnection: false,
    });
    const sessionA = createSocketClient(
      `http://127.0.0.1:${port}`,
      socketOptions(createRealtimeRoomTicket({ sessionId: "session-a", secret })),
    );
    const sessionB = createSocketClient(
      `http://127.0.0.1:${port}`,
      socketOptions(createRealtimeRoomTicket({ sessionId: "session-b", secret })),
    );
    const unauthorized = createSocketClient(
      `http://127.0.0.1:${port}`,
      socketOptions("forged-ticket"),
    );
    // Attach before awaiting the authorized sockets: a fast local rejection
    // can otherwise occur before this listener exists and leave the test hung.
    const rejected = new Promise<void>((resolve) =>
      unauthorized.once("connect_error", () => resolve()),
    );
    sockets.push(sessionA, sessionB, unauthorized);
    await Promise.all([
      new Promise<void>((resolve) => sessionA.once("connect", () => resolve())),
      new Promise<void>((resolve) => sessionB.once("connect", () => resolve())),
    ]);

    let leakedToSessionB = false;
    sessionB.on("inventory:invalidated", () => {
      leakedToSessionB = true;
    });
    const received = new Promise<unknown>((resolve) =>
      sessionA.once("inventory:invalidated", resolve),
    );
    const transport = new RedisInventoryEventTransport(
      redisConnection("gateway-producer"),
      environment,
    );
    const published = event({
      id: "8bbbca52-e2bb-4207-986b-6614594d7b1c",
      sessionId: "session-a",
    });
    await transport.publish(published);
    expect(await received).toEqual(published);
    await rejected;
    await delay(250);
    expect(leakedToSessionB).toBe(false);
  });
});

describe("Phase 4B Redis outage and BullMQ automation", () => {
  it("keeps PostgreSQL hold correctness during Redis failure and dispatches after recovery", async () => {
    const fixture = await createRedisInventoryFixture(database, "RedisOutage");
    const customer = await createRedisTestCustomer(database, "RedisOutage");
    const acquired = await acquireSeatHold(database, { userId: customer.id }, {
      sessionId: fixture.session.id,
      seatIds: [fixture.seatIds[0]],
      idempotencyKey: `redis-outage-${Date.now()}`,
    });
    expect(acquired.hold.live).toBe(true);
    expect(
      await database.sessionSeatInventory.findUnique({
        where: { sessionId_seatId: { sessionId: fixture.session.id, seatId: fixture.seatIds[0]! } },
        select: { state: true },
      }),
    ).toEqual({ state: "HELD" });

    const badEnvironment = { ...environment, REDIS_URL: "redis://127.0.0.1:6398" };
    const badRedis = createRedisConnection({
      environment: badEnvironment,
      connectionName: "redis-integration:outage",
    });
    badRedis.on("error", () => {});
    connections.push(badRedis);
    const firstNow = new Date(Date.now() + 1_000);
    const failed = await dispatchInventoryEventBatch(
      database,
      new RedisInventoryEventTransport(badRedis, badEnvironment),
      { ...getOutboxDispatcherConfiguration(environment), batchSize: 100, backoffBaseMs: 100, backoffMaximumMs: 100 },
      firstNow,
    );
    expect(failed.failed).toBeGreaterThan(0);
    expect(acquired.hold.live).toBe(true);

    const recovered = await dispatchInventoryEventBatch(
      database,
      new RedisInventoryEventTransport(redisConnection("recovery"), environment),
      getOutboxDispatcherConfiguration(environment),
      new Date(firstNow.getTime() + 101),
    );
    expect(recovered.processed).toBeGreaterThan(0);
    expect(await database.inventoryEventOutbox.count({ where: { processedAt: null } })).toBe(0);
  });

  it("keeps a successful payment booking exact-once while Redis is unavailable and drains after recovery", async () => {
    const fixture = await createRedisInventoryFixture(database, "PaymentRedisOutage");
    const customer = await createRedisTestCustomer(database, "PaymentRedisOutage");
    const acquired = await acquireSeatHold(database, { userId: customer.id }, {
      sessionId: fixture.session.id,
      seatIds: fixture.seatIds.slice(0, 2),
      idempotencyKey: `payment-redis-outage-hold-${Date.now()}`,
    });
    const provider = new LocalSignedPaymentProvider(paymentProviderSecret, "test");
    const checkout = await createCheckoutAndPayment(
      database,
      provider,
      { userId: customer.id },
      {
        holdToken: acquired.hold.publicToken,
        idempotencyKey: `payment-redis-outage-checkout-${Date.now()}`,
      },
    );
    const attempt = await database.paymentAttempt.findFirstOrThrow({
      where: { orderId: checkout.order.orderId },
    });
    const delivery = provider.createSignedWebhook({
      providerIntentId: attempt.providerIntentId!,
      outcome: "success",
      amountMinor: attempt.amountMinor,
      currency: attempt.currency,
      eventId: "local_evt_payment_redis_outage",
    });

    const badEnvironment = { ...environment, REDIS_URL: "redis://127.0.0.1:6398" };
    const badRedis = createRedisConnection({
      environment: badEnvironment,
      connectionName: "redis-integration:payment-outage",
    });
    badRedis.on("error", () => {});
    connections.push(badRedis);

    const webhook = await processPaymentWebhook(database, provider, delivery);
    expect(webhook.outcome).toBe("BOOKED");
    await expect(database.booking.count()).resolves.toBe(1);
    await expect(database.bookingSeat.count()).resolves.toBe(2);
    await expect(database.sessionSeatInventory.count({ where: { state: "BOOKED" } })).resolves.toBe(2);

    const firstNow = new Date(Date.now() + 1_000);
    const failed = await dispatchInventoryEventBatch(
      database,
      new RedisInventoryEventTransport(badRedis, badEnvironment),
      { ...getOutboxDispatcherConfiguration(environment), batchSize: 100, backoffBaseMs: 100, backoffMaximumMs: 100 },
      firstNow,
    );
    expect(failed.failed).toBeGreaterThan(0);
    expect(await database.inventoryEventOutbox.count({ where: { processedAt: null } })).toBeGreaterThan(0);
    await expect(processPaymentWebhook(database, provider, delivery)).resolves.toMatchObject({ outcome: "BOOKED" });
    await expect(database.booking.count()).resolves.toBe(1);

    const recovered = await dispatchInventoryEventBatch(
      database,
      new RedisInventoryEventTransport(redisConnection("payment-recovery"), environment),
      getOutboxDispatcherConfiguration(environment),
      new Date(firstNow.getTime() + 101),
    );
    expect(recovered.processed).toBeGreaterThan(0);
    await expect(database.inventoryEventOutbox.count({ where: { processedAt: null } })).resolves.toBe(0);
    await expect(database.booking.count()).resolves.toBe(1);
  });

  it("runs repeated sweeps safely with two BullMQ workers", async () => {
    const fixture = await createRedisInventoryFixture(database, "BullMQ");
    const firstCustomer = await createRedisTestCustomer(database, "BullMQOne");
    const secondCustomer = await createRedisTestCustomer(database, "BullMQTwo");
    const acquiredAt = new Date(Date.now() + 500);
    const config = { ...DEFAULT_HOLD_CONFIGURATION, holdDurationMs: 1_000 };
    await acquireSeatHold(database, { userId: firstCustomer.id }, {
      sessionId: fixture.session.id,
      seatIds: [fixture.seatIds[0]],
      idempotencyKey: `bullmq-one-${Date.now()}`,
    }, { now: acquiredAt, config });
    await acquireSeatHold(database, { userId: secondCustomer.id }, {
      sessionId: fixture.session.id,
      seatIds: [fixture.seatIds[1]],
      idempotencyKey: `bullmq-two-${Date.now()}`,
    }, { now: acquiredAt, config });
    await delay(1_600);

    const queueConnection = redisConnection("bullmq-queue", true);
    const queue = createHoldExpiryQueue(queueConnection, environment);
    const firstWorker = createHoldExpiryWorker({
      database,
      connection: redisConnection("bullmq-worker-a", true),
      environment,
    });
    const secondWorker = createHoldExpiryWorker({
      database,
      connection: redisConnection("bullmq-worker-b", true),
      environment,
    });
    try {
      await registerHoldExpirySchedule(queue, environment);
      expect(await queue.getJobSchedulers()).toHaveLength(1);
      const completed = new Promise<void>((resolve, reject) => {
        let count = 0;
        const onComplete = () => {
          count += 1;
          if (count === 2) resolve();
        };
        firstWorker.on("completed", onComplete);
        secondWorker.on("completed", onComplete);
        firstWorker.on("failed", (_, error) => reject(error));
        secondWorker.on("failed", (_, error) => reject(error));
      });
      await queue.add(HOLD_EXPIRY_JOB_NAME, {}, { jobId: "redis-sweep-one" });
      await queue.add(HOLD_EXPIRY_JOB_NAME, {}, { jobId: "redis-sweep-two" });
      await completed;
      expect(await database.seatHold.count({ where: { status: "ACTIVE" } })).toBe(0);
      expect(await database.seatHold.count({ where: { status: "EXPIRED" } })).toBe(2);
      expect(
        await database.inventoryEventOutbox.count({ where: { eventType: "HOLD_EXPIRED" } }),
      ).toBe(2);
    } finally {
      await firstWorker.close();
      await secondWorker.close();
      await queue.close();
    }
  });
});
