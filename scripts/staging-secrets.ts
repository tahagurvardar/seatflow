import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

import dotenv from "dotenv";

import {
  LOCAL_ONLY_VARIABLES,
  LOCAL_TOOLING_VARIABLES,
  NON_IMPORTABLE_VARIABLES,
  OPTIONAL_STAGING_VARIABLES,
  REQUIRED_STAGING_VARIABLES,
  validateStagingSecrets,
} from "../src/features/operations/staging-secrets";

/**
 * `npm run staging:secrets -- <check|list|import> [options]`
 *
 * The one rule this file exists to enforce
 * ----------------------------------------
 * **A secret value never leaves this process.** Not to stdout, not to stderr,
 * not into an error message, not into a `spawnSync` argument list (which is
 * visible in the OS process table), and not into a shell history. Every report
 * below names variables and states verdicts. If you find a code path here that
 * could print a value, that is a bug regardless of how convenient it is.
 *
 * Commands
 * --------
 *   check    Validate .env.staging.local and report by variable name only.
 *   list     Show which required and optional variables are present or missing.
 *   import   Push the validated variables into a Vercel environment.
 *
 * `import` is deliberately gated: it refuses to run unless validation passes,
 * requires an explicit typed confirmation, and passes each value to the Vercel
 * CLI over **stdin** rather than as an argument, so no value appears in the
 * process table.
 */

const STAGING_ENV_FILE = ".env.staging.local";

type Command = "check" | "list" | "import";
const COMMANDS: readonly Command[] = ["check", "list", "import"];

const args = process.argv.slice(2);
const command = (args.find((entry) => !entry.startsWith("--")) ?? "check") as Command;
const isolatedE2E = args.includes("--isolated-e2e");
const requireOptional = args.includes("--require-optional");
const targetArgument = args.find((entry) => entry.startsWith("--target="));
const target = targetArgument?.split("=")[1] ?? "preview";
const assumeYes = args.includes("--yes");

if (!COMMANDS.includes(command)) {
  console.error(`Usage: npm run staging:secrets -- <${COMMANDS.join("|")}> [--target=preview|production] [--require-optional] [--isolated-e2e] [--yes]`);
  process.exit(1);
}

if (!["preview", "production", "development"].includes(target)) {
  console.error("--target must be one of: preview, production, development.");
  process.exit(1);
}

const envPath = resolve(process.cwd(), STAGING_ENV_FILE);
if (!existsSync(envPath)) {
  console.error(`${STAGING_ENV_FILE} does not exist.`);
  console.error("");
  console.error("Create it from the tracked template and fill in your own values:");
  console.error("  cp .env.staging.example .env.staging.local");
  console.error("");
  console.error(`${STAGING_ENV_FILE} is gitignored and must never be committed.`);
  process.exit(1);
}

// `dotenv.parse` is the authority on what the file provides. Line-scanning it
// with a regex mis-reads quoted and multi-line assignments.
const parsed = dotenv.parse(readFileSync(envPath));
const report = validateStagingSecrets(parsed, { isolatedE2E, requireOptional });

function printReport() {
  console.log("SeatFlow staging secret validation");
  console.log(`Source: ${STAGING_ENV_FILE} (values are never printed)`);
  console.log("");
  console.log(`Variables present: ${report.presentVariables.length}`);
  console.log(`Errors: ${report.errorCount}   Warnings: ${report.warningCount}`);
  console.log("");

  if (report.findings.length === 0) {
    console.log("No findings. Every required variable is present and well-formed.");
    return;
  }
  for (const finding of report.findings) {
    const marker = finding.severity === "error" ? "ERROR" : "WARN ";
    console.log(`${marker} ${finding.variable}: ${finding.message}`);
  }
}

function printInventory() {
  const present = new Set(report.presentVariables);
  const show = (title: string, names: readonly string[]) => {
    console.log(title);
    for (const name of names) {
      console.log(`  ${present.has(name) ? "[set]    " : "[missing]"} ${name}`);
    }
    console.log("");
  };

  console.log("SeatFlow staging variable inventory (names only)");
  console.log("");
  show("Required:", REQUIRED_STAGING_VARIABLES);
  show("Optional:", OPTIONAL_STAGING_VARIABLES);

  const localLeaks = LOCAL_ONLY_VARIABLES.filter((name) => present.has(name));
  if (localLeaks.length > 0) {
    console.log("Local-only variables that must be removed before import:");
    for (const name of localLeaks) console.log(`  [remove] ${name}`);
    console.log("");
  }

  const localTooling = LOCAL_TOOLING_VARIABLES.filter((name) => present.has(name));
  if (localTooling.length > 0) {
    console.log("Local tooling variables (kept in the file, never imported to Vercel):");
    for (const name of localTooling) console.log(`  [local]  ${name}`);
    console.log("");
  }

  const unrecognized = report.presentVariables.filter(
    (name) =>
      !REQUIRED_STAGING_VARIABLES.includes(name as never) &&
      !OPTIONAL_STAGING_VARIABLES.includes(name as never) &&
      !NON_IMPORTABLE_VARIABLES.includes(name as never),
  );
  if (unrecognized.length > 0) {
    console.log("Additional variables present (will also be imported):");
    for (const name of unrecognized) console.log(`  [set]     ${name}`);
    console.log("");
  }
}

function vercelAvailable() {
  const probe = spawnSync("npx", ["--no-install", "vercel", "--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return probe.status === 0;
}

function vercelLinked() {
  return existsSync(resolve(process.cwd(), ".vercel", "project.json"));
}

/**
 * Push one variable.
 *
 * The value goes over stdin, never as an argv entry: arguments are visible to
 * any process that can read the process table, which would defeat the whole
 * point of this script.
 */
function pushVariable(name: string, value: string) {
  const result = spawnSync(
    "npx",
    // `--sensitive` stores the value so it cannot be read back through the
    // dashboard or CLI later; `--force` overwrites only this named variable.
    // The value goes over stdin (`input`), never as an argv entry.
    ["--no-install", "vercel", "env", "add", name, target, "--sensitive", "--force"],
    {
      input: value,
      encoding: "utf8",
      shell: process.platform === "win32",
    },
  );
  return result.status === 0;
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

async function runImport() {
  if (!report.passed) {
    console.error("Refusing to import: validation failed. Run `check` and fix every error first.");
    process.exit(1);
  }

  const importable = report.presentVariables.filter(
    (name) => !NON_IMPORTABLE_VARIABLES.includes(name as never),
  );
  if (importable.length === 0) {
    console.error("Nothing to import.");
    process.exit(1);
  }

  if (!vercelAvailable()) {
    console.error("The Vercel CLI is not available.");
    console.error("Install it with `npm i -g vercel`, or run `npx vercel` once to fetch it.");
    process.exit(1);
  }
  if (!vercelLinked()) {
    console.error("This directory is not linked to a Vercel project.");
    console.error("Run `npx vercel link` (and `npx vercel login` first if needed).");
    process.exit(1);
  }

  console.log(`About to write ${importable.length} variable(s) to the Vercel "${target}" environment:`);
  for (const name of importable) console.log(`  ${name}`);
  console.log("");
  console.log("Existing values with these names will be overwritten.");

  if (!(await confirm(`Type "yes" to proceed: `))) {
    console.log("Aborted. Nothing was changed.");
    return;
  }

  let succeeded = 0;
  const failed: string[] = [];
  for (const name of importable) {
    if (pushVariable(name, parsed[name]!)) {
      succeeded += 1;
      console.log(`  ok      ${name}`);
    } else {
      failed.push(name);
      console.log(`  failed  ${name}`);
    }
  }

  console.log("");
  console.log(`Imported ${succeeded}/${importable.length} variable(s) into "${target}".`);
  if (failed.length > 0) {
    console.log(`Failed: ${failed.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("");
  console.log("Nothing has been deployed. Redeploy explicitly once you have verified the list above.");
}

switch (command) {
  case "check":
    printReport();
    process.exitCode = report.passed ? 0 : 1;
    break;
  case "list":
    printInventory();
    break;
  case "import":
    await runImport();
    break;
}
