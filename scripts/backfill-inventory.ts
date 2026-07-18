import "dotenv/config";

import { disconnectDatabase, getDatabase } from "../src/lib/database";
import { backfillPublishedSessionInventory } from "../src/server/holds/inventory-service";

// Idempotent, additive backfill of authoritative sellable inventory for sessions
// published before Phase 4A. It never resets data, never invents pricing, and
// refuses (rather than repairs) partial existing inventory.
const database = getDatabase();

try {
  const summary = await backfillPublishedSessionInventory(database);

  console.log("SeatFlow Phase 4A inventory backfill");
  console.log(`  scanned published sessions : ${summary.scanned}`);
  console.log(`  materialized               : ${summary.materialized}`);
  console.log(`  already complete (skipped) : ${summary.skippedComplete}`);
  console.log(`  ineligible (skipped)       : ${summary.skippedIneligible}`);
  console.log(`  refused (inconsistent)     : ${summary.refusedInconsistent}`);

  for (const session of summary.sessions) {
    const suffix = session.detail ? ` — ${session.detail}` : "";
    console.log(
      `  · [${session.outcome}] ${session.eventTitle} (${session.sessionId}) ` +
        `capacity=${session.sellableCapacity} existing=${session.existingInventory} ` +
        `created=${session.createdInventory}${suffix}`,
    );
  }

  if (summary.refusedInconsistent > 0) {
    console.error(
      "Some sessions have inconsistent partial inventory and were refused. Review them manually.",
    );
    process.exitCode = 2;
  }
} finally {
  await disconnectDatabase();
}
