import { afterAll } from "vitest";

import { readSafeTestDatabaseUrl } from "../../src/env/schema";
import { disconnectDatabase } from "../../src/lib/database";

const testDatabaseUrl = readSafeTestDatabaseUrl(process.env, {
  allowRuntimeAlias: true,
});
process.env.DATABASE_URL = testDatabaseUrl;
process.env.DIRECT_URL = testDatabaseUrl;

// Integration tests must not inherit the developer's ticket secret. Webhook
// fulfillment falls back to TICKET_CREDENTIAL_SECRET for best-effort immediate
// issuance, so an ambient value makes tests that deliberately defer issuance
// behave differently on a configured machine than on a clean one. Every suite
// that needs a secret passes it explicitly.
delete process.env.TICKET_CREDENTIAL_SECRET;

afterAll(async () => {
  await disconnectDatabase();
});
