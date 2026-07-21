import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

import dotenv from "dotenv";

import { classifyNeonConnection } from "../src/features/operations/staging-secrets";

/**
 * `npm run staging:migrate -- [status|deploy] [--yes]`
 *
 * Applying a migration to a hosted database is an external, persistent
 * mutation. The Neon staging database is new and empty, which makes it feel
 * harmless — and that is exactly the reasoning that eventually points a
 * migration at the wrong database. So this command treats it as dangerous
 * regardless of what it currently contains.
 *
 * What it will never do
 * ---------------------
 *   - reset, drop, truncate, or clean anything (`prisma migrate reset` is not
 *     reachable from here, by construction)
 *   - seed data
 *   - print a connection string, credential, or host
 *   - run against localhost, or against a database that is not the declared
 *     Neon staging target
 *
 * What it does
 * ------------
 *   status   `prisma migrate status` against DIRECT_URL, read-only.
 *   deploy   `prisma migrate deploy`, then re-checks status to prove the
 *            database ended up where the build expects.
 *
 * `deploy` requires an explicit typed confirmation unless a local authorization
 * marker already exists (`.staging-migration-authorized`, gitignored).
 */

const STAGING_ENV_FILE = ".env.staging.local";
const AUTHORIZATION_MARKER = ".staging-migration-authorized";

type Command = "status" | "deploy";

const args = process.argv.slice(2);
const command = (args.find((entry) => !entry.startsWith("--")) ?? "status") as Command;
const assumeYes = args.includes("--yes");

if (command !== "status" && command !== "deploy") {
  console.error("Usage: npm run staging:migrate -- <status|deploy> [--yes]");
  process.exit(1);
}

const envPath = resolve(process.cwd(), STAGING_ENV_FILE);
if (!existsSync(envPath)) {
  console.error(`${STAGING_ENV_FILE} does not exist. Create it from .env.staging.example first.`);
  process.exit(1);
}

const parsed = dotenv.parse(readFileSync(envPath));
const directUrl = parsed.DIRECT_URL;
const pooledUrl = parsed.DATABASE_URL;

/**
 * Every gate below must pass. Each one describes what it refused without ever
 * quoting the connection string it refused.
 */
function assertSafeTarget() {
  const failures: string[] = [];

  if (!directUrl) {
    failures.push("DIRECT_URL is not set; migrations must run against the direct endpoint.");
  }
  if (!pooledUrl) {
    failures.push("DATABASE_URL is not set.");
  }

  let host = "";
  let databaseName = "";
  if (directUrl) {
    try {
      const url = new URL(directUrl);
      host = url.hostname.toLowerCase();
      databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
    } catch {
      failures.push("DIRECT_URL is not a parseable URL.");
    }
  }

  if (host) {
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.endsWith(".local")
    ) {
      failures.push("DIRECT_URL points at a local database. This command targets hosted staging only.");
    }
    if (!host.includes("neon.tech")) {
      failures.push("DIRECT_URL does not look like a Neon endpoint.");
    }
  }

  // The development database is named `seatflow`. Refusing that exact name is a
  // cheap guard against a copied-in local URL that happened to clear the checks
  // above.
  if (databaseName === "seatflow" || databaseName === "seatflow_test") {
    failures.push(
      `DIRECT_URL targets a database named "${databaseName}", which is a local development database name.`,
    );
  }

  const directKind = classifyNeonConnection(directUrl);
  const pooledKind = classifyNeonConnection(pooledUrl);
  if (directKind === "pooled") {
    failures.push(
      "DIRECT_URL is the Neon pooled endpoint. Prisma migrations need the direct endpoint: the pooler cannot hold the advisory lock a migration takes.",
    );
  }
  if (pooledKind === "direct") {
    failures.push(
      "DATABASE_URL is the Neon direct endpoint. The application runtime must use the pooled endpoint.",
    );
  }
  if (directUrl && pooledUrl && directUrl === pooledUrl) {
    failures.push("DIRECT_URL and DATABASE_URL are identical; they must differ on Neon.");
  }

  if (failures.length > 0) {
    console.error("Refusing to touch the staging database:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  // Safe to show: a host label with the account-specific prefix removed.
  return { hostSuffix: host.split(".").slice(1).join("."), databaseName };
}

const targetSummary = assertSafeTarget();

function runPrisma(subcommand: string[]) {
  const result = spawnSync(
    "npx",
    ["--no-install", "prisma", ...subcommand],
    {
      encoding: "utf8",
      shell: process.platform === "win32",
      env: {
        ...process.env,
        // Prisma reads both; the direct endpoint is what a migration requires.
        DATABASE_URL: directUrl,
        DIRECT_URL: directUrl,
      },
    },
  );
  // Prisma echoes a redacted datasource line, but never the full URL. The
  // output is still filtered here so a future change cannot leak one.
  const redact = (value: string) =>
    value
      .replace(/postgres(ql)?:\/\/[^\s"']+/gi, "[connection string redacted]")
      .replace(/ep-[a-z0-9-]+\.[a-z0-9.-]+/gi, "[neon host redacted]");

  if (result.stdout) console.log(redact(result.stdout).trimEnd());
  if (result.stderr) console.error(redact(result.stderr).trimEnd());
  return result.status ?? 1;
}

async function confirm(question: string) {
  if (assumeYes) return true;
  if (existsSync(resolve(process.cwd(), AUTHORIZATION_MARKER))) {
    console.log(`Authorization marker ${AUTHORIZATION_MARKER} found; proceeding without a prompt.`);
    return true;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

console.log("SeatFlow staging migration");
console.log(`Target: Neon direct endpoint (*.${targetSummary.hostSuffix}), database "${targetSummary.databaseName}"`);
console.log("");

if (command === "status") {
  process.exitCode = runPrisma(["migrate", "status"]);
} else {
  console.log("`prisma migrate deploy` applies every pending migration to this database.");
  console.log("It does not reset, drop, truncate, clean, or seed anything.");
  console.log("");

  if (!(await confirm('Type "yes" to apply pending migrations to Neon staging: '))) {
    console.log("Aborted. Nothing was applied.");
    process.exit(0);
  }

  const deployStatus = runPrisma(["migrate", "deploy"]);
  if (deployStatus !== 0) {
    console.error("");
    console.error("Migration deployment failed. The database was left as Prisma found it.");
    process.exit(deployStatus);
  }

  console.log("");
  console.log("Verifying the database matches the expected migration set:");
  const verifyStatus = runPrisma(["migrate", "status"]);
  if (verifyStatus !== 0) {
    console.error("Post-deployment status check reported pending work. Investigate before deploying the application.");
    process.exit(verifyStatus);
  }

  console.log("");
  console.log("Migrations applied. No data was seeded; run the staging seed explicitly if you want demo content.");
}
