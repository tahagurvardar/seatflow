import { afterAll } from "vitest";

import { readSafeTestDatabaseUrl } from "../../src/env/schema";
import { disconnectDatabase } from "../../src/lib/database";

const testDatabaseUrl = readSafeTestDatabaseUrl(process.env, {
  allowRuntimeAlias: true,
});
process.env.DATABASE_URL = testDatabaseUrl;
process.env.DIRECT_URL = testDatabaseUrl;

afterAll(async () => {
  await disconnectDatabase();
});
