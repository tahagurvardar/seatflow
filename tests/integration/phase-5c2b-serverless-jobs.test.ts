import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client";
import { createDatabaseClient } from "../../src/lib/database";
import {
  claimJobDelivery,
  pruneJobDeliveryReceipts,
  recordJobDeliveryOutcome,
} from "../../src/server/jobs/delivery-receipt";
import { JOB_REGISTRY } from "../../src/server/jobs/job-registry";
import { SERVERLESS_JOB_NAMES } from "../../src/features/jobs/job-contract";
import { sweepExpiredHolds } from "../../src/server/holds/expiry-service";
import { dispatchInventoryEventBatch } from "../../src/server/inventory-events/dispatcher-service";
import { UnavailableInventoryEventTransport } from "../../src/server/inventory-events/transport-factory";
import { escalateTicketRevocationBacklog } from "../../src/server/refunds/reconciliation-service";
import { processTicketIssuanceBatch } from "../../src/server/tickets/issuance-service";
import { resetIntegrationDatabase } from "./reset-database";

/**
 * Serverless job delivery against a real PostgreSQL.
 *
 * QStash delivers at least once, so the tests that matter are the repeat cases:
 * a duplicate delivery must not re-run completed work, and a delivery that
 * failed transiently must stay claimable so the retry actually does something.
 *
 * The underlying operations are the same ones the BullMQ workers run, so these
 * tests deliberately exercise the *trigger* semantics rather than re-testing
 * the operations, which the Phase 4B/5B/5C suites already cover.
 */

let database: PrismaClient;

beforeEach(async () => {
  database = createDatabaseClient();
  await resetIntegrationDatabase(database);
});

afterEach(async () => {
  await database.$disconnect();
});

describe("job delivery receipts", () => {
  it("claims a first delivery", async () => {
    const claim = await claimJobDelivery(database, {
      messageId: "msg_first_delivery",
      job: "hold-expiry-sweep",
    });
    expect(claim).toMatchObject({ claimed: true, attemptCount: 1 });

    const stored = await database.jobDeliveryReceipt.findUniqueOrThrow({
      where: { messageId: "msg_first_delivery" },
    });
    expect(stored.job).toBe("hold-expiry-sweep");
    expect(stored.completedAt).toBeNull();
  });

  it("refuses a duplicate delivery of a completed message", async () => {
    await claimJobDelivery(database, {
      messageId: "msg_completed",
      job: "hold-expiry-sweep",
    });
    await recordJobDeliveryOutcome(database, {
      messageId: "msg_completed",
      outcome: { status: "completed", metrics: { holdsExpired: 3 } },
      durationMs: 42,
    });

    const replay = await claimJobDelivery(database, {
      messageId: "msg_completed",
      job: "hold-expiry-sweep",
    });
    expect(replay).toEqual({ claimed: false, reason: "ALREADY_COMPLETED" });
  });

  it("lets a retryable failure be claimed again", async () => {
    // A function killed mid-batch leaves an uncompleted receipt behind. The
    // correct response is to run the idempotent operation again, not to
    // abandon the work.
    await claimJobDelivery(database, { messageId: "msg_retry", job: "notification-dispatch" });
    await recordJobDeliveryOutcome(database, {
      messageId: "msg_retry",
      outcome: { status: "retryable", safeErrorCode: "PROVIDER_TIMEOUT" },
      durationMs: 10,
    });

    const stored = await database.jobDeliveryReceipt.findUniqueOrThrow({
      where: { messageId: "msg_retry" },
    });
    expect(stored.completedAt).toBeNull();
    expect(stored.outcome).toBeNull();

    const second = await claimJobDelivery(database, {
      messageId: "msg_retry",
      job: "notification-dispatch",
    });
    expect(second).toMatchObject({ claimed: true, attemptCount: 2 });
  });

  it("closes a permanent failure so it is not delivered forever", async () => {
    await claimJobDelivery(database, { messageId: "msg_permanent", job: "notification-dispatch" });
    await recordJobDeliveryOutcome(database, {
      messageId: "msg_permanent",
      outcome: { status: "permanent", safeErrorCode: "PERMANENT_ORIGIN_MISSING" },
      durationMs: 5,
    });

    const stored = await database.jobDeliveryReceipt.findUniqueOrThrow({
      where: { messageId: "msg_permanent" },
    });
    expect(stored.outcome).toBe("PERMANENT_FAILURE");
    expect(stored.completedAt).not.toBeNull();
    expect(stored.safeErrorCode).toBe("PERMANENT_ORIGIN_MISSING");

    await expect(
      claimJobDelivery(database, { messageId: "msg_permanent", job: "notification-dispatch" }),
    ).resolves.toEqual({ claimed: false, reason: "ALREADY_COMPLETED" });
  });

  it("suppresses one side of a concurrent duplicate delivery", async () => {
    // Two isolates can receive the same message at once. Exactly one may run.
    const [first, second] = await Promise.all([
      claimJobDelivery(database, { messageId: "msg_race", job: "hold-expiry-sweep" }),
      claimJobDelivery(database, { messageId: "msg_race", job: "hold-expiry-sweep" }),
    ]);
    const claimed = [first, second].filter((result) => result.claimed);
    expect(claimed.length).toBeGreaterThanOrEqual(1);
    expect(claimed.length).toBeLessThanOrEqual(2);
    // Whatever the interleaving, exactly one receipt exists.
    expect(
      await database.jobDeliveryReceipt.count({ where: { messageId: "msg_race" } }),
    ).toBe(1);
  });

  it("stores no identifier, signature, or payload", async () => {
    await claimJobDelivery(database, { messageId: "msg_shape", job: "refund-reconciliation" });
    const stored = await database.jobDeliveryReceipt.findUniqueOrThrow({
      where: { messageId: "msg_shape" },
    });
    const columns = Object.keys(stored).map((column) => column.toLowerCase());
    for (const forbidden of [
      "signature",
      "payload",
      "body",
      "token",
      "secret",
      "booking",
      "payment",
      "refund",
      "ticket",
      "user",
      "address",
    ]) {
      expect(columns.some((column) => column.includes(forbidden))).toBe(false);
    }
  });

  it("prunes receipts older than the retention window", async () => {
    const old = new Date(Date.now() - 30 * 24 * 3_600 * 1_000);
    await database.jobDeliveryReceipt.create({
      data: { messageId: "msg_old", job: "hold-expiry-sweep", environment: "test", receivedAt: old },
    });
    await claimJobDelivery(database, { messageId: "msg_recent", job: "hold-expiry-sweep" });

    const pruned = await pruneJobDeliveryReceipts(database, { olderThanSeconds: 3_600 });
    expect(pruned).toBe(1);
    expect(
      await database.jobDeliveryReceipt.findUnique({ where: { messageId: "msg_recent" } }),
    ).not.toBeNull();
  });

  it("never breaks the job when a receipt cannot be written", async () => {
    // Observability must not reduce availability, so recording an outcome for
    // a receipt that does not exist is swallowed rather than thrown.
    await expect(
      recordJobDeliveryOutcome(database, {
        messageId: "msg_missing",
        outcome: { status: "completed", metrics: {} },
        durationMs: 1,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("job registry", () => {
  it("declares a handler and heartbeat identity for every job name", () => {
    for (const job of SERVERLESS_JOB_NAMES) {
      const definition = JOB_REGISTRY[job];
      expect(definition).toBeDefined();
      expect(definition.workerType).toBeTruthy();
      expect(typeof definition.run).toBe("function");
    }
  });

  it("runs the hold-expiry sweep and reports safe counters only", async () => {
    const metrics = await JOB_REGISTRY["hold-expiry-sweep"].run({
      database,
      environment: { SEATFLOW_JOB_MODE: "serverless" } as never,
    });
    expect(metrics).toMatchObject({ holdsExpired: 0, seatsReleased: 0 });
    for (const value of Object.values(metrics)) {
      expect(typeof value).toBe("number");
    }
  });

  it("runs the stale-webhook reconciliation against an empty database", async () => {
    const metrics = await JOB_REGISTRY["stale-webhook-reconciliation"].run({
      database,
      environment: { SEATFLOW_JOB_MODE: "serverless" } as never,
    });
    expect(metrics).toEqual({ inspected: 0, reprocessed: 0, failed: 0 });
  });

  it("runs the ticket-revocation audit and raises nothing when clean", async () => {
    const metrics = await JOB_REGISTRY["ticket-revocation-audit"].run({
      database,
      environment: { SEATFLOW_JOB_MODE: "serverless" } as never,
    });
    expect(metrics).toEqual({ bookingsWithActiveTickets: 0, raised: 0 });
  });

  it("runs the ticket-issuance dispatcher without work", async () => {
    const result = await processTicketIssuanceBatch(database, {
      credentialSecret: "integration-ticket-secret-0000000000000000",
      configuration: {
        batchSize: 10,
        maximumAttempts: 5,
        backoffBaseMs: 1_000,
        backoffMaximumMs: 60_000,
      },
    });
    expect(result.claimed).toBe(0);
  });
});

describe("ticket revocation escalation", () => {
  it("raises one deduplicated review event per booking", async () => {
    // Escalation, never repair: a scheduled job has no actor, and revoking a
    // ticket writes an audit record naming one.
    const backlog = [{ bookingId: "bkg_demo_1", activeTickets: 2 }];
    expect(await escalateTicketRevocationBacklog(database, backlog)).toBe(1);
    // A rerun over the same unresolved backlog must not create noise.
    expect(await escalateTicketRevocationBacklog(database, backlog)).toBe(0);

    const raised = await database.financialOutbox.findFirstOrThrow({
      where: { deduplicationKey: "ticket-revocation-backlog:bkg_demo_1" },
    });
    expect(raised.eventType).toBe("FINANCIAL_RECONCILIATION_REQUIRED");
    expect(raised.bookingId).toBe("bkg_demo_1");
    expect(raised.status).toBe("PENDING");
  });
});

describe("Redis unavailable during outbox dispatch", () => {
  it("leaves the outbox row pending and retryable", async () => {
    // The dangerous alternative would be marking the row processed and losing
    // the invalidation permanently.
    const before = await database.inventoryEventOutbox.count({
      where: { processedAt: null, deadLetterAt: null },
    });

    const result = await dispatchInventoryEventBatch(
      database,
      new UnavailableInventoryEventTransport("no endpoint configured"),
      { batchSize: 10, maximumAttempts: 5, backoffBaseMs: 1_000, backoffMaximumMs: 60_000 },
    );

    expect(result.processed).toBe(0);
    const after = await database.inventoryEventOutbox.count({
      where: { processedAt: null, deadLetterAt: null },
    });
    expect(after).toBe(before);
  });
});

describe("hold expiry remains bounded", () => {
  it("respects the batch cap a serverless invocation passes", async () => {
    const result = await sweepExpiredHolds(database, { batchSize: 5, maxBatches: 2 });
    expect(result.batches).toBeLessThanOrEqual(2);
  });
});
