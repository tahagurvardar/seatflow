import { afterAll } from "vitest";

import { readInventoryEventEnvironment, readSafeTestDatabaseUrl } from "../../src/env/schema";
import { disconnectDatabase } from "../../src/lib/database";

const testDatabaseUrl = readSafeTestDatabaseUrl(process.env, { allowRuntimeAlias: true });
const redisEnvironment = readInventoryEventEnvironment();
if (!/(^|:)test(:|$)/i.test(redisEnvironment.REDIS_STREAM_PREFIX)) {
  throw new Error("Redis integration tests require a test-only REDIS_STREAM_PREFIX.");
}
process.env.DATABASE_URL = testDatabaseUrl;
process.env.DIRECT_URL = testDatabaseUrl;

afterAll(async () => {
  await disconnectDatabase();
});
