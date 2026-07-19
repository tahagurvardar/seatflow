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

async function probeDatabase(): Promise<Partial<ProductionCheckProbes>> {
  if (!process.env.DATABASE_URL) return {};
  try {
    const [{ createDatabaseClient, disconnectDatabase }, { EXPECTED_LATEST_MIGRATION }] =
      await Promise.all([
        import("../src/lib/database"),
        import("../src/server/operations/readiness"),
      ]);
    const database = createDatabaseClient();
    try {
      // Read-only queries only. This command must never mutate a production
      // database it was pointed at.
      const [migrations, outboxDeadLetters, notificationDeadLetters, paidUnfulfilled] =
        await Promise.all([
          database.$queryRawUnsafe<Array<{ migration_name: string }>>(
            'SELECT "migration_name" FROM "_prisma_migrations" ORDER BY "migration_name" DESC LIMIT 1',
          ),
          database.inventoryEventOutbox.count({ where: { deadLetterAt: { not: null } } }),
          database.notificationOutbox.count({ where: { status: "DEAD_LETTER" } }),
          database.checkoutOrder.count({
            where: { status: { in: ["PAID_UNFULFILLED", "REQUIRES_REVIEW"] } },
          }),
        ]);

      return {
        migrationsBehind: (migrations[0]?.migration_name ?? "") < EXPECTED_LATEST_MIGRATION,
        outboxDeadLetters,
        notificationDeadLetters,
        paidUnfulfilled,
      };
    } finally {
      await disconnectDatabase();
    }
  } catch {
    // An unreachable database is reported through the readiness gate rather
    // than crashing the preflight.
    return { migrationsBehind: null };
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
