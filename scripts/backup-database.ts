import "dotenv/config";

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  assertSafeBackupPath,
  BackupSafetyError,
  describeDatabaseTarget,
} from "../src/features/operations/backup-safety";

/**
 * `npm run backup:create -- --out <directory>`
 *
 * Creates a PostgreSQL logical backup in custom format and verifies that the
 * resulting archive has a readable table of contents.
 *
 * This command is read-only with respect to the database: `pg_dump` never
 * writes to its source. It refuses to write inside the repository, because a
 * backup contains complete customer, payment, and ticket data.
 *
 * `pg_dump` must be on PATH, or its directory supplied through `PG_BIN_DIR`.
 * A portable local install might set, for example:
 *   PG_BIN_DIR=/path/to/pgsql/bin
 */

function argument(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((entry) => entry.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

function resolveBinary(name: string) {
  const directory = process.env.PG_BIN_DIR;
  if (!directory) return name;
  const candidate = path.join(directory, process.platform === "win32" ? `${name}.exe` : name);
  return existsSync(candidate) ? candidate : name;
}

function main() {
  const databaseUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL (or DIRECT_URL) must be set.");
    process.exit(1);
  }

  const outputDirectory = path.resolve(argument("out") ?? process.env.BACKUP_DIR ?? "");
  if (!argument("out") && !process.env.BACKUP_DIR) {
    console.error(
      "Specify a destination outside the repository: --out <directory>, or set BACKUP_DIR.",
    );
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputFile = path.join(outputDirectory, `seatflow-${stamp}.dump`);

  try {
    assertSafeBackupPath(outputFile, process.cwd());
  } catch (error) {
    console.error(error instanceof BackupSafetyError ? error.message : "Unsafe backup path.");
    process.exit(1);
  }

  mkdirSync(outputDirectory, { recursive: true });
  console.info(`Backing up ${describeDatabaseTarget(databaseUrl)}`);
  console.info(`Destination: ${outputFile}`);

  const dump = spawnSync(
    resolveBinary("pg_dump"),
    ["--format=custom", "--no-owner", "--no-privileges", "--file", outputFile, databaseUrl],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (dump.status !== 0) {
    console.error("pg_dump failed. Is PG_BIN_DIR set, and is the server reachable?");
    process.exit(dump.status ?? 1);
  }

  // Integrity check: a truncated or corrupt archive cannot be listed.
  const listing = spawnSync(resolveBinary("pg_restore"), ["--list", outputFile], {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
  if (listing.status !== 0) {
    console.error("Backup integrity check FAILED: the archive could not be listed.");
    process.exit(1);
  }

  const entries = (listing.stdout ?? "").split("\n").filter((line) => line && !line.startsWith(";"));
  const sizeBytes = statSync(outputFile).size;

  console.info("");
  console.info(`Backup complete. ${sizeBytes} bytes, ${entries.length} archive entries.`);
  console.info("Integrity check: PASS (table of contents is readable).");
  console.info("");
  console.info("Store this file under the same protection as production secrets.");
  console.info("Verify it with: npm run backup:verify -- --file <path> --target <disposable url>");
}

main();
