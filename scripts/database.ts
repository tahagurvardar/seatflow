import "dotenv/config";

import { spawnSync } from "node:child_process";

import { readMigrationDatabaseUrl } from "../src/env/schema";

const commands = {
  migrate: ["migrate", "dev"],
  deploy: ["migrate", "deploy"],
  reset: ["migrate", "reset"],
  studio: ["studio"],
} as const;

const command = process.argv[2] as keyof typeof commands | undefined;

if (!command || !(command in commands)) {
  console.error("Usage: tsx scripts/database.ts <migrate|deploy|reset|studio>");
  process.exit(1);
}

readMigrationDatabaseUrl();

const result = spawnSync(
  process.execPath,
  ["node_modules/prisma/build/index.js", ...commands[command]],
  { stdio: "inherit", env: process.env },
);

process.exit(result.status ?? 1);
