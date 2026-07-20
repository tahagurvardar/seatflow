import "dotenv/config";

import {
  summarizeFindings,
  validateProductionConfiguration,
  type ProductionCheckProbes,
} from "../src/features/operations/production-check";

/**
 * `npm run production:check`
 *
 * Read-only production preflight. It executes no writes, no migrations, and no
 * provider calls, and it never prints a secret value — only the name of the
 * setting at fault. Exit code 1 means the configuration is not safe to deploy.
 *
 * Run with `--skip-probes` to validate configuration alone, without touching
 * PostgreSQL or Redis.
 */

const args = new Set(process.argv.slice(2));
const skipProbes = args.has("--skip-probes");
const asJson = args.has("--json");

async function probeRedis(): Promise<boolean | null> {
  if (!process.env.REDIS_URL) return null;
  const { default: Redis } = await import("ioredis");
  const client = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    retryStrategy: () => null,
  });
  try {
    await client.connect();
    return (await client.ping()) === "PONG";
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

/** Every database-backed gate this preflight can evaluate. */
const DATABASE_PROBE_NAMES = [
  "migrations",
  "outbox_dead_letters",
  "notification_dead_letters",
  "paid_unfulfilled",
  "refund_backlog",
  "unresolved_chargebacks",
  "financial_divergence",
  "ticket_revocation_backlog",
] as const;

async function probeDatabase(): Promise<Partial<ProductionCheckProbes>> {
  if (!process.env.DATABASE_URL) {
    // Nothing was attempted, so nothing is claimed. The missing DATABASE_URL is
    // itself reported by the configuration rules.
    return {};
  }
  try {
    const [
      { createDatabaseClient, disconnectDatabase },
      { EXPECTED_LATEST_MIGRATION },
      { collectFinancialProbes },
      { readOperationsEnvironment },
    ] = await Promise.all([
      import("../src/lib/database"),
      import("../src/server/operations/readiness"),
      import("../src/server/operations/financial-probes"),
      import("../src/env/schema"),
    ]);

    let thresholds;
    try {
      const operations = readOperationsEnvironment();
      thresholds = {
        refundStaleAfterSeconds: operations.REFUND_BACKLOG_STALE_SECONDS,
        divergenceScanLimit: operations.FINANCIAL_DIVERGENCE_SCAN_LIMIT,
      };
    } catch {
      // Invalid operations configuration is reported by its own rules; the
      // probes fall back to their documented defaults rather than guessing.
      thresholds = undefined;
    }

    const database = createDatabaseClient();
    try {
      // Read-only queries only. This command must never mutate a production
      // database it was pointed at.
      const [migrations, outboxDeadLetters, notificationDeadLetters, paidUnfulfilled, financial] =
        await Promise.all([
          database.$queryRawUnsafe<Array<{ migration_name: string }>>(
            'SELECT "migration_name" FROM "_prisma_migrations" ORDER BY "migration_name" DESC LIMIT 1',
          ),
          database.inventoryEventOutbox.count({ where: { deadLetterAt: { not: null } } }),
          database.notificationOutbox.count({ where: { status: "DEAD_LETTER" } }),
          database.checkoutOrder.count({
            where: { status: { in: ["PAID_UNFULFILLED", "REQUIRES_REVIEW"] } },
          }),
          collectFinancialProbes(database, { thresholds }),
        ]);

      return {
        migrationsBehind: (migrations[0]?.migration_name ?? "") < EXPECTED_LATEST_MIGRATION,
        outboxDeadLetters,
        notificationDeadLetters,
        paidUnfulfilled,
        refundReconciliationBacklog: financial.refundReconciliationBacklog,
        unresolvedChargebacks: financial.unresolvedChargebacks,
        financialDivergences: financial.financialDivergences,
        ticketRevocationBacklog: financial.ticketRevocationBacklog,
        probeFailures: financial.failures,
      };
    } finally {
      await disconnectDatabase();
    }
  } catch {
    // The database could not be reached at all. Previously this returned only
    // `migrationsBehind: null`, which left every other gate undefined and
    // therefore silently satisfied. Every probe is now reported as failed, so
    // an unreachable database blocks rather than passes.
    return { migrationsBehind: null, probeFailures: [...DATABASE_PROBE_NAMES] };
  }
}

async function main() {
  const probes: ProductionCheckProbes = skipProbes
    ? {}
    : { redisAvailable: await probeRedis(), ...(await probeDatabase()) };

  const findings = validateProductionConfiguration({ env: process.env, probes });
  const summary = summarizeFindings(findings);

  if (asJson) {
    console.log(JSON.stringify({ ...summary, findings }, null, 2));
  } else {
    console.log("SeatFlow production configuration check");
    console.log(`Mode: ${skipProbes ? "configuration only" : "configuration and live probes"}`);
    console.log("");

    if (findings.length === 0) {
      console.log("No findings. Configuration looks production-ready.");
    }
    for (const finding of findings) {
      const label = finding.severity === "error" ? "ERROR  " : "WARNING";
      console.log(`${label} [${finding.id}] ${finding.message}`);
    }

    console.log("");
    console.log(`Errors: ${summary.errorCount}  Warnings: ${summary.warningCount}`);
    console.log(
      summary.passed
        ? "RESULT: PASS - no blocking findings."
        : "RESULT: FAIL - resolve every error before enabling production traffic.",
    );
  }

  process.exit(summary.passed ? 0 : 1);
}

void main();
