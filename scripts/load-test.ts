import "dotenv/config";

import { randomUUID } from "node:crypto";

import {
  assertSafeLoadTestTarget,
  boundLoadTestParameters,
  evaluateScenario,
  LoadTestSafetyError,
  summarizeLatencies,
  type ScenarioOutcome,
  type ScenarioThresholds,
} from "../src/features/operations/load-test-safety";
import { readSafeTestDatabaseUrl } from "../src/env/schema";

/**
 * `npm run load:test`
 *
 * Controlled load and concurrency harness. It targets a disposable local
 * database only, refuses to run with NODE_ENV=production, and bounds its own
 * concurrency and duration.
 *
 * It measures throughput and latency, but its primary purpose is correctness
 * under contention. Each scenario asserts an invariant that must hold no matter
 * how much load is applied:
 *
 *   - one seat can have exactly one successful holder;
 *   - a duplicated checkout submission creates exactly one order;
 *   - a duplicated webhook storm creates exactly one booking;
 *   - concurrent scans of one credential accept exactly once;
 *   - a Redis outage leaves PostgreSQL authority intact.
 *
 * No real payment call, email, or customer datum is involved: the local signed
 * provider and synthetic `@example.com` identities are used throughout.
 */

function numericArgument(name: string) {
  const prefix = `--${name}=`;
  const entry = process.argv.find((value) => value.startsWith(prefix));
  return entry ? Number(entry.slice(prefix.length)) : undefined;
}

const bounds = boundLoadTestParameters({
  concurrency: numericArgument("concurrency"),
  durationSeconds: numericArgument("duration"),
  iterations: numericArgument("iterations"),
});
const asJson = process.argv.includes("--json");

// ---- Safety gate --------------------------------------------------------
let testDatabaseUrl: string;
try {
  testDatabaseUrl = readSafeTestDatabaseUrl(process.env, { allowRuntimeAlias: false });
  assertSafeLoadTestTarget({
    databaseUrl: testDatabaseUrl,
    baseUrl: process.env.LOAD_TEST_BASE_URL,
    nodeEnv: process.env.NODE_ENV,
    allowNonLocalTarget: process.argv.includes("--allow-non-local"),
  });
} catch (error) {
  console.error(
    error instanceof LoadTestSafetyError || error instanceof Error
      ? error.message
      : "Load-test target is unsafe.",
  );
  process.exit(1);
}

// The database client reads DATABASE_URL at construction; point it at the
// disposable target before anything imports it.
process.env.DATABASE_URL = testDatabaseUrl;
process.env.DIRECT_URL = testDatabaseUrl;

/**
 * Webhook fulfillment performs best-effort immediate ticket issuance using
 * TICKET_CREDENTIAL_SECRET when no secret is passed explicitly. Without this
 * override the harness would issue credentials under the developer's ambient
 * secret and then derive its scan plaintext from its own, making every scan
 * INVALID. Pinning the variable keeps the run hermetic and reproducible on any
 * machine. It is scoped to this process and targets a disposable database.
 */
process.env.TICKET_CREDENTIAL_SECRET = "load-harness-ticket-credential-secret-0000000000";

const { createDatabaseClient, disconnectDatabase } = await import("../src/lib/database");
const { acquireSeatHold } = await import("../src/server/holds/hold-service");
const { getSeatSelectionView } = await import("../src/server/holds/hold-queries");
const { createCheckoutAndPayment } = await import("../src/server/payments/checkout-service");
const { LocalSignedPaymentProvider } = await import("../src/server/payments/local-signed-provider");
const { processPaymentWebhook } = await import("../src/server/payments/webhook-service");
const { processTicketIssuanceForBooking } = await import("../src/server/tickets/issuance-service");
const { validateTicketEntry } = await import("../src/server/tickets/validation-service");
const { deriveTicketCredential } = await import("../src/features/tickets/credential");
const { createLoadTestFixture, createLoadTestCustomers } = await import(
  "./support/load-test-fixture"
);

const database = createDatabaseClient(testDatabaseUrl);
const paymentSecret = "load-harness-payment-provider-secret-000000000000";
const credentialSecret = "load-harness-ticket-credential-secret-0000000000";

const DEFAULT_THRESHOLDS: ScenarioThresholds = {
  maximumErrorRate: 0.02,
  maximumP95Ms: 3_000,
};

async function timed<Result>(operation: () => Promise<Result>) {
  const startedAt = performance.now();
  try {
    const value = await operation();
    return { ok: true as const, value, durationMs: performance.now() - startedAt };
  } catch (error) {
    return { ok: false as const, error, durationMs: performance.now() - startedAt };
  }
}

/** Run `count` operations with at most `concurrency` in flight. */
async function runConcurrently<Result>(
  count: number,
  concurrency: number,
  operation: (index: number) => Promise<Result>,
) {
  const results: Array<Awaited<ReturnType<typeof timed<Result>>>> = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (true) {
      const index = next++;
      if (index >= count) return;
      results.push(await timed(() => operation(index)));
    }
  });
  await Promise.all(workers);
  return results;
}

interface MeasuredScenario {
  outcome: ScenarioOutcome;
  thresholds: ScenarioThresholds;
}

/**
 * `thresholds` is per scenario because a rejection is not always an error. In a
 * contention scenario every loser *should* be rejected — that is the invariant
 * being proven — so its error budget is deliberately wide while its correctness
 * assertion stays strict.
 */
function toOutcome(
  name: string,
  results: Array<{ ok: boolean; durationMs: number }>,
  invariants: ScenarioOutcome["invariants"],
  thresholds: ScenarioThresholds = DEFAULT_THRESHOLDS,
): MeasuredScenario {
  return {
    outcome: {
      name,
      operations: results.length,
      errors: results.filter((entry) => !entry.ok).length,
      latency: summarizeLatencies(results.map((entry) => entry.durationMs)),
      invariants,
    },
    thresholds,
  };
}

/** Losers in a contention scenario are the expected outcome, not failures. */
const CONTENTION_THRESHOLDS: ScenarioThresholds = {
  maximumErrorRate: 1,
  maximumP95Ms: 3_000,
};

const outcomes: MeasuredScenario[] = [];

async function main() {
  const runId = randomUUID().slice(0, 8);
  console.info(`SeatFlow load harness (run ${runId})`);
  console.info(
    `Target: disposable test database | concurrency=${bounds.concurrency} iterations=${bounds.iterations}`,
  );
  console.info("");

  const fixture = await createLoadTestFixture(database, {
    prefix: `load${runId}`,
    rowCount: 4,
    seatsPerRow: 20,
  });
  /**
   * A partial unique index permits at most one active hold per customer per
   * session, so every concurrent holder must be a distinct customer. Scenarios
   * allocate their own disjoint pool rather than sharing one.
   */
  let customerPoolSequence = 0;
  const allocateCustomers = async (count: number) => {
    const pool = await createLoadTestCustomers(
      database,
      `load${runId}p${(customerPoolSequence += 1)}`,
      count,
    );
    return pool;
  };

  // ---- Scenario: public catalogue reads ---------------------------------
  {
    const { getPublicEvents } = await import("../src/server/events/public-event-service");
    const results = await runConcurrently(bounds.iterations, bounds.concurrency, () =>
      getPublicEvents(),
    );
    outcomes.push(
      toOutcome("public_catalogue_read", results, [
        {
          description: "every catalogue read succeeded",
          passed: results.every((entry) => entry.ok),
        },
      ]),
    );
  }

  // ---- Scenario: session inventory snapshot reads ------------------------
  {
    const results = await runConcurrently(bounds.iterations, bounds.concurrency, () =>
      getSeatSelectionView(database, null, {
        publicSlug: fixture.publicSlug,
        sessionId: fixture.session.id,
      }),
    );
    outcomes.push(
      toOutcome("session_inventory_snapshot", results, [
        {
          description: "every snapshot returned a view",
          passed: results.every((entry) => entry.ok && entry.value !== null),
        },
      ]),
    );
  }

  // ---- Scenario: same-seat contention ------------------------------------
  {
    const contendedSeat = fixture.seatIds[0]!;
    const attempts = Math.min(bounds.concurrency * 2, 32);
    const contenders = await allocateCustomers(attempts);
    const results = await runConcurrently(attempts, attempts, (index) =>
      acquireSeatHold(
        database,
        { userId: contenders[index]!.id },
        {
          sessionId: fixture.session.id,
          seatIds: [contendedSeat],
          idempotencyKey: `same-seat-${runId}-${index}-${randomUUID()}`,
        },
      ),
    );
    const successes = results.filter((entry) => entry.ok).length;
    const holders = await database.seatHoldItem.count({
      where: {
        inventory: { seatId: contendedSeat, sessionId: fixture.session.id },
        hold: { status: "ACTIVE" },
      },
    });
    outcomes.push(
      toOutcome("same_seat_contention", results, [
        {
          description: "exactly one concurrent acquirer wins the contended seat",
          passed: successes === 1 && holders === 1,
          detail: `successes=${successes} activeHolders=${holders} (losers rejected as designed)`,
        },
      ], CONTENTION_THRESHOLDS),
    );
  }

  // ---- Scenario: non-overlapping seat holds ------------------------------
  {
    const available = fixture.seatIds.slice(10, 10 + Math.min(bounds.concurrency, 16));
    const disjointHolders = await allocateCustomers(available.length);
    const results = await runConcurrently(available.length, available.length, (index) =>
      acquireSeatHold(
        database,
        { userId: disjointHolders[index]!.id },
        {
          sessionId: fixture.session.id,
          // One distinct seat per customer, so nothing should contend.
          seatIds: [available[index]!],
          idempotencyKey: `disjoint-${runId}-${index}-${randomUUID()}`,
        },
      ),
    );
    const held = await database.sessionSeatInventory.count({
      where: { sessionId: fixture.session.id, seatId: { in: available }, state: "HELD" },
    });
    outcomes.push(
      toOutcome("disjoint_seat_holds", results, [
        {
          description: "every disjoint hold succeeds without false contention",
          passed: results.every((entry) => entry.ok) && held === available.length,
          detail: `held=${held}/${available.length}`,
        },
      ]),
    );
  }

  // ---- Scenario: checkout double-submit ----------------------------------
  {
    const customer = (await allocateCustomers(1))[0]!;
    const seat = fixture.seatIds[40]!;
    const hold = await acquireSeatHold(
      database,
      { userId: customer.id },
      {
        sessionId: fixture.session.id,
        seatIds: [seat],
        idempotencyKey: `checkout-hold-${runId}-${randomUUID()}`,
      },
    );
    // The hold view exposes only its public token; the harness needs the row id
    // to assert on order and booking linkage.
    const holdRow = await database.seatHold.findUniqueOrThrow({
      where: { publicToken: hold.hold.publicToken },
      select: { id: true },
    });
    const provider = new LocalSignedPaymentProvider(paymentSecret, "test");
    const idempotencyKey = `checkout-${runId}-${randomUUID()}`;
    const attempts = Math.min(bounds.concurrency, 12);
    const results = await runConcurrently(attempts, attempts, () =>
      createCheckoutAndPayment(
        database,
        provider,
        { userId: customer.id },
        { holdToken: hold.hold.publicToken, idempotencyKey },
      ),
    );
    const orders = await database.checkoutOrder.count({ where: { sourceHoldId: holdRow.id } });
    outcomes.push(
      toOutcome("checkout_double_submit", results, [
        {
          description: "a repeated checkout submission creates exactly one order",
          passed: orders === 1,
          detail: `orders=${orders}`,
        },
      ]),
    );

    // ---- Scenario: duplicate webhook storm -------------------------------
    const attempt = await database.paymentAttempt.findFirstOrThrow({
      where: { order: { sourceHoldId: holdRow.id } },
    });
    const delivery = provider.createSignedWebhook({
      providerIntentId: attempt.providerIntentId!,
      outcome: "success",
      amountMinor: attempt.amountMinor,
      currency: attempt.currency,
    });
    const storm = Math.min(bounds.concurrency * 2, 24);
    const webhookResults = await runConcurrently(storm, storm, () =>
      processPaymentWebhook(database, provider, delivery, {
        ticketCredentialSecret: undefined,
      }),
    );
    const bookings = await database.booking.count({
      where: { order: { sourceHoldId: holdRow.id } },
    });
    const bookedSeats = await database.sessionSeatInventory.count({
      where: { sessionId: fixture.session.id, seatId: seat, state: "BOOKED" },
    });
    outcomes.push(
      toOutcome("duplicate_webhook_storm", webhookResults, [
        {
          description: "a duplicate webhook storm creates exactly one booking",
          passed: bookings === 1,
          detail: `bookings=${bookings} deliveries=${storm}`,
        },
        {
          description: "the paid seat becomes permanently BOOKED exactly once",
          passed: bookedSeats === 1,
          detail: `bookedSeats=${bookedSeats}`,
        },
      ]),
    );

    // ---- Scenario: concurrent duplicate scans ----------------------------
    const booking = await database.booking.findFirstOrThrow({
      where: { order: { sourceHoldId: holdRow.id } },
    });
    await processTicketIssuanceForBooking(database, {
      bookingId: booking.id,
      credentialSecret,
    });
    const ticket = await database.ticket.findFirstOrThrow({
      where: { bookingId: booking.id },
      include: { credentials: true },
    });
    const active = ticket.credentials.find((entry) => entry.status === "ACTIVE")!;
    const plaintext = deriveTicketCredential({
      ticketReference: ticket.publicReference,
      version: active.version,
      secret: credentialSecret,
    });
    const scanners = Math.min(bounds.concurrency * 2, 24);
    const scanResults = await runConcurrently(scanners, scanners, (index) =>
      validateTicketEntry(database, {
        scannerUserId: fixture.organizerScope.userId,
        credential: plaintext,
        sessionId: fixture.session.id,
        idempotencyKey: `scan-${runId}-${index}-${randomUUID()}`,
        credentialSecret,
        earlyMinutes: 1_440,
        lateMinutes: 1_440,
      }),
    );
    const accepted = await database.ticketRedemptionEvent.count({
      where: { ticketId: ticket.id, outcome: "ACCEPTED" },
    });
    // The outcome distribution is a closed enum, so it is safe to report and
    // makes a failing run diagnosable without re-running under a debugger.
    const returnedOutcomes = new Map<string, number>();
    for (const entry of scanResults) {
      const label = entry.ok
        ? String((entry.value as { outcome?: string } | null)?.outcome ?? "none")
        : "threw";
      returnedOutcomes.set(label, (returnedOutcomes.get(label) ?? 0) + 1);
    }
    const distribution = [...returnedOutcomes]
      .map(([label, count]) => `${label}=${count}`)
      .join(" ");
    outcomes.push(
      toOutcome("concurrent_duplicate_scans", scanResults, [
        {
          description: "concurrent scans of one credential accept exactly once",
          passed: accepted === 1,
          detail: `accepted=${accepted} attempts=${scanners} [${distribution}]`,
        },
      ]),
    );
  }

  // ---- Scenario: Redis outage does not corrupt PostgreSQL authority ------
  {
    // Point the transport at a closed port. Hold acquisition and its outbox
    // insert must still commit; only delivery is deferred.
    const previousRedisUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = "redis://127.0.0.1:6399";
    try {
      const seats = fixture.seatIds.slice(50, 50 + Math.min(bounds.concurrency, 8));
      const outageHolders = await allocateCustomers(seats.length);
      const results = await runConcurrently(seats.length, seats.length, (index) =>
        acquireSeatHold(
          database,
          { userId: outageHolders[index]!.id },
          {
            sessionId: fixture.session.id,
            seatIds: [seats[index]!],
            idempotencyKey: `redis-outage-${runId}-${index}-${randomUUID()}`,
          },
        ),
      );
      const held = await database.sessionSeatInventory.count({
        where: { sessionId: fixture.session.id, seatId: { in: seats }, state: "HELD" },
      });
      const pendingOutbox = await database.inventoryEventOutbox.count({
        where: { sessionId: fixture.session.id, processedAt: null },
      });
      outcomes.push(
        toOutcome("redis_outage_integrity", results, [
          {
            description: "holds still commit correctly while Redis is unreachable",
            passed: results.every((entry) => entry.ok) && held === seats.length,
            detail: `held=${held}/${seats.length}`,
          },
          {
            description: "invalidations remain durably queued for later delivery",
            passed: pendingOutbox > 0,
            detail: `pendingOutbox=${pendingOutbox}`,
          },
        ]),
      );
    } finally {
      if (previousRedisUrl) process.env.REDIS_URL = previousRedisUrl;
      else delete process.env.REDIS_URL;
    }
  }

  // ---- Report -------------------------------------------------------------
  const evaluations = outcomes.map(({ outcome, thresholds }) => ({
    outcome,
    evaluation: evaluateScenario(outcome, thresholds),
  }));
  const failed = evaluations.filter((entry) => !entry.evaluation.passed);

  const metric = await database.inventoryOperationsMetric.findUnique({
    where: { id: "inventory" },
  });

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          runId,
          bounds,
          scenarios: evaluations.map(({ outcome, evaluation }) => ({
            ...outcome,
            errorRate: evaluation.errorRate,
            passed: evaluation.passed,
          })),
          databaseRetries: metric?.transactionRetryCount.toString() ?? "0",
          holdConflicts: metric?.holdConflictCount.toString() ?? "0",
          passed: failed.length === 0,
        },
        null,
        2,
      ),
    );
  } else {
    for (const { outcome, evaluation } of evaluations) {
      const rate = (evaluation.errorRate * 100).toFixed(1);
      console.info(
        `${evaluation.passed ? "PASS" : "FAIL"} ${outcome.name}  ops=${outcome.operations} errors=${outcome.errors} (${rate}%) p50=${outcome.latency.p50Ms.toFixed(1)}ms p95=${outcome.latency.p95Ms.toFixed(1)}ms max=${outcome.latency.maxMs.toFixed(1)}ms`,
      );
      for (const invariant of outcome.invariants) {
        console.info(
          `       ${invariant.passed ? "ok  " : "FAIL"} ${invariant.description}${invariant.detail ? ` (${invariant.detail})` : ""}`,
        );
      }
    }
    console.info("");
    console.info(`Database transaction retries: ${metric?.transactionRetryCount.toString() ?? "0"}`);
    console.info(`Recorded hold conflicts:      ${metric?.holdConflictCount.toString() ?? "0"}`);
    console.info("");
    console.info(
      failed.length === 0
        ? `RESULT: PASS - ${outcomes.length} scenarios, every correctness invariant held.`
        : `RESULT: FAIL - ${failed.length} of ${outcomes.length} scenarios failed.`,
    );
  }

  await disconnectDatabase();
  await database.$disconnect();
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
