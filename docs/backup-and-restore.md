# SeatFlow backup and restore

A SeatFlow backup contains complete customer, payment, booking, ticket, and
redemption data. Treat every archive with the same protection as a production
secret.

**Never commit a backup.** `.gitignore` blocks `*.dump`, `*.backup`, `*.sql.gz`,
and `/backups/`, and `assertSafeBackupPath` refuses to write inside the
repository at all.

## Prerequisites

`pg_dump`, `pg_restore`, and `psql` must be on `PATH`, or their directory
supplied through `PG_BIN_DIR`. A portable install would set something like:

```bash
# Generic example only — substitute your own installation path.
export PG_BIN_DIR=/path/to/postgresql/bin
```

## Creating a backup

```bash
npm run backup:create -- --out /secure/backups/seatflow
```

The command:

1. dumps in PostgreSQL custom format (`--format=custom --no-owner
   --no-privileges`);
2. immediately verifies integrity by listing the archive's table of contents —
   a truncated or corrupt archive cannot be listed;
3. reports size and entry count.

`pg_dump` never writes to its source, so this is safe against a live database.
It refuses any destination inside the repository.

## Verifying a restore

A backup you have never restored is a hypothesis, not a backup. Verification
restores into a **separate disposable database** and proves four things.

```bash
npm run backup:verify -- \
  --file /secure/backups/seatflow/seatflow-2026-07-19T10-00-00-000Z.dump \
  --target postgresql://user@host:5432/seatflow_verify \
  --confirm
```

| Check | What it proves |
| --- | --- |
| Integrity | The archive's table of contents is readable. |
| Restore | `pg_restore` completes without a fatal error. |
| Migration compatibility | The restored schema is at or beyond the migration this build expects. |
| Critical row counts | 16 critical tables match the source exactly. |

### Safety guards

`assertDisposableRestoreTarget` refuses unless **all** hold:

- the target database name contains `verify`, `verification`, `restore`,
  `scratch`, or `test`;
- the target does not equal `DATABASE_URL` or `DIRECT_URL`;
- the target does not resolve to the same host and database as a protected URL,
  even when spelled differently (extra credentials or query parameters);
- `--confirm` was passed explicitly.

These guards are unit tested, including the equivalent-URL case.

Ordinary test runs never back up or restore anything. The only database this
tooling will overwrite is one an operator has explicitly named as disposable.

## What a restore does not recover

**Redis is not backed up, and does not need to be.** It holds only disposable
invalidation transport, BullMQ coordination, event-deduplication markers,
ephemeral client gauges, and rate-limit counters. Expect to lose all of it and
plan accordingly:

| Redis contents | After loss |
| --- | --- |
| Inventory event stream | Rebuilt naturally: unprocessed outbox rows are still in PostgreSQL and the dispatcher republishes them. |
| Event-deduplication markers | Worst case is one duplicate stream entry. Clients already tolerate duplicates and re-read PostgreSQL. |
| BullMQ repeatable job | Re-register with `npm run holds:schedule`. Expiry itself is a PostgreSQL sweep and never depended on Redis TTLs. |
| Realtime client gauge | Cosmetic; repopulates as clients connect. |
| Rate-limit counters | Budgets reset. Abuse protection is briefly more permissive; no correctness impact. |

Rebuilding Redis transport state from PostgreSQL is therefore just: start the
dispatcher, re-register the schedule, start the gateway.

## Post-restore reconciliation

After any restore, drain each backlog before reopening traffic:

```bash
npx prisma migrate status
npm run inventory:dispatch      # repeat until claimed=0
npm run tickets:report
npm run tickets:issue           # repeat until claimed=0
npm run notifications:dispatch
npm run payments:report
npm run production:check
```

Expected end state: outbox backlog zero, ticket issuance backlog zero, missing
credentials zero, notification pending zero, and no new paid-unfulfilled orders.

A restore rewinds time. Any booking, ticket, or redemption created after the
backup point is gone from the database but may still exist at the payment
provider or in a customer's inbox. Reconcile against the provider before
reopening checkout, and treat divergence as a payments incident (runbook 9).

## Recovery after a deployment rollback

Migrations are additive and forward-only. Roll application code back freely;
**never** revert a migration to match rolled-back code. If old code cannot run
against the new schema, fix forward. See incident runbook 14.
