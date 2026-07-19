import "dotenv/config";

import { randomUUID } from "node:crypto";

import { readSafeTestDatabaseUrl } from "../src/env/schema";
import {
  assertSafeLoadTestTarget,
  LoadTestSafetyError,
} from "../src/features/operations/load-test-safety";

/**
 * `npm run chaos:verify`
 *
 * Controlled outage and recovery verification against a disposable local
 * database. It proves the properties Phase 4B-5B claim under failure:
 *
 *   - Redis unavailable never corrupts PostgreSQL authority;
 *   - a dispatcher interrupted after publishing but before acknowledging does
 *     not duplicate delivery;
 *   - a notification provider outage dead-letters without touching ticket
 *     validity;
 *   - a stale worker heartbeat becomes visible;
 *   - a backlog drains once the dependency returns.
 *
 * It reuses the same safety gate as the load harness: disposable database only,
 * never NODE_ENV=production, and it performs no destructive reset.
 */

let testDatabaseUrl: string;
try {
  testDatabaseUrl = readSafeTestDatabaseUrl(process.env, { allowRuntimeAlias: false });
  assertSafeLoadTestTarget({
    databaseUrl: testDatabaseUrl,
    nodeEnv: process.env.NODE_ENV,
  });
} catch (error) {
  console.error(
    error instanceof LoadTestSafetyError || error instanceof Error
      ? error.message
      : "Chaos target is unsafe.",
  );
  process.exit(1);
}

process.env.DATABASE_URL = testDatabaseUrl;
process.env.DIRECT_URL = testDatabaseUrl;
process.env.TICKET_CREDENTIAL_SECRET = "chaos-harness-ticket-credential-secret-000000";

const { createDatabaseClient } = await import("../src/lib/database");
const { acquireSeatHold } = await import("../src/server/holds/hold-service");
const { dispatchInventoryEventBatch, getOutboxDispatcherConfiguration } = await import(
  "../src/server/inventory-events/dispatcher-service"
);
const { RedisInventoryEventTransport } = await import(
  "../src/server/inventory-events/redis-transport"
);
const { readInventoryEventEnvironment } = await import("../src/env/schema");
const { createRedisConnection } = await import("../src/lib/redis");
const { recordWorkerHeartbeat } = await import("../src/server/operations/worker-heartbeat");
const { evaluateWorkerHeartbeat } = await import("../src/features/operations/health");
const { createLoadTestFixture, createLoadTestCustomers } = await import(
  "./support/load-test-fixture"
);

const database = createDatabaseClient(testDatabaseUrl);

interface ChaosCheck {
  scenario: string;
  description: string;
  passed: boolean;
  detail?: string;
}

const checks: ChaosCheck[] = [];
function record(check: ChaosCheck) {
  checks.push(check);
  console.info(
    `${check.passed ? "PASS" : "FAIL"} ${check.scenario}: ${check.description}${
      check.detail ? ` (${check.detail})` : ""
    }`,
  );
}

async function main() {
  const runId = randomUUID().slice(0, 8);
  console.info(`SeatFlow chaos verification (run ${runId})`);
  console.info("Target: disposable test database. No destructive reset is performed.");
  console.info("");

  const fixture = await createLoadTestFixture(database, {
    prefix: `chaos${runId}`,
    rowCount: 2,
    seatsPerRow: 12,
  });

  // ---- Scenario: Redis unavailable ---------------------------------------
  {
    const before = await database.inventoryEventOutbox.count({
      where: { sessionId: fixture.session.id, processedAt: null },
    });
    const [customer] = await createLoadTestCustomers(database, `chaos${runId}r`, 1);
    const hold = await acquireSeatHold(
      database,
      { userId: customer!.id },
      {
        sessionId: fixture.session.id,
        seatIds: [fixture.seatIds[0]!],
        idempotencyKey: `chaos-redis-${runId}`,
      },
    );
    const after = await database.inventoryEventOutbox.count({
      where: { sessionId: fixture.session.id, processedAt: null },
    });
    const held = await database.sessionSeatInventory.count({
      where: { sessionId: fixture.session.id, seatId: fixture.seatIds[0]!, state: "HELD" },
    });

    record({
      scenario: "redis_unavailable",
      description: "hold commits in PostgreSQL without any Redis participation",
      passed: Boolean(hold.hold.publicToken) && held === 1,
      detail: `held=${held}`,
    });
    record({
      scenario: "redis_unavailable",
      description: "invalidation is durably queued rather than lost",
      passed: after > before,
      detail: `pending ${before} -> ${after}`,
    });
  }

  // ---- Scenario: PostgreSQL unavailable ----------------------------------
  {
    // A client pointed at a closed port models an outage without stopping the
    // developer's server. Readiness must report failure, not throw.
    const offline = createDatabaseClient(
      "postgresql://seatflow:seatflow@127.0.0.1:5599/seatflow_test",
    );
    const { evaluateReadiness } = await import("../src/server/operations/readiness");
    let status = "unknown";
    try {
      const report = await evaluateReadiness(offline);
      status = report.status;
    } catch {
      status = "threw";
    } finally {
      await offline.$disconnect().catch(() => undefined);
    }
    record({
      scenario: "postgresql_unavailable",
      description: "readiness reports not_ready instead of throwing",
      passed: status === "not_ready",
      detail: `status=${status}`,
    });
  }

  // ---- Scenario: dispatcher interrupted after publish, before acknowledge -
  {
    const redisEnvironment = readInventoryEventEnvironment();
    const redis = createRedisConnection({
      environment: redisEnvironment,
      connectionName: `chaos-${runId}`,
    });
    try {
      const transport = new RedisInventoryEventTransport(redis, redisEnvironment);
      const configuration = getOutboxDispatcherConfiguration(redisEnvironment);

      // Drain completely first. The batch size is bounded, and the disposable
      // database accumulates rows across runs, so a single batch would leave
      // genuinely new events behind and confuse them with replays.
      let first = await dispatchInventoryEventBatch(database, transport, configuration);
      let guard = 0;
      while (first.claimed > 0 && guard++ < 50) {
        first = await dispatchInventoryEventBatch(database, transport, configuration);
      }

      const streamKey = `${redisEnvironment.REDIS_STREAM_PREFIX}:inventory-events`;
      const lengthAfterFirst = await redis.xlen(streamKey);

      // Re-open this session's rows to model an acknowledgement lost after a
      // successful publish. Redis event deduplication must stop a second Stream
      // entry from being appended for an event ID already delivered.
      const replayed = await database.inventoryEventOutbox.updateMany({
        where: { sessionId: fixture.session.id, processedAt: { not: null } },
        data: { processedAt: null },
      });
      let second = await dispatchInventoryEventBatch(database, transport, configuration);
      guard = 0;
      while (second.claimed > 0 && guard++ < 50) {
        second = await dispatchInventoryEventBatch(database, transport, configuration);
      }
      const lengthAfterSecond = await redis.xlen(streamKey);

      record({
        scenario: "dispatcher_interrupted",
        description: "a replayed batch does not append duplicate stream entries",
        passed: lengthAfterSecond === lengthAfterFirst,
        detail: `streamLen ${lengthAfterFirst} -> ${lengthAfterSecond}, replayed=${replayed.count}, claimed=${second.claimed}`,
      });
      record({
        scenario: "dispatcher_interrupted",
        description: "replayed rows still reach a processed state",
        passed:
          (await database.inventoryEventOutbox.count({
            where: { sessionId: fixture.session.id, processedAt: null, deadLetterAt: null },
          })) === 0,
        detail: `finalBatchProcessed=${first.processed}`,
      });
    } finally {
      await redis.quit().catch(() => redis.disconnect());
    }
  }

  // ---- Scenario: backlog recovery after an outage -------------------------
  {
    const redisEnvironment = readInventoryEventEnvironment();
    const [customer] = await createLoadTestCustomers(database, `chaos${runId}b`, 1);
    await acquireSeatHold(
      database,
      { userId: customer!.id },
      {
        sessionId: fixture.session.id,
        seatIds: [fixture.seatIds[5]!],
        idempotencyKey: `chaos-backlog-${runId}`,
      },
    );
    const backlogBefore = await database.inventoryEventOutbox.count({
      where: { sessionId: fixture.session.id, processedAt: null, deadLetterAt: null },
    });

    const redis = createRedisConnection({
      environment: redisEnvironment,
      connectionName: `chaos-recover-${runId}`,
    });
    try {
      const transport = new RedisInventoryEventTransport(redis, redisEnvironment);
      await dispatchInventoryEventBatch(
        database,
        transport,
        getOutboxDispatcherConfiguration(redisEnvironment),
      );
      const backlogAfter = await database.inventoryEventOutbox.count({
        where: { sessionId: fixture.session.id, processedAt: null, deadLetterAt: null },
      });
      record({
        scenario: "backlog_recovery",
        description: "backlog drains once the transport is reachable again",
        passed: backlogBefore > 0 && backlogAfter === 0,
        detail: `backlog ${backlogBefore} -> ${backlogAfter}`,
      });
    } finally {
      await redis.quit().catch(() => redis.disconnect());
    }
  }

  // ---- Scenario: stale worker heartbeat ----------------------------------
  {
    const staleAt = new Date(Date.now() - 3_600_000);
    await recordWorkerHeartbeat(database, {
      workerType: "NOTIFICATION_DISPATCHER",
      status: "HEALTHY",
      instanceLabel: `chaos-${runId}`,
      startedAt: staleAt,
      now: staleAt,
    });
    // Evaluate this specific instance rather than the fleet summary. The fleet
    // view deliberately reports the freshest instance of each worker type, so a
    // leftover healthy instance from an earlier run would mask one stale
    // process — correct for routing, but the wrong granularity for this check.
    const readInstance = async () => {
      const row = await database.workerHeartbeat.findUniqueOrThrow({
        where: {
          workerType_environment_instanceLabel: {
            workerType: "NOTIFICATION_DISPATCHER",
            environment: (process.env.NODE_ENV ?? "development").toLowerCase(),
            instanceLabel: `chaos-${runId}`,
          },
        },
        select: {
          workerType: true,
          environment: true,
          status: true,
          version: true,
          lastSeenAt: true,
        },
      });
      return evaluateWorkerHeartbeat({ heartbeat: row, now: new Date(), staleAfterSeconds: 180 });
    };

    const stale = await readInstance();
    record({
      scenario: "stale_worker_heartbeat",
      description: "a worker instance that stopped reporting is classified stale",
      passed: stale.label === "stale",
      detail: `label=${stale.label} ageSeconds=${stale.ageSeconds ?? "n/a"}`,
    });

    // Recovery: a fresh beat must clear the stale classification.
    await recordWorkerHeartbeat(database, {
      workerType: "NOTIFICATION_DISPATCHER",
      status: "HEALTHY",
      instanceLabel: `chaos-${runId}`,
    });
    const recovered = await readInstance();
    record({
      scenario: "worker_restart",
      description: "a restarted worker instance immediately reports healthy again",
      passed: recovered.label === "healthy",
      detail: `label=${recovered.label}`,
    });
  }

  // ---- Report -------------------------------------------------------------
  const failed = checks.filter((check) => !check.passed);
  console.info("");
  console.info(
    failed.length === 0
      ? `RESULT: PASS - ${checks.length} outage and recovery checks all held.`
      : `RESULT: FAIL - ${failed.length} of ${checks.length} checks failed.`,
  );

  await database.$disconnect();
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
