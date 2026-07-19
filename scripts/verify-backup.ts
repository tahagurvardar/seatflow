import "dotenv/config";

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  assertDisposableRestoreTarget,
  BackupSafetyError,
  compareRowCounts,
  CRITICAL_BACKUP_TABLES,
  describeDatabaseTarget,
} from "../src/features/operations/backup-safety";
import { EXPECTED_LATEST_MIGRATION } from "../src/server/operations/readiness";

/**
 * `npm run backup:verify -- --file <dump> --target <disposable url> --confirm`
 *
 * Restores a logical backup into a *separate disposable verification database*
 * and proves the restore is usable:
 *
 *  1. the archive lists cleanly (integrity);
 *  2. it restores without fatal errors;
 *  3. the restored schema is at or beyond the migration this build expects;
 *  4. critical table row counts match the source database.
 *
 * The target must be named as disposable and must not match DATABASE_URL or
 * DIRECT_URL. A developer database is never restored over by this command, and
 * ordinary test runs never invoke it.
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

function countRows(databaseUrl: string, tables: readonly string[]) {
  const query = tables
    .map((table) => `SELECT '${table}' AS t, COUNT(*)::text AS c FROM "${table}"`)
    .join(" UNION ALL ");
  const result = spawnSync(
    resolveBinary("psql"),
    ["--no-psqlrc", "--tuples-only", "--no-align", "--field-separator=|", "-c", query, databaseUrl],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  );
  if (result.status !== 0) return null;

  const counts: Record<string, number> = {};
  for (const line of (result.stdout ?? "").split("\n")) {
    const [table, count] = line.trim().split("|");
    if (table && count !== undefined) counts[table] = Number(count);
  }
  return counts;
}

function main() {
  const file = argument("file");
  const target = argument("target") ?? process.env.BACKUP_VERIFY_DATABASE_URL;
  const source = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  const confirmed = process.argv.includes("--confirm");

  if (!file || !existsSync(file)) {
    console.error("Specify an existing backup archive: --file <path>");
    process.exit(1);
  }
  if (!target) {
    console.error(
      "Specify a disposable verification database: --target <url>, or set BACKUP_VERIFY_DATABASE_URL.",
    );
    process.exit(1);
  }

  let targetName: string;
  try {
    targetName = assertDisposableRestoreTarget({
      targetUrl: target,
      protectedUrls: [process.env.DATABASE_URL, process.env.DIRECT_URL],
      confirmed,
    });
  } catch (error) {
    console.error(error instanceof BackupSafetyError ? error.message : "Unsafe restore target.");
    process.exit(1);
  }

  console.info(`Verifying backup: ${path.basename(file)}`);
  console.info(`Restore target:   ${describeDatabaseTarget(target)}`);
  console.info("");

  // 1. Integrity
  const listing = spawnSync(resolveBinary("pg_restore"), ["--list", file], {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
  if (listing.status !== 0) {
    console.error("FAIL integrity: the archive could not be listed.");
    process.exit(1);
  }
  console.info("PASS integrity: archive table of contents is readable.");

  // 2. Restore. --clean --if-exists makes the run repeatable against the same
  //    disposable database.
  const restore = spawnSync(
    resolveBinary("pg_restore"),
    ["--clean", "--if-exists", "--no-owner", "--no-privileges", "--dbname", target, file],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (restore.status !== 0) {
    console.error("FAIL restore: pg_restore reported a fatal error.");
    process.exit(1);
  }
  console.info(`PASS restore: archive restored into ${targetName}.`);

  // 3. Migration compatibility
  const migrations = spawnSync(
    resolveBinary("psql"),
    [
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "-c",
      'SELECT "migration_name" FROM "_prisma_migrations" ORDER BY "migration_name" DESC LIMIT 1',
      target,
    ],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  );
  const latest = (migrations.stdout ?? "").trim();
  if (migrations.status !== 0 || !latest) {
    console.error("FAIL migrations: the restored database has no migration history.");
    process.exit(1);
  }
  if (latest < EXPECTED_LATEST_MIGRATION) {
    console.error(
      `FAIL migrations: restored schema is behind this build (restored ${latest}, expected at least ${EXPECTED_LATEST_MIGRATION}).`,
    );
    process.exit(1);
  }
  console.info(`PASS migrations: restored schema at ${latest}.`);

  // 4. Critical row counts
  if (!source) {
    console.warn("SKIP row counts: no source DATABASE_URL to compare against.");
    console.info("");
    console.info("RESULT: PASS (integrity, restore, and migrations verified).");
    return;
  }

  const sourceCounts = countRows(source, CRITICAL_BACKUP_TABLES);
  const restoredCounts = countRows(target, CRITICAL_BACKUP_TABLES);
  if (!sourceCounts || !restoredCounts) {
    console.error("FAIL row counts: could not read counts from both databases.");
    process.exit(1);
  }

  const comparisons = compareRowCounts(sourceCounts, restoredCounts);
  const mismatches = comparisons.filter((entry) => !entry.matches);
  for (const entry of comparisons) {
    console.info(
      `  ${entry.matches ? "ok  " : "DIFF"} ${entry.table}: source=${entry.source} restored=${entry.restored}`,
    );
  }

  console.info("");
  if (mismatches.length > 0) {
    console.error(
      `RESULT: FAIL - ${mismatches.length} critical table(s) differ. The backup may predate recent writes, or the restore is incomplete.`,
    );
    process.exit(1);
  }
  console.info("RESULT: PASS - integrity, restore, migrations, and row counts all verified.");
}

main();
