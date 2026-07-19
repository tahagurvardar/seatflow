# Phase 5C1 production readiness

Phase 5C1 prepares SeatFlow for a *future* controlled production deployment. It
adds observability, abuse controls, health separation, backup verification,
accessibility validation, load and outage testing, and a configuration gate.

**Phase 5C1 does not enable production traffic.** `npm run production:check`
still fails by design, because this build contains no reviewed external payment
or notification adapter. That work is Phase 5C2.

## What Phase 5C1 changes

| Area | Before | After |
| --- | --- | --- |
| Logging | `console.info` with ad-hoc strings | Structured, redacted records with correlation IDs |
| Correlation | none | Validated `x-correlation-id` through web, workers, webhooks |
| Health | one protected route per subsystem | Separate liveness, readiness, and protected metrics |
| Worker visibility | inferred from metric timestamps | Durable `WorkerHeartbeat` with stale detection |
| Rate limiting | process-local, blindly trusted `X-Forwarded-For` | Redis-backed distributed limits under an explicit trusted-proxy policy |
| Security headers | none | CSP with per-request nonce, frame/MIME/referrer/permissions policy, HSTS |
| Backup | documented intent | Non-destructive backup, integrity check, and guarded restore verification |
| Load testing | none | Guarded harness asserting correctness invariants under contention |
| Outage testing | Redis suite only | Dedicated chaos verification with recovery checks |

## Authority is unchanged

PostgreSQL remains the sole authority for inventory, holds, orders, payments,
bookings, tickets, ticket validation, and notification state. Nothing in this
phase moves a correctness decision into Redis.

Redis supports transport, scheduling, distributed rate limiting, and transient
coordination. Every Redis dependency added here degrades safely:

- the distributed limiter falls back to the process-local limiter;
- readiness reports `warn` for the web role and `fail` only for worker roles
  that genuinely require Redis;
- hold acquisition, checkout, webhook fulfillment, ticket issuance, and entry
  validation are unchanged and were re-verified under a simulated Redis outage.

## New configuration

All new settings are optional with safe defaults. See `.env.example`.

```dotenv
SEATFLOW_SERVICE_NAME=seatflow-web
LOG_LEVEL=info

TRUSTED_PROXY_MODE=none          # none | trusted-hop | platform-header
TRUSTED_PROXY_HOP_COUNT=1
# TRUSTED_PROXY_HEADER=cf-connecting-ip

RATE_LIMIT_ENABLED=true
WORKER_HEARTBEAT_STALE_SECONDS=180

READINESS_MAX_OUTBOX_BACKLOG=500
READINESS_MAX_OUTBOX_AGE_SECONDS=300
DEPLOY_MAX_DEAD_LETTERS=0
DEPLOY_MAX_PAID_UNFULFILLED=0

SECURITY_HEADERS_ENABLED=true
SECURITY_HSTS_MAX_AGE_SECONDS=31536000

SEATFLOW_DECLARED_WORKERS=INVENTORY_OUTBOX_DISPATCHER,HOLD_EXPIRY_WORKER,REALTIME_GATEWAY,TICKET_ISSUANCE_DISPATCHER,NOTIFICATION_DISPATCHER,PAYMENT_RECONCILIATION
```

`TRUSTED_PROXY_MODE` defaults to `none`, which ignores forwarding headers
entirely. That is the safe default and the correct value when the process is
reached directly. Set it deliberately — see the trusted-proxy section of
`docs/security.md`.

## Migration

One additive migration, `20260719000000_phase_5c1_worker_heartbeats`, introduces
the `WorkerType` and `WorkerHealthStatus` enums and the `WorkerHeartbeat` table.
It alters no existing table, constraint, or trigger and requires no backfill.

```bash
npm run db:migrate:deploy
npx prisma migrate status
```

## New commands

```bash
npm run production:check              # read-only deployment gate
npm run production:check -- --json    # machine-readable findings
npm run production:check -- --skip-probes

npm run backup:create -- --out <directory outside the repo>
npm run backup:verify -- --file <dump> --target <disposable url> --confirm

npm run load:test -- --concurrency=8 --iterations=40
npm run chaos:verify
```

## Endpoints

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /api/health/live` | public | Process liveness. No dependency I/O. |
| `GET /api/health/ready` | public (minimal) / admin (detailed) | Fitness to serve. 503 only on hard failure. |
| `GET /api/operations/metrics` | platform ADMIN | Bounded aggregate metrics. |
| `GET /api/operations/inventory/health` | platform ADMIN | Phase 4B subsystem health. |
| `GET /api/operations/payments/health` | platform ADMIN | Phase 5A subsystem health. |
| `GET /api/operations/tickets/health` | platform ADMIN | Phase 5B subsystem health. |

## Deployment sequence

1. `npm ci`
2. `npm run production:check -- --skip-probes` against the target configuration.
   Resolve every error except the two intentional external-provider gates.
3. Back up the target database and verify the backup restores
   (`docs/backup-and-restore.md`).
4. `npm run db:migrate:deploy`, then `npx prisma migrate status`.
5. Deploy the web process. Confirm `/api/health/ready` returns `degraded` or
   `ready`, never `not_ready`.
6. Start every declared worker process. Confirm each reports a fresh heartbeat
   through `/api/operations/metrics`.
7. `npm run production:check` with live probes. The migration and dead-letter
   gates must pass.
8. Keep checkout disabled until Phase 5C2 delivers reviewed external adapters.

## Running the PostgreSQL integration suite

**The integration suite must not run concurrently against the same
`seatflow_test` database.** Run exactly one instance at a time.

Each test resets shared tables in `beforeEach`, so two concurrent runs truncate
each other's fixtures mid-test. The failures this produces are misleading: they
surface as unrelated assertion failures in whichever file happened to be running
(for example Phase 4A materialization tests), which reads like flakiness in
already-verified code rather than like interference.

This is a property of the guarded reset workflow, not a defect, and it is *not*
worked around by parallelising the suite. Splitting it across databases or
schemas would need a proven isolation design — per-worker database provisioning
plus a matching guard in `readSafeTestDatabaseUrl` — and until that exists the
serial constraint is the safe behaviour. Do not add parallelism to make the
suite faster.

If you see integration failures that do not reproduce on a clean serial run,
check for a second `npm run test:integration`, `npm run test:redis`,
`npm run load:test`, or `npm run chaos:verify` still running.

## Known limitations

These are stated plainly rather than implied:

- **No production traffic is authorized.** The external payment and notification
  adapters do not exist, and `production:check` blocks on both.
- **Correlation is not distributed tracing.** There is no span model, no trace
  propagation standard, and no sampling. A correlation ID links log records
  within this system only.
- **Rate-limit windows are fixed, not sliding.** A burst can straddle a window
  boundary and briefly admit up to twice the limit.
- **Process metrics are per-instance and reset on restart.** Only the PostgreSQL
  aggregates survive a deployment.
- **The CSP allows `'unsafe-inline'` for styles**, because the seat map
  positions seats with inline style attributes. Scripts remain nonce-gated.
- **Accessibility is audited, not certified.** See
  `docs/accessibility-verification.md` for exactly which criteria were tested and
  which gaps remain.
- **Load and chaos harnesses are local-only.** They exercise service functions
  against a disposable database, not a deployed HTTP surface under real network
  conditions.
