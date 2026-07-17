import "dotenv/config";

import { defineConfig } from "prisma/config";

import { readSafeTestDatabaseUrl } from "./src/env/schema";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: readSafeTestDatabaseUrl(),
  },
});
