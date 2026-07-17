import "dotenv/config";

import { defineConfig } from "prisma/config";

// Schema generation does not connect to PostgreSQL, so this build-only fallback
// keeps dependency installation deterministic. Every command that touches data
// and the runtime client validate the real URL before connecting.
const buildSafeDatabaseUrl =
  process.env.DIRECT_URL ??
  process.env.DATABASE_URL ??
  "postgresql://seatflow:seatflow@127.0.0.1:5432/seatflow";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: buildSafeDatabaseUrl,
    ...(process.env.SHADOW_DATABASE_URL
      ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL }
      : {}),
  },
});
