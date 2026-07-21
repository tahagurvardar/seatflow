# Contributing to SeatFlow

Thanks for taking a look. This document covers what you need to run the project
locally and what a change is expected to satisfy before it is merged.

## Requirements

- **Node.js 22.12 or newer** (CI runs Node 22)
- **npm** — use `npm ci`, so the lockfile stays authoritative
- **PostgreSQL 17** — two databases, one for development and one for tests
- **Redis 7+** — optional, and needed only for the Redis transport suite

Next.js in this repository is a current major release. Its APIs and file
conventions differ from older guides, so check `node_modules/next/dist/docs/`
before assuming an older pattern still applies, and heed deprecation notices.

## Setup

```bash
npm ci
cp .env.example .env      # then fill in your own local values
npm run db:migrate
npm run dev
```

```sql
CREATE DATABASE seatflow;
CREATE DATABASE seatflow_test;
```

`.env.example` and `.env.staging.example` are templates containing placeholders
only. `DIRECT_URL` may equal `DATABASE_URL` locally; a hosted pooled connection
should provide a separate direct URL for migrations.

## Checks

Run these before opening a pull request — CI runs the same set:

```bash
npm run lint
npm run typecheck
npm test              # unit and component
npm run build
```

Suites that need a service:

```bash
npm run test:integration   # PostgreSQL, serial
npm run test:redis         # PostgreSQL + Redis
npm run test:browser       # Playwright, against a production build
```

## Databases must be disposable

Integration and browser suites **reset the database they are pointed at**. They
are guarded: `TEST_DATABASE_URL` must name a clearly test-marked database and
must not equal `DATABASE_URL` or `DIRECT_URL`, and the harness refuses to run
otherwise. Do not weaken that guard, and do not point it at a database whose
contents you would miss.

Never run a reset, drop, truncate, or `db push` against a shared, hosted, or
otherwise non-disposable database. Migrations are append-only: add a new
migration rather than editing or deleting a committed one.

## Secrets

No secret ever belongs in a commit, a test fixture, a log line, an error
message, or a command argument. `.env`, `.env.local`, and `.env.staging.local`
are ignored and must stay that way. Operational tooling in `scripts/` reports
variable **names** and status, never values — please preserve that property in
anything you add.

If you believe a credential has been exposed, rotate it first and report it
second.

## Commits and pull requests

Use Conventional Commits:

```
feat: add waitlist support for sold-out sessions
fix: release a hold when its session is cancelled
docs: clarify the refund reconciliation runbook
test: cover concurrent refund serialization
chore: update CI to Node 22
refactor: extract seat-map validation
```

Write the body to explain **why**, not what the diff already shows. Keep a pull
request focused on one concern, and describe how you verified it.

Changes touching payments, refunds, tickets, or entry validation should say
explicitly which invariant they preserve — exact-once fulfilment, append-only
ledger, verified-webhook-only settlement, or PostgreSQL as seat authority. A
change that relaxes one of those needs a strong argument and a test proving the
new boundary.
