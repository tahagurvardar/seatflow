# SeatFlow load and outage testing

Two guarded harnesses run against a **disposable local database only**:

```bash
npm run load:test -- --concurrency=8 --iterations=40
npm run chaos:verify
```

Both refuse to run when `NODE_ENV=production`, and both require
`TEST_DATABASE_URL` to name a database containing `test`, `local`, `scratch`, or
`loadtest`. Neither performs a destructive reset; they append synthetic fixtures
and leave existing rows alone.

## Why correctness, not throughput

Throughput numbers from a laptop are not a capacity model. What these harnesses
*can* prove — and what actually matters for a ticketing system — is that
concurrency never produces a wrong answer.

Every scenario asserts an invariant that must hold no matter how much load is
applied. A scenario fails on a broken invariant **regardless of how fast it ran**;
speed never excuses incorrectness.

## Load scenarios

| Scenario | Invariant asserted |
| --- | --- |
| `public_catalogue_read` | Every public catalogue read succeeds. |
| `session_inventory_snapshot` | Every snapshot returns a view. |
| `same_seat_contention` | Exactly one concurrent acquirer wins the contended seat. |
| `disjoint_seat_holds` | Every non-overlapping hold succeeds; no false contention. |
| `checkout_double_submit` | A repeated submission with one idempotency key creates exactly one order. |
| `duplicate_webhook_storm` | 16 concurrent duplicate deliveries create exactly one booking and one `BOOKED` seat. |
| `concurrent_duplicate_scans` | Concurrent scans of one credential accept exactly once. |
| `redis_outage_integrity` | Holds still commit while Redis is unreachable; invalidations stay durably queued. |

### Expected rejections are not errors

`same_seat_contention` reports a ~94% "error" rate and still passes. That is the
point: fifteen of sixteen contenders *must* be rejected. Contention scenarios
carry a deliberately wide error budget while their correctness assertion stays
strict.

## Measured results

Local run, `--concurrency=8 --iterations=40`, PostgreSQL 17.10 and Redis 7.4.9 on
one Windows development machine. **These are smoke-scale figures for regression
comparison, not a capacity model.**

| Scenario | Ops | Errors | p50 | p95 | max |
| --- | --- | --- | --- | --- | --- |
| `public_catalogue_read` | 40 | 0 | 77.8 ms | 257.8 ms | 346.0 ms |
| `session_inventory_snapshot` | 40 | 0 | 4.5 ms | 177.1 ms | 185.1 ms |
| `same_seat_contention` | 16 | 15 (expected) | 87.3 ms | 106.2 ms | 106.2 ms |
| `disjoint_seat_holds` | 8 | 0 | 55.3 ms | 57.6 ms | 57.6 ms |
| `checkout_double_submit` | 8 | 0 | 67.4 ms | 110.3 ms | 110.3 ms |
| `duplicate_webhook_storm` | 16 | 0 | 306.8 ms | 344.9 ms | 344.9 ms |
| `concurrent_duplicate_scans` | 16 | 0 | 193.4 ms | 296.4 ms | 296.4 ms |
| `redis_outage_integrity` | 8 | 0 | 98.2 ms | 100.7 ms | 100.7 ms |

Correctness observations from the same run:

- same seat: `successes=1 activeHolders=1`
- disjoint: `held=8/8`
- checkout: `orders=1`
- webhook storm: `bookings=1 bookedSeats=1` from 16 deliveries
- scans: `ACCEPTED=1 ALREADY_USED=15` from 16 concurrent attempts
- Redis outage: `held=8/8`, `pendingOutbox=24` durably queued
- database transaction retries: 0; recorded hold conflicts: 74

Zero transaction retries under this contention is expected: hold acquisition uses
deterministic row locks and a guarded `AVAILABLE` update, so losers are rejected
cleanly rather than deadlocking. Retries would indicate lock-ordering trouble.

## Outage and recovery scenarios

`npm run chaos:verify` runs eight checks:

| Scenario | Check |
| --- | --- |
| `redis_unavailable` | Hold commits with no Redis participation. |
| `redis_unavailable` | Invalidation is durably queued rather than lost. |
| `postgresql_unavailable` | Readiness reports `not_ready` instead of throwing. |
| `dispatcher_interrupted` | A replayed batch appends no duplicate stream entries. |
| `dispatcher_interrupted` | Replayed rows still reach a processed state. |
| `backlog_recovery` | Backlog drains once the transport returns. |
| `stale_worker_heartbeat` | A worker instance that stopped reporting is classified stale. |
| `worker_restart` | A restarted instance immediately reports healthy again. |

Latest run: **8/8 passed.** The dispatcher check observed stream length `121 →
121` across 2 replayed rows, directly demonstrating that the Lua
deduplicate-then-append operation prevents a duplicate delivery when an
acknowledgement is lost after a successful publish.

## Safety design

`assertSafeLoadTestTarget` enforces, in order:

1. `NODE_ENV` is not `production`;
2. the database name is marked disposable;
3. any HTTP base URL is loopback, unless `--allow-non-local` is passed.

`--allow-non-local` relaxes **only** the HTTP host check. It cannot bypass the
production check or the disposable-database check — a unit test asserts this.

`boundLoadTestParameters` clamps operator input to a maximum of 64 concurrency,
120 seconds, and 5000 iterations, so a mistyped flag cannot launch an unbounded
run.

## No real side effects

- Payments use the deterministic `LOCAL_SIGNED` provider. No external call, no
  card data.
- No email is sent; the notification provider is not invoked by the harness.
- All identities are synthetic `@example.com` users created by the harness.
- The harness pins `TICKET_CREDENTIAL_SECRET` to its own value so a run is
  reproducible on any machine and never depends on a developer's `.env`.

## Interpreting a failure

A failing invariant is a correctness bug and must block release. A failing
latency threshold on a developer machine usually is not — check whether other
work was running before treating it as a regression.

Two harness bugs found and fixed during development are worth knowing about, as
both are easy to reintroduce:

- reusing a customer across concurrent holds violates the one-active-hold-per-
  customer-per-session index, so each concurrent holder must be a distinct user;
- the fixture session must start soon enough to fall inside the ticket entry
  window, or every scan correctly returns `TOO_EARLY`.
