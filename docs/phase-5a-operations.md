# Phase 5A checkout, payment, and booking operations

## Authority and deployment gate

PostgreSQL is authoritative for checkout, payment observations, fulfillment, booked inventory, and booking history. Only a provider webhook whose signature is verified over the exact raw request body may authorize payment success. Provider redirects, success URLs, reconciliation responses, browser input, Redis, and Socket.IO cannot mark an order paid or create a booking.

Phase 5A ships a deterministic `LOCAL_SIGNED` provider for development, automated tests, and browser verification. It never accepts payment-card data. Both environment validation and the provider constructor reject it in production. `PAYMENT_PROVIDER=EXTERNAL` is an intentional deployment gate: this repository does not contain a production external adapter because no reviewed provider credentials were available. Do not deploy payment checkout until that adapter, its contract tests, webhook configuration, and operational review are complete.

Phase 5B is excluded: no ticket/QR issuance, scanning, refund execution, chargebacks/disputes, coupons, email delivery, tax/fee engine, or sales analytics exists.

## Required configuration

Development/test:

```dotenv
PAYMENT_PROVIDER=LOCAL_SIGNED
LOCAL_PAYMENT_WEBHOOK_SECRET=<dedicated random value of at least 32 characters>
# PAYMENT_WEBHOOK_MAX_BYTES=65536
```

Generate the secret from a trusted terminal and store it outside source control. It must be distinct from `BETTER_AUTH_SECRET`, database credentials, and Redis credentials. Production must use `PAYMENT_PROVIDER=EXTERNAL` plus the adapter's secret-manager-backed credentials and webhook secret. Never print or place provider secrets in logs, URLs, browser code, test snapshots, or health responses.

The webhook ingress is `POST /api/payments/webhooks/[provider]`. The local signed provider uses the `x-seatflow-signature` header with a strict `t=<timestamp>,v1=<hex digest>` format and signs `timestamp + "." + exactRawBody`. A production adapter must preserve the provider's exact raw-body verification requirements and normalize only bounded event ID, intent ID, status, amount, currency, and event time after verification.

## Migration and process rollout

1. Back up and verify the target PostgreSQL database.
2. Configure payment secrets in the deployment secret manager; do not rely on checked-in environment files.
3. Run `npm run db:migrate:deploy` against the direct migration connection.
4. Run `npx prisma migrate status` and verify the Phase 5A migration is applied.
5. Deploy the web process and existing outbox dispatcher. Continue running the Redis/realtime and hold-expiry processes from Phase 4B.
6. Configure the provider webhook to the public HTTPS route and verify signature failures do not create stored events or bookings.
7. Run the provider contract, PostgreSQL, real-Redis, production-build, and browser verification gates before enabling checkout traffic.
8. Check the payment health/report output and existing inventory outbox health after rollout.

The migration is additive: new enums/tables/indexes/checks/triggers and a `BOOKED` inventory state are introduced without resetting development or production data. Never run `db:reset` against a development or production URL. The guarded test runner may rebuild only the distinct `seatflow_test` database.

## Normal commands

```bash
# Initialize/retrieve at most 100 pending provider intents.
npm run payments:reconcile -- --limit=100

# Report non-sensitive health plus paid-unfulfilled and stale queues.
npm run payments:report

# Expire bounded batches of unpaid checkout orders.
npm run checkouts:expire -- --batch-size=100 --max-batches=10

# Re-run one already stored and VERIFIED webhook by internal database ID.
npm run payments:webhook:reprocess -- --event-id=<internal-webhook-id>
```

Reconciliation deliberately cannot grant success. If retrieval reports success, the command increments `awaitingVerifiedWebhook`; fulfillment still waits for the verified webhook. Run these commands from a trusted environment with direct database/provider access. Outputs are bounded counts/references and must remain free of secrets, raw payloads, signatures, customer data, and stack traces.

## Paid-but-unfulfilled handling

`PAID_UNFULFILLED` or `REQUIRES_REVIEW` means payment success was verified but SeatFlow could not prove that fulfillment was safe—for example, the hold was released/expired, the session was cancelled, or the amount/currency/ancestry contradicted trusted state.

1. Run `npm run payments:report` and record the safe order reference, failure code, provider, and timestamps in the incident system.
2. Inspect the provider dashboard and PostgreSQL state using least-privilege access. Do not alter payment/booking tables manually.
3. If the stored webhook is `VERIFIED` and the underlying inconsistency has been safely resolved, reprocess it once by internal webhook ID. Reprocessing remains idempotent.
4. If fulfillment cannot be proven safe, leave the order in review state. Phase 5A cannot refund, issue substitute tickets, or release payment-backed inventory automatically; escalate to the future provider/refund workflow or an approved manual provider procedure.

A failed or contradictory event never overwrites the first accepted terminal outcome. A booking must never be invented to clear an alert.

## Redis outage

Redis is delivery transport only. During an outage, verified webhook processing still commits the payment attempt, order, one booking, exact booking seats, `BOOKED` inventory, converted hold, and safe outbox rows in one PostgreSQL transaction. Outbox rows remain unprocessed while publishing fails.

Keep the dispatcher running or restart it after Redis recovers. Its PostgreSQL retry/backoff and Redis event deduplication drain pending rows without duplicating the booking. Confirm recovery with the Phase 4B inventory health endpoint/report and by checking that due outbox rows fall to zero. Never replay payment success from a Redis event.

## Health and alerting

`GET /api/operations/payments/health` is platform-admin only and returns counts/timestamps, not credentials or payloads. Alert on:

- any paid-unfulfilled order;
- failed or verified-unprocessed webhook events;
- increasing stale pending orders;
- a sustained gap between confirmed bookings and booked-seat expectations;
- existing outbox backlog/dead-letter or Redis connectivity alarms.

Operational targets should be defined before production enablement. Until an external adapter exists, the correct production response is to keep checkout disabled rather than bypass the deployment gate.

## Secret rotation

For a provider that supports overlapping webhook secrets, add the new secret, accept both during the provider's bounded rotation window, switch the provider endpoint, then remove the old secret. If overlap is unavailable, coordinate a short maintenance window and preserve/replay provider deliveries only through signature-verifiable provider mechanisms. Never reuse the local signed test secret in another environment.
