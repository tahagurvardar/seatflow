# Phase 4A inventory and hold operations

## Scope and authority

Phase 4A adds sellable session inventory and temporary customer seat holds. PostgreSQL is the only authoritative source for inventory state, hold ownership, immutable price snapshots, and expiry decisions. There is no Redis, BullMQ, WebSocket, Socket.IO, real-time delivery, automatic job scheduler, checkout, payment, booking, or ticket subsystem.

Browser countdowns and selection totals are informational previews. Every hold request rechecks server/database state and returns the official immutable total. Availability changes made by another customer appear after refresh or the next request.

## Migration and rollout

Migration `20260718040000_phase_4a_session_inventory_and_holds` adds:

- enums `SeatInventoryState` (`AVAILABLE`, `HELD`) and `SeatHoldStatus` (`ACTIVE`, `RELEASED`, `EXPIRED`)
- `SessionSeatInventory`, `SeatHold`, and `SeatHoldItem`
- uniqueness, partial uniqueness, lifecycle, price, and state-consistency constraints
- ancestry/snapshot validation and immutable-history triggers
- restrictive foreign keys and query/sweeper indexes

For an existing environment, use this order:

```bash
npm ci
npm run db:migrate:deploy
npm run db:generate
npm run holds:backfill
npm run build
```

The migration is additive and does not reset existing development data. Never run `db:reset`, the integration runner, or a test-database command against a development or production database. Production rollout still requires a backup, a reviewed migration window, and the deployment's normal rollback/incident process.

## Hold configuration

Defaults are server-owned and conservative:

| Setting | Environment override | Default | Accepted range |
| --- | --- | ---: | ---: |
| Hold lifetime | `SEAT_HOLD_DURATION_MINUTES` | 10 minutes | 1–60 minutes |
| Maximum seats per hold | `SEAT_HOLD_MAX_SEATS` | 8 | 1–20 |
| Expiry sweep batch size | `SEAT_HOLD_SWEEP_BATCH_SIZE` | 100 | 1–1,000 |

Invalid overrides fail startup/command validation. Changing a default affects new requests only; existing hold expiry timestamps and price snapshots are never rewritten.

## Inventory materialization

Publication materializes inventory inside the session-publication transaction. The source is the session's exact immutable published seat map plus its section pricing:

- each `ACTIVE` physical seat in a priced section creates one inventory row
- `BLOCKED` seats are excluded
- unpriced sections create no inventory and prevent valid publication
- the assigned tier ID, integer `priceMinor`, and currency are copied as immutable snapshots
- `(sessionId, seatId)` prevents duplicates
- publication commits only when inventory count equals computed sellable capacity

Published sessions that predate the migration need an explicit additive backfill:

```bash
npm run holds:backfill
```

The command scans only published events with published, non-terminal sessions. It revalidates pricing, skips complete inventory, skips ineligible sessions, materializes only zero-inventory eligible sessions, and refuses partial/inconsistent inventory. It never resets data, deletes rows, or invents pricing. Review its `materialized`, `already complete`, `ineligible`, and `refused` counts; any refused session requires investigation rather than an automatic repair.

The backfill is idempotent and safe to rerun. Run it after the Phase 4A migration and before advertising seat selection for pre-existing sessions.

## Acquisition and idempotency

The hold API accepts only a session ID, one to the configured maximum physical-seat IDs, and a bounded idempotency key. The authenticated session supplies the customer. Client user ID, internal inventory ID, price, currency, total, expiry, and status are not part of the contract.

Acquisition performs lazy expiry cleanup, locks requested inventory rows in deterministic seat order, rechecks event/session status and sales windows using server time, requires every row to be `AVAILABLE`, then creates the hold, claims every row, and writes every immutable item in one transaction. Missing, blocked, stale, cross-session, or contended selections roll back completely.

The transaction helper retries only PostgreSQL deadlock/serialization failures, with bounded jitter. Availability, validation, authorization, and payload conflicts are returned immediately. An identical customer/session/key retry with the exact order-independent seat set returns the existing hold. Reusing the key with different seats is rejected.

## Lifecycle, expiry, release, and cancellation

A hold starts `ACTIVE` and ends exactly once as `RELEASED` or `EXPIRED`. Terminal holds and their items remain permanent history and cannot be revived.

- The authenticated owner may release an active hold manually. A repeated owner release is an idempotent no-op.
- A customer cannot release another customer's hold, even with its public token.
- Acquisition lazily expires overdue active holds for the target session before locking seats, so scheduler downtime does not permanently trap capacity.
- Cancelling a session locks its inventory, changes the session to `CANCELLED`, releases every active hold, and returns every seat to `AVAILABLE` in the same transaction.
- New holds are rejected for paused, cancelled, completed, started, not-yet-open, or sales-ended sessions and for unavailable parent events.

## Expiry sweeper

Run the bounded sweeper manually or from an approved external scheduler:

```bash
npm run holds:sweep
npm run holds:sweep -- --batch-size 100 --max-batches 10
```

Each batch claims overdue active holds ordered by expiry with `FOR UPDATE SKIP LOCKED`, commits independently, marks each claimed hold `EXPIRED`, and releases only inventory still linked to it. Concurrent sweepers safely partition work. The command is idempotent and prints expired-hold, released-seat, and batch counts.

Phase 4A does not install or claim an automatic scheduler. Operators should monitor command exit status and compare active overdue holds with inventory if they choose to schedule it externally. Lazy reclamation remains the safety net, not the preferred steady-state operating mode.

## Database and test safety

`DATABASE_URL`/`DIRECT_URL` target the application database. `TEST_DATABASE_URL` must name a clearly disposable test database and must differ from runtime/development URLs. Only the guarded integration commands may reset the test target:

```bash
npm run db:test:reset
npm run test:integration
```

The development backfill uses `DATABASE_URL` and is additive. It must never run with a test URL accidentally aliased to development, and the development database must not be reset to perform Phase 4A rollout.

## Release verification

Run the complete gate after migration, backfill, tests, or hold-service changes:

```bash
npx prisma format --check
npx prisma validate
npm run db:generate
npm run db:migrate:deploy
npx prisma migrate status
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
git diff --check
```

Concurrency acceptance must prove: one winner for the same seat, no double allocation for overlapping selections, no partial claim after a failed multi-seat request, two successes for disjoint selections, one hold for an idempotent retry, rejection of a changed idempotency payload, reacquisition after expiry/release, denial of cross-user release, and release on session cancellation.

Browser acceptance should cover desktop and narrow mobile selection, coordinate rendering, seat type/section/price information, multi-seat totals, maximum feedback, pending/conflict states, hold detail/countdown/dashboard, release/reacquisition, stale/conflicting submissions, organizer aggregate inventory, cancellation, console cleanliness, and horizontal overflow. Refresh-based synchronization is expected.

## Next phases

Phase 4B should preserve PostgreSQL authority and add an outbox-backed availability event stream, an optional disposable Redis projection, authenticated session-scoped real-time delivery, reconnect/snapshot versioning, scheduled sweeps, drift reconciliation, metrics, and failure/load tests. Cache loss must degrade to PostgreSQL request-time correctness.

Phase 5 is the first checkout/payment/booking/ticket phase. It should consume a valid Phase 4A hold and its immutable item snapshots; Phase 4A itself must never be described as a booking, sale, charge, or ticket.
