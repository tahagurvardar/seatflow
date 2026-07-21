# Neon staging database

Free-tier PostgreSQL 18 in AWS `eu-central-1` (Frankfurt), project
`seatflow-staging`.

## Pooled and direct are not interchangeable

Neon exposes two endpoints for the same database, distinguished by a `-pooler`
suffix on the first host label:

```
DATABASE_URL  ep-name-123456-pooler.eu-central-1.aws.neon.tech   pooled
DIRECT_URL    ep-name-123456.eu-central-1.aws.neon.tech          direct
```

| Variable | Endpoint | Used by | Why |
|---|---|---|---|
| `DATABASE_URL` | pooled | application runtime | Serverless functions fan out across isolates. Without PgBouncer they exhaust Neon's connection limit under any real traffic. |
| `DIRECT_URL` | direct | Prisma migrations | The pooler runs in transaction mode and cannot hold the session-level advisory lock a migration takes. |

Getting these backwards produces two confusing failures rather than one clear
one: migrations hang or error obscurely, and the application intermittently
cannot connect. `classifyNeonConnection` detects the swap and both
`staging:secrets` and `staging:migrate` refuse it by name.

## Migration safety

```bash
npm run staging:migrate -- status    # read-only
npm run staging:migrate -- deploy    # requires typed "yes"
```

The command refuses to proceed unless **every** gate passes:

- `DIRECT_URL` is set and parseable
- the host is not loopback
- the host is a `neon.tech` endpoint
- the database is not named `seatflow` or `seatflow_test` (local names)
- `DIRECT_URL` is not the pooled endpoint
- `DATABASE_URL` is not the direct endpoint
- the two differ

It never prints a connection string: Prisma's output is filtered for both
`postgres://` URLs and Neon host patterns before it reaches the terminal.

### What it will never do

`prisma migrate reset` is **not reachable** from this command, by construction.
Neither is seeding. `deploy` applies pending migrations and nothing else.

The Neon database being new and empty is not a reason to relax this. That exact
reasoning — "it's empty, it's fine" — is how a migration eventually gets pointed
at a database that is not empty.

### Authorization marker

`deploy` prompts for a typed `yes` unless `.staging-migration-authorized` exists
in the repository root. That file is gitignored: it records a decision made on
one machine and must not travel to another.

## Applying the first migration

```bash
npm run staging:secrets -- check     # confirm the URLs are the right way round
npm run staging:migrate -- status    # expect: all migrations pending
npm run staging:migrate -- deploy    # type "yes"
npm run staging:migrate -- status    # expect: up to date
```

`migrate deploy` applies the full Phase 1 → 5C2B chain in order, including every
CHECK constraint and plpgsql trigger. Those are a second line of defence behind
application validation and are as load-bearing in staging as in production.

## Free-tier characteristics

| Characteristic | Consequence |
|---|---|
| Scale-to-zero when idle | First query after idle takes seconds |
| Connection limit | Runtime must use the pooled endpoint |
| Storage and compute quota | Adequate for demo data; not for load testing |
| No commercial SLA | The database may be briefly unavailable |

Do not run `npm run load:test` against Neon. The harness is loopback-only unless
explicitly overridden, and pointing it at a free tier would exhaust the quota
and prove nothing about production capacity.

## Backups

The Phase 5C1 backup tooling (`npm run backup:create`) targets a local
PostgreSQL with `pg_dump` available. It is not wired to Neon, and the staging
demo holds only synthetic data, so there is nothing here that needs preserving.

Neon's own branching and point-in-time restore are available on the free tier if
you want a snapshot before a risky migration.

## Never do this to Neon

- `prisma migrate reset`
- `DROP`, `TRUNCATE`, or `prisma db push --force-reset`
- point `TEST_DATABASE_URL` at it — the integration runner resets its target
- reuse its credentials anywhere else
