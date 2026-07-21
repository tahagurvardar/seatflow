import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import dotenv from "dotenv";
import { Client } from "@upstash/qstash";

import { SERVERLESS_JOB_NAMES, type ServerlessJobName } from "../src/features/jobs/job-contract";

/**
 * `npm run staging:schedule -- <list|apply|remove> [--yes]`
 *
 * Registers the QStash schedules that replace the resident workers.
 *
 * This publishes to an external service, so like every other outward-facing
 * command here it requires explicit confirmation and is never run by a build,
 * a test, or a deployment.
 *
 * Cadence notes
 * -------------
 * Free-tier QStash has a daily message budget, so these intervals are chosen to
 * stay well inside it while keeping the guarantees that actually matter:
 *
 *   - hold expiry runs often, because a held seat is unsellable inventory and
 *     the lazy expiry path only frees seats for sessions someone is actively
 *     browsing
 *   - the outbox dispatcher runs often, because it is what makes an inventory
 *     change visible to other browsers
 *   - reconciliation runs rarely, because it inspects money and nothing there
 *     is time-critical: a refund adopted five minutes later is still correct
 *
 * None of these is a correctness deadline. Every operation is idempotent and
 * PostgreSQL stays authoritative between runs; a missed tick delays work, it
 * does not lose it.
 */

const STAGING_ENV_FILE = ".env.staging.local";

/** Cron expressions, UTC. Deliberately conservative for a free tier. */
const SCHEDULES: Record<ServerlessJobName, { cron: string; note: string }> = {
  "inventory-outbox-dispatch": {
    cron: "*/2 * * * *",
    note: "every 2 minutes — makes inventory changes visible to other clients",
  },
  "hold-expiry-sweep": {
    cron: "*/2 * * * *",
    note: "every 2 minutes — returns expired held seats to sale",
  },
  "ticket-issuance-dispatch": {
    cron: "*/5 * * * *",
    note: "every 5 minutes — issues tickets for confirmed bookings",
  },
  "notification-dispatch": {
    cron: "*/5 * * * *",
    note: "every 5 minutes — delivers queued email",
  },
  "refund-reconciliation": {
    cron: "0 * * * *",
    note: "hourly — adopts provider refund identifiers; cannot settle a refund",
  },
  "stale-webhook-reconciliation": {
    cron: "15 * * * *",
    note: "hourly — replays verified webhooks that never reached a terminal state",
  },
  "ticket-revocation-audit": {
    cron: "30 * * * *",
    note: "hourly — raises refunded bookings that still hold an active ticket",
  },
};

type Command = "list" | "apply" | "remove";

const args = process.argv.slice(2);
const command = (args.find((entry) => !entry.startsWith("--")) ?? "list") as Command;
const assumeYes = args.includes("--yes");

if (!["list", "apply", "remove"].includes(command)) {
  console.error("Usage: npm run staging:schedule -- <list|apply|remove> [--yes]");
  process.exit(1);
}

function jobUrl(origin: string, job: ServerlessJobName) {
  return new URL(`/api/internal/jobs/${job}`, origin).toString();
}

if (command === "list") {
  console.log("SeatFlow staging job schedule");
  console.log("");
  for (const job of SERVERLESS_JOB_NAMES) {
    const schedule = SCHEDULES[job];
    console.log(`  ${job}`);
    console.log(`    cron: ${schedule.cron}`);
    console.log(`    ${schedule.note}`);
    console.log("");
  }
  console.log("Run `apply` to register these with QStash.");
  process.exit(0);
}

const envPath = resolve(process.cwd(), STAGING_ENV_FILE);
if (!existsSync(envPath)) {
  console.error(`${STAGING_ENV_FILE} does not exist. Create it from .env.staging.example first.`);
  process.exit(1);
}
const parsed = dotenv.parse(readFileSync(envPath));

if (!parsed.QSTASH_TOKEN) {
  console.error("QSTASH_TOKEN is not set in .env.staging.local. It is required to publish schedules.");
  process.exit(1);
}

const origin = parsed.SEATFLOW_INTERNAL_JOB_ORIGIN ?? parsed.NEXT_PUBLIC_APP_URL;
if (!origin) {
  console.error("Set SEATFLOW_INTERNAL_JOB_ORIGIN or NEXT_PUBLIC_APP_URL so QStash knows where to deliver.");
  process.exit(1);
}
let originUrl: URL;
try {
  originUrl = new URL(origin);
} catch {
  console.error("The job origin is not a valid URL.");
  process.exit(1);
}
if (originUrl.protocol !== "https:") {
  console.error("The job origin must use https://. QStash will not deliver a signed job over plaintext.");
  process.exit(1);
}

async function confirm(question: string) {
  if (assumeYes) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

const client = new Client({ token: parsed.QSTASH_TOKEN });

console.log("SeatFlow staging job schedule");
console.log(`Delivery origin: ${originUrl.origin}`);
console.log("");

if (command === "remove") {
  if (!(await confirm('Type "yes" to remove every SeatFlow schedule from QStash: '))) {
    console.log("Aborted. Nothing was changed.");
    process.exit(0);
  }
  const existing = await client.schedules.list();
  let removed = 0;
  for (const schedule of existing) {
    if (!SERVERLESS_JOB_NAMES.some((job) => schedule.destination.includes(`/api/internal/jobs/${job}`))) {
      continue;
    }
    await client.schedules.delete(schedule.scheduleId);
    removed += 1;
  }
  console.log(`Removed ${removed} schedule(s). Scheduled work has stopped.`);
  console.log("Heartbeats will go stale, and readiness will report it.");
  process.exit(0);
}

console.log(`About to register ${SERVERLESS_JOB_NAMES.length} schedule(s):`);
for (const job of SERVERLESS_JOB_NAMES) {
  console.log(`  ${SCHEDULES[job].cron.padEnd(14)} ${job}`);
}
console.log("");
console.log("Each delivery is signed by QStash and verified before any work runs.");
console.log("");

if (!(await confirm('Type "yes" to publish these schedules: '))) {
  console.log("Aborted. Nothing was changed.");
  process.exit(0);
}

let created = 0;
const failed: string[] = [];
for (const job of SERVERLESS_JOB_NAMES) {
  try {
    await client.schedules.create({
      destination: jobUrl(originUrl.origin, job),
      cron: SCHEDULES[job].cron,
      // The body names only the operation. Every fact the handler acts on is
      // read from PostgreSQL, so a forged body cannot assert anything.
      body: JSON.stringify({ job }),
      headers: new Headers({ "Content-Type": "application/json" }),
      // Bounded retries; the operations are idempotent, so a retry is safe.
      retries: 3,
    });
    created += 1;
    console.log(`  ok      ${job}`);
  } catch {
    // The QStash error can quote the destination and the token context.
    failed.push(job);
    console.log(`  failed  ${job}`);
  }
}

console.log("");
console.log(`Registered ${created}/${SERVERLESS_JOB_NAMES.length} schedule(s).`);
if (failed.length > 0) {
  console.log(`Failed: ${failed.join(", ")}`);
  process.exitCode = 1;
}
