import "dotenv/config";

import { randomUUID } from "node:crypto";

import { createDatabaseClient, disconnectDatabase } from "../src/lib/database";
import { getConfiguredPaymentProvider } from "../src/server/payments/provider-registry";
import {
  reconcileAmbiguousRefunds,
  reconcileUnprocessedWebhooks,
  retrySafeNotificationFailures,
} from "../src/server/refunds/reconciliation-service";
import { submitPendingRefunds } from "../src/server/refunds/submission-service";

/**
 * `npm run refunds:reconcile -- <action> [--dry-run] [--batch=N]`
 *
 * Safety model
 * ------------
 * Every action here is idempotent and bounded. None of them can:
 *
 *   - mark a refund succeeded (only a verified provider webhook can)
 *   - create, advance, or close a dispute
 *   - issue a manual financial adjustment of any kind
 *   - reopen inventory
 *   - edit or delete ledger, refund, dispute, booking, or ticket history
 *
 * `submit` and `ambiguous` call the provider. Both use the deterministic
 * idempotency key committed before the first attempt, so a retry returns the
 * refund the provider already created rather than making a second one, and
 * neither holds a database row lock across the HTTP call.
 *
 * A correlation id is printed so one run can be traced through structured logs
 * without exposing any refund, order, customer, or provider identifier.
 */

type Action = "submit" | "ambiguous" | "webhooks" | "notifications" | "all";

const ACTIONS: readonly Action[] = ["submit", "ambiguous", "webhooks", "notifications", "all"];

const args = process.argv.slice(2);
const action = (args.find((entry) => !entry.startsWith("--")) ?? "all") as Action;
const dryRun = args.includes("--dry-run");
const asJson = args.includes("--json");
const batchArgument = args.find((entry) => entry.startsWith("--batch="));
const batchSize = Math.min(Math.max(Number(batchArgument?.split("=")[1] ?? 50) || 50, 1), 500);

if (!ACTIONS.includes(action)) {
  console.error(`Usage: tsx scripts/reconcile-refunds.ts <${ACTIONS.join("|")}> [--dry-run] [--batch=N] [--json]`);
  process.exit(1);
}

const correlationId = `refrec_${randomUUID().replaceAll("-", "").slice(0, 20)}`;

async function main() {
  const database = createDatabaseClient();
  const summary: Record<string, unknown> = { correlationId, action, dryRun, batchSize };

  try {
    if (dryRun) {
      // Report what each action would consider, without calling the provider
      // or writing anything.
      const [pendingRefunds, ambiguousRefunds, unprocessedWebhooks, delayedNotifications] =
        await Promise.all([
          database.refund.count({ where: { status: "REQUESTED" } }),
          database.refund.count({
            where: { status: { in: ["SUBMITTING", "PROCESSING"] }, providerRefundId: null },
          }),
          database.paymentWebhookEvent.count({
            where: {
              signatureStatus: "VERIFIED",
              processingStatus: { in: ["RECEIVED", "FAILED"] },
            },
          }),
          database.notificationOutbox.count({
            where: { status: "PENDING", availableAt: { gt: new Date() } },
          }),
        ]);
      summary.wouldSubmit = Math.min(pendingRefunds, batchSize);
      summary.wouldReconcileAmbiguous = Math.min(ambiguousRefunds, batchSize);
      summary.wouldReplayWebhooks = Math.min(unprocessedWebhooks, batchSize);
      summary.wouldRetryNotifications = delayedNotifications;
    } else {
      const needsProvider = action === "submit" || action === "ambiguous" || action === "all";
      const provider = needsProvider ? getConfiguredPaymentProvider() : null;

      if (provider && (action === "submit" || action === "all")) {
        summary.submitted = await submitPendingRefunds(database, provider, { batchSize });
      }
      if (provider && (action === "ambiguous" || action === "all")) {
        summary.ambiguous = await reconcileAmbiguousRefunds(database, provider, { batchSize });
      }
      if (action === "webhooks" || action === "all") {
        summary.webhooks = await reconcileUnprocessedWebhooks(database, { batchSize });
      }
      if (action === "notifications" || action === "all") {
        summary.notificationsRetried = await retrySafeNotificationFailures(database, {
          limit: batchSize,
        });
      }
    }
  } finally {
    await disconnectDatabase();
  }

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log("SeatFlow refund reconciliation");
    console.log(`Correlation: ${correlationId}`);
    console.log(`Action: ${action}${dryRun ? " (dry run: nothing was written or called)" : ""}`);
    console.log("");
    for (const [key, value] of Object.entries(summary)) {
      if (["correlationId", "action", "dryRun"].includes(key)) continue;
      console.log(`${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`);
    }
    console.log("");
    console.log(
      "Note: no command here can settle a refund. Only a verified provider webhook can.",
    );
  }
}

void main().catch((error) => {
  // Reduced to a bounded message: a driver or provider error can quote
  // connection details and request parameters.
  console.error("Refund reconciliation failed.", {
    correlationId,
    name: error instanceof Error ? error.name : "UnknownError",
  });
  process.exit(1);
});
