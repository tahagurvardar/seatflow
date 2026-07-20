# SeatFlow deployment process matrix

SeatFlow is a modular monolith plus separate long-lived worker processes. A
serverless-only deployment is insufficient: the dispatcher, expiry worker, and
Socket.IO gateway all require persistent hosts.

## Process matrix

| Process | Command | Scale | Redis | PostgreSQL | Heartbeat | Readiness role |
| --- | --- | --- | --- | --- | --- | --- |
| Web application | `npm run start` | many | optional | required | n/a | `web` |
| Inventory outbox dispatcher | `npm run inventory:dispatcher` | 1+ | required | required | `INVENTORY_OUTBOX_DISPATCHER` | `inventory_dispatcher` |
| Hold expiry worker | `npm run holds:worker` | 1+ | required | required | `HOLD_EXPIRY_WORKER` | `hold_expiry_worker` |
| Realtime gateway | `npm run realtime:gateway` | 1+ | required | required | `REALTIME_GATEWAY` | `realtime_gateway` |
| Ticket issuance dispatcher | `npm run tickets:issue` | scheduled | not used | required | `TICKET_ISSUANCE_DISPATCHER` | `ticket_issuance_dispatcher` |
| Notification dispatcher | `npm run notifications:dispatch` | scheduled | not used | required | `NOTIFICATION_DISPATCHER` | `notification_dispatcher` |
| Payment reconciliation | `npm run payments:reconcile -- --limit=100` | scheduled | not used | required | `PAYMENT_RECONCILIATION` | `payment_reconciliation` |
| Checkout expiry | `npm run checkouts:expire` | scheduled | not used | required | — | — |
| Hold schedule registration | `npm run holds:schedule` | once per rollout | required | not used | — | — |

Every process in the first column must appear in `SEATFLOW_DECLARED_WORKERS`, or
`npm run production:check` fails with `workers_undeclared`.

Scaling any of these horizontally is safe. Dispatchers claim work with
`FOR UPDATE SKIP LOCKED`, so concurrent instances partition rather than collide.

## Redis dependency by process

The web tier is deliberately **not** Redis-dependent for correctness. Readiness
returns `warn` for `web` and `fail` for worker roles, so a Redis outage degrades
the site instead of removing every instance from rotation.

| Capability | Redis down |
| --- | --- |
| Browse, seat selection, hold acquisition | works |
| Checkout, webhook fulfillment, booking | works |
| Ticket issuance, QR, PDF, entry validation | works |
| Realtime invalidation | degrades to focus + 30 s polling |
| Distributed rate limiting | degrades to per-process counters |
| BullMQ expiry scheduling | stops; run `npm run holds:sweep` manually |

## Trusted proxy by topology

| Topology | `TRUSTED_PROXY_MODE` | Additional |
| --- | --- | --- |
| Direct to the Node process | `none` | — |
| One reverse proxy appending `X-Forwarded-For` | `trusted-hop` | `TRUSTED_PROXY_HOP_COUNT=1` |
| Two proxies (CDN + load balancer) | `trusted-hop` | `TRUSTED_PROXY_HOP_COUNT=2` |
| Platform that overwrites a dedicated header | `platform-header` | `TRUSTED_PROXY_HEADER=cf-connecting-ip` |

Getting the hop count wrong is a security bug, not a tuning detail. Too high
attributes traffic to the proxy and collapses every client into one bucket; too
low lets a caller inject an address by prepending to the header. Verify against
real traffic before enabling abuse controls in anger.

## Release gate

```bash
npm ci
npx prisma format --check && npx prisma validate && npm run db:generate
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:redis
npm run test:provider
npm run test:notification
npm run test:pdf
npm run load:test
npm run chaos:verify
npm run build
npm audit
git diff --check
npm run production:check
```

## Rollout order

1. Verify a backup restores (`docs/backup-and-restore.md`).
2. `npm run db:migrate:deploy`; confirm with `npx prisma migrate status`.
3. Deploy the web process; confirm `/api/health/ready` is not `not_ready`.
4. Start every worker; confirm fresh heartbeats in `/api/operations/metrics`.
5. `npm run holds:schedule` once.
6. `npm run production:check` with live probes.

Migrations are additive and forward-only, so new code may be deployed after its
migration but never before — readiness fails with `database_behind_code` if that
ordering is violated.

## Rollback

Roll application code back freely. **Never** revert a migration to match
rolled-back code; fix forward instead. See incident runbook 14.

## Current deployment gate

`npm run production:check` fails by design on:

- `payment_provider_gate` — no reviewed external payment adapter exists;
- `notification_provider_gate` — no reviewed external notification adapter
  exists.

Both are Phase 5C2 work. Until then, production traffic must remain disabled.

## Phase 5C2A additions

### New deployment gates

`production:check` now blocks on, in addition to the Phase 5C1 gates:

| Gate | Blocks when |
|---|---|
| `stripe_*` | Stripe selected but key, webhook secret, or explicit mode missing; live mode holding a test key or the reverse; test mode reaching production; rotation window that never closes |
| `webhook_coverage_incomplete` | Refund or dispute events not declared in `STRIPE_WEBHOOK_EVENTS` |
| `resend_*` | Resend selected but key, sender identity, or explicit mode missing; test mode reaching production |
| `refund_backlog_gate` | Refund reconciliation backlog exceeds `DEPLOY_MAX_REFUND_BACKLOG` |
| `chargeback_gate` | Unresolved chargebacks exceed `DEPLOY_MAX_UNRESOLVED_CHARGEBACKS` |
| `financial_divergence_gate` | **Any** ledger divergence |
| `ticket_revocation_gate` | **Any** refunded booking still holding an active ticket |
| `financial_probe_unavailable` | A financial probe could not be evaluated |

The last one matters most: an unevaluated gate blocks. A failed probe is never read as "no backlog".

### Migration

One additive migration, `20260719120000_phase_5c2a_refunds_disputes_ledger`. Verified to replay cleanly as part of the full chain on the disposable test database, and to deploy non-destructively to a populated database with all existing rows intact.

`Booking_refund_lifecycle_check` compares `"status"::text` deliberately: PostgreSQL forbids using an enum value added earlier in the same transaction, and `REFUNDED` is added by this migration.

### New operational commands

| Command | Mode |
|---|---|
| `npm run refunds:reconcile -- <action> [--dry-run] [--batch=N]` | Idempotent; `submit` and `ambiguous` call the provider under precommitted idempotency keys and hold no database lock |
| `npm run refunds:submit` | Submits pending refunds |
| `npm run financial:report [-- --json]` | Strictly read-only |

None can settle a refund, create a dispute, reopen inventory, or rewrite history.

### Verification status

Stripe and Resend adapters compile and are type-checked but have **not** been verified against real sandbox credentials, which are absent from this environment. No real-money charge and no real customer email has occurred. A sanitized production-like `production:check` reports no findings, which validates that the configuration rules are satisfiable — it is **not** provider verification. Sandbox, staging, and launch are Phase 5C2B.
