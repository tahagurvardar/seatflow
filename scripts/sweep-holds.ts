import "dotenv/config";

import { expirySweepCommandSchema } from "../src/features/holds/schema";
import { disconnectDatabase, getDatabase } from "../src/lib/database";
import { sweepExpiredHolds } from "../src/server/holds/expiry-service";

// Safe, idempotent operations command for the authoritative expiry sweeper. It
// only expires holds whose server-side expiry has already passed and returns
// their seats to AVAILABLE. Phase 4B will schedule this automatically.
function flagValue(flag: string) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const parsed = expirySweepCommandSchema.safeParse({
  batchSize: flagValue("--batch-size"),
  maxBatches: flagValue("--max-batches"),
});

if (!parsed.success) {
  console.error("Usage: npm run holds:sweep -- [--batch-size N] [--max-batches N]");
  console.error(parsed.error.issues.map((issue) => `  ${issue.message}`).join("\n"));
  process.exit(1);
}

const database = getDatabase();

try {
  const result = await sweepExpiredHolds(database, {
    batchSize: parsed.data.batchSize,
    maxBatches: parsed.data.maxBatches,
  });
  console.log(
    `Expiry sweep complete: expired ${result.holdsExpired} hold(s), ` +
      `released ${result.seatsReleased} seat(s) across ${result.batches} batch(es).`,
  );
} finally {
  await disconnectDatabase();
}
