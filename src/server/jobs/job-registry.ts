import "server-only";

import {
  readInventoryEventEnvironment,
  readNotificationEnvironment,
  readTicketEnvironment,
  type ServerlessJobEnvironment,
} from "@/env/schema";
import type { PrismaClient } from "@/generated/prisma/client";
import type { WorkerType } from "@/generated/prisma/enums";
import type { ServerlessJobName } from "@/features/jobs/job-contract";
import { getHoldConfiguration } from "@/features/holds/config";
import { sweepExpiredHolds } from "@/server/holds/expiry-service";
import {
  dispatchInventoryEventBatch,
  getOutboxDispatcherConfiguration,
} from "@/server/inventory-events/dispatcher-service";
import { createInventoryEventTransport } from "@/server/inventory-events/transport-factory";
import {
  dispatchNotificationBatch,
  getNotificationDispatcherConfiguration,
} from "@/server/notifications/dispatcher-service";
import { createDeployedNotificationProvider } from "@/server/notifications/deployed-provider-registry";
import { getConfiguredPaymentProvider } from "@/server/payments/provider-registry";
import {
  detectTicketRevocationBacklog,
  escalateTicketRevocationBacklog,
  reconcileAmbiguousRefunds,
  reconcileUnprocessedWebhooks,
  retrySafeNotificationFailures,
} from "@/server/refunds/reconciliation-service";
import { processTicketIssuanceBatch } from "@/server/tickets/issuance-service";

/**
 * The serverless job registry.
 *
 * Every handler here is a thin trigger for an operation that already existed as
 * a BullMQ worker or a CLI dispatcher. None of them contains business logic,
 * and none of them is a second implementation of one. That is the whole design:
 * the local worker architecture stays authoritative and fully tested, and this
 * layer only changes *what invokes it*.
 *
 * Constraints every handler obeys:
 *  - bounded work per invocation, so a Vercel function limit is never the thing
 *    that decides where a batch stops
 *  - no database lock held across an external call
 *  - state read from PostgreSQL, never from the delivery payload
 *  - a heartbeat written per run, so a scheduler that silently stops shows up
 *    as a stale worker in readiness exactly as a crashed process would
 */

export interface JobContext {
  database: PrismaClient;
  environment: ServerlessJobEnvironment;
  /** Caller-supplied override, already bounded by the payload schema. */
  batchSize?: number;
  now?: Date;
}

export interface JobDefinition {
  /** Heartbeat identity, so serverless runs and worker runs are comparable. */
  workerType: WorkerType;
  /** Safe counters only. Never an identifier, amount, address, or status. */
  run(context: JobContext): Promise<Record<string, number>>;
}

/** Clamp an optional override against the handler's configured maximum. */
function boundedBatchSize(requested: number | undefined, configured: number) {
  if (!requested) return configured;
  return Math.min(requested, configured);
}

export const JOB_REGISTRY: Record<ServerlessJobName, JobDefinition> = {
  "inventory-outbox-dispatch": {
    workerType: "INVENTORY_OUTBOX_DISPATCHER",
    async run({ database, batchSize, now }) {
      const environment = readInventoryEventEnvironment();
      const configuration = getOutboxDispatcherConfiguration(environment);
      const transport = await createInventoryEventTransport(environment);
      const result = await dispatchInventoryEventBatch(
        database,
        transport,
        {
          ...configuration,
          batchSize: boundedBatchSize(batchSize, configuration.batchSize),
        },
        now,
      );
      return {
        claimed: result.claimed,
        processed: result.processed,
        failed: result.failed,
        deadLettered: result.deadLettered,
      };
    },
  },

  "hold-expiry-sweep": {
    workerType: "HOLD_EXPIRY_WORKER",
    async run({ database, batchSize, now }) {
      const configured = getHoldConfiguration().sweepBatchSize;
      const result = await sweepExpiredHolds(database, {
        now,
        batchSize: boundedBatchSize(batchSize, configured),
        // Bounded so one invocation cannot run until the function is killed.
        // Whatever is left is picked up by the next scheduled delivery, and
        // lazy expiry during hold acquisition covers the gap regardless.
        maxBatches: 10,
      });
      return {
        holdsExpired: result.holdsExpired,
        seatsReleased: result.seatsReleased,
        batches: result.batches,
      };
    },
  },

  "ticket-issuance-dispatch": {
    workerType: "TICKET_ISSUANCE_DISPATCHER",
    async run({ database, batchSize, now }) {
      const ticket = readTicketEnvironment();
      const result = await processTicketIssuanceBatch(database, {
        credentialSecret: ticket.TICKET_CREDENTIAL_SECRET,
        now,
        configuration: {
          batchSize: boundedBatchSize(batchSize, ticket.TICKET_ISSUANCE_BATCH_SIZE),
          maximumAttempts: ticket.TICKET_ISSUANCE_MAX_ATTEMPTS,
          backoffBaseMs: ticket.TICKET_ISSUANCE_BACKOFF_BASE_MS,
          backoffMaximumMs: ticket.TICKET_ISSUANCE_BACKOFF_MAX_MS,
        },
      });
      return {
        claimed: result.claimed,
        completed: result.completed,
        failed: result.failed,
        deadLettered: result.deadLettered,
      };
    },
  },

  "notification-dispatch": {
    workerType: "NOTIFICATION_DISPATCHER",
    async run({ database, batchSize, now }) {
      const notification = readNotificationEnvironment();
      const ticket = readTicketEnvironment();
      const applicationBaseUrl =
        process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL;
      if (!applicationBaseUrl) {
        // Without an origin the download grant URL would be malformed, which
        // is a configuration fault rather than a delivery failure.
        throw new Error("PERMANENT_NOTIFICATION_ORIGIN_MISSING");
      }
      const configuration = getNotificationDispatcherConfiguration(notification, {
        applicationBaseUrl,
        credentialSecret: ticket.TICKET_CREDENTIAL_SECRET,
        downloadGrantTtlMinutes: ticket.TICKET_DOWNLOAD_GRANT_TTL_MINUTES,
      });
      const result = await dispatchNotificationBatch(
        database,
        createDeployedNotificationProvider(notification),
        {
          ...configuration,
          batchSize: boundedBatchSize(batchSize, configuration.batchSize),
        },
        now,
      );
      return {
        claimed: result.claimed,
        processed: result.processed,
        failed: result.failed,
        deadLettered: result.deadLettered,
      };
    },
  },

  "refund-reconciliation": {
    workerType: "REFUND_RECONCILIATION",
    async run({ database, batchSize, now }) {
      // This job can only ever *adopt* a provider refund identifier. It cannot
      // settle a refund — only a verified provider webhook can — and it cannot
      // create, advance, or close a dispute. See reconciliation-service.
      const provider = getConfiguredPaymentProvider(now);
      const bounded = boundedBatchSize(batchSize, 50);
      const ambiguous = await reconcileAmbiguousRefunds(database, provider, {
        batchSize: bounded,
        now,
      });
      const retried = await retrySafeNotificationFailures(database, {
        limit: bounded,
        now,
      });
      return {
        inspected: ambiguous.inspected,
        adopted: ambiguous.adopted,
        stillUnknown: ambiguous.stillUnknown,
        failed: ambiguous.failed,
        notificationsRetried: retried,
      };
    },
  },

  "stale-webhook-reconciliation": {
    workerType: "PAYMENT_RECONCILIATION",
    async run({ database, batchSize, now }) {
      const result = await reconcileUnprocessedWebhooks(database, {
        batchSize: boundedBatchSize(batchSize, 50),
        now,
      });
      return {
        inspected: result.inspected,
        reprocessed: result.reprocessed,
        failed: result.failed,
      };
    },
  },

  "ticket-revocation-audit": {
    workerType: "FINANCIAL_OUTBOX_DISPATCHER",
    async run({ database, now }) {
      // Deliberately detect-and-escalate, never auto-revoke.
      //
      // `revokeTicket` requires an authorized actor and writes an audit event
      // naming them. A scheduled delivery has no actor, and inventing one would
      // put a fabricated identity on a permanent audit record for an action
      // that invalidates someone's admission. So this job raises the backlog
      // for human review through the same financial-outbox path divergences
      // use, and a person performs the revocation.
      const backlog = await detectTicketRevocationBacklog(database);
      if (backlog.length === 0) {
        return { bookingsWithActiveTickets: 0, raised: 0 };
      }
      const raised = await escalateTicketRevocationBacklog(database, backlog, now);
      return { bookingsWithActiveTickets: backlog.length, raised };
    },
  },
};

export function getJobDefinition(job: ServerlessJobName) {
  return JOB_REGISTRY[job];
}
