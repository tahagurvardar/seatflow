import "dotenv/config";

import { spawnSync } from "node:child_process";

import { readSafeTestDatabaseUrl } from "../src/env/schema";

const command = process.argv[2];
const testArguments = process.argv.slice(3);

if (!command || !["migrate", "reset", "test"].includes(command)) {
  console.error("Usage: tsx scripts/test-database.ts <migrate|reset|test>");
  process.exit(1);
}

const testDatabaseUrl = readSafeTestDatabaseUrl();
const testEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL: testDatabaseUrl,
  DIRECT_URL: testDatabaseUrl,
  NODE_ENV: "test",
};

function run(
  modulePath: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
) {
  const result = spawnSync(process.execPath, [modulePath, ...args], {
    stdio: "inherit",
    env: environment,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const prismaArguments = ["--config", "prisma.config.test.ts", "migrate"];

if (command === "migrate") {
  run("node_modules/prisma/build/index.js", [...prismaArguments, "deploy"]);
}

if (command === "reset" || command === "test") {
  run("node_modules/prisma/build/index.js", [
    ...prismaArguments,
    "reset",
    "--force",
  ]);
}

if (command === "test") {
  run("node_modules/vitest/vitest.mjs", [
    "run",
    "--config",
    "vitest.integration.config.mts",
    ...testArguments,
  ], testEnvironment);
}
