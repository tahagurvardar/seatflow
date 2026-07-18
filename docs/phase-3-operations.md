# Phase 3 operations and persistence contract

## Local and deployment workflow

Use Node.js 22.12 or newer and PostgreSQL. Configure distinct `DATABASE_URL` and guarded `TEST_DATABASE_URL` targets, plus `DIRECT_URL`, Better Auth values, and `NEXT_PUBLIC_APP_URL`. `SHADOW_DATABASE_URL` is optional and must not point to an application database.

Local setup is `npm ci`, `npm run db:migrate`, and `npm run dev`. Deployment uses `npm ci`, `npm run db:migrate:deploy`, `npm run build`, and the Next.js Node runtime behind HTTPS. Never run reset, integration-test, or development-migration commands against production.

## Phase 3 migration

`20260718030000_phase_3_events_sessions_access_pricing` appends the event, session, access-grant, tier, and section-pricing model after the Phase 1/2 migrations. It installs `btree_gist`, partial uniqueness, check constraints, restrictive foreign keys, overlap exclusion, ancestry/kind validation, and immutability triggers. Existing migrations remain unchanged and future changes must append another migration.

PostgreSQL must permit `CREATE EXTENSION btree_gist` for migration deployment. Managed environments should enable or approve that extension before rollout if their migration role cannot install extensions.

## Operational invariants

- Monetary values are integer minor units; supported currencies are `AZN`, `EUR`, `GBP`, and `USD`.
- Venue-local inputs convert to UTC; venue IANA zones control display.
- Active session ranges in one space are half-open and cannot overlap. Exact turnover boundaries are accepted.
- Draft is the only editable session/pricing state.
- A published session retains its exact published seat-map version and complete pricing snapshot.
- Grant revocation prevents future draft use but preserves published session history.
- Public pages have no mock fallback; an empty database produces an empty catalogue.

## Release verification

Run, in order:

```bash
npm run db:generate
npx prisma format --check
npx prisma validate
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
```

The integration command resets a dedicated test database and proves clean migration application. A release review should also exercise access grant/revoke, event/session creation, exact map selection, pricing coverage, publication, cancellation, cross-tenant denial, overlap rejection, public discovery, and desktop/mobile rendering.

## Explicit exclusions

Capacity is configuration, not live inventory. Phase 3 has no holds, Redis, WebSockets, bookings, orders, checkout, payments, tickets, QR codes, coupons, refunds, email, per-seat overrides, dynamic pricing, or sales analytics. No revenue or availability claim should be derived from Phase 3 records.
