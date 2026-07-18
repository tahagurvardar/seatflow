import "dotenv/config";

import { spawnSync } from "node:child_process";

import { readInventoryEventEnvironment, readSafeTestDatabaseUrl } from "../src/env/schema";

readInventoryEventEnvironment();
const testDatabaseUrl = readSafeTestDatabaseUrl();
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL: testDatabaseUrl,
  DIRECT_URL: testDatabaseUrl,
  NODE_ENV: "test",
  REDIS_STREAM_PREFIX: "seatflow:test:phase4b",
  REDIS_WORKER_ID: "redis-integration",
  HOLD_EXPIRY_QUEUE_NAME: "seatflow-test-hold-expiry",
};
const migrationEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "test",
  REDIS_STREAM_PREFIX: environment.REDIS_STREAM_PREFIX,
  REDIS_WORKER_ID: environment.REDIS_WORKER_ID,
  HOLD_EXPIRY_QUEUE_NAME: environment.HOLD_EXPIRY_QUEUE_NAME,
};

function run(modulePath: string, arguments_: string[], env = environment) {
  const result = spawnSync(process.execPath, [modulePath, ...arguments_], {
    stdio: "inherit",
    env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("node_modules/prisma/build/index.js", [
  "--config",
  "prisma.config.test.ts",
  "migrate",
  "reset",
  "--force",
], migrationEnvironment);
run("node_modules/vitest/vitest.mjs", [
  "run",
  "--config",
  "vitest.redis.config.mts",
]);
