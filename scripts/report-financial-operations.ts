import "dotenv/config";

import { createDatabaseClient, disconnectDatabase } from "../src/lib/database";
import { collectFinancialProbes } from "../src/server/operations/financial-probes";
import {
  detectFinancialDivergence,
  detectTicketRevocationBacklog,
  reportDisputeBacklog,
  reportRefundBacklog,
} from "../src/server/refunds/reconciliation-service";

/**
 * `npm run financial:report [-- --json]`
 *
 * Strictly read-only. It writes nothing, calls no provider, and prints no
 * refund reference, order id, booking reference, customer identity, provider
 * identifier, secret, or raw metadata — only bounded aggregates an operator can
 * safely paste into a ticket.
 */

const asJson = process.argv.includes("--json");

async function main() {
  const database = createDatabaseClient();
  try {
    const now = new Date();
    const [refunds, disputes, divergence, revocationBacklog, probes] = await Promise.all([
      reportRefundBacklog(database, now),
      reportDisputeBacklog(database, now),
      detectFinancialDivergence(database, { batchSize: 200 }),
      detectTicketRevocationBacklog(database),
      collectFinancialProbes(database, { now }),
    ]);

    // Divergence findings carry ids, so only their shape is reported here.
    const divergenceByReason: Record<string, number> = {};
    for (const finding of divergence) {
      divergenceByReason[finding.reason] = (divergenceByReason[finding.reason] ?? 0) + 1;
    }

    const report = {
      collectedAt: now.toISOString(),
      refunds,
      disputes,
      divergenceByReason,
      ticketRevocationBacklog: revocationBacklog.reduce(
        (sum, entry) => sum + entry.activeTickets,
        0,
      ),
      bookingsAwaitingRevocation: revocationBacklog.length,
      probes: {
        refundReconciliationBacklog: probes.refundReconciliationBacklog,
        unresolvedChargebacks: probes.unresolvedChargebacks,
        financialDivergences: probes.financialDivergences,
        ticketRevocationBacklog: probes.ticketRevocationBacklog,
        failures: probes.failures,
      },
    };

    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log("SeatFlow financial operations report");
    console.log(`Collected: ${report.collectedAt}`);
    console.log("");
    console.log("Refunds");
    console.log(`  requested=${refunds.requested} submitting=${refunds.submitting} processing=${refunds.processing}`);
    console.log(`  requiresReview=${refunds.requiresReview} failed=${refunds.failed}`);
    console.log(`  oldestPendingAgeSeconds=${refunds.oldestPendingAgeSeconds ?? "none"}`);
    console.log("");
    console.log("Disputes");
    console.log(`  open=${disputes.open} needsResponse=${disputes.needsResponse} underReview=${disputes.underReview}`);
    console.log(`  lost=${disputes.lost} requiresReview=${disputes.requiresReview}`);
    console.log(`  evidenceDueWithin48Hours=${disputes.evidenceDueWithin48Hours}`);
    console.log("");
    console.log("Integrity");
    for (const [reason, count] of Object.entries(divergenceByReason)) {
      console.log(`  ${reason}=${count}`);
    }
    if (Object.keys(divergenceByReason).length === 0) console.log("  no divergence detected");
    console.log(`  ticketRevocationBacklog=${report.ticketRevocationBacklog}`);
    console.log("");
    if (probes.failures.length > 0) {
      // Never presented as a clean result: an unevaluated probe is unknown.
      console.log(`WARNING: probes could not be evaluated: ${probes.failures.join(", ")}`);
      console.log("Treat these gates as unknown, not as zero.");
    } else {
      console.log("All probes evaluated successfully.");
    }
  } finally {
    await disconnectDatabase();
  }
}

void main().catch((error) => {
  console.error("Financial report failed.", {
    name: error instanceof Error ? error.name : "UnknownError",
  });
  process.exit(1);
});
