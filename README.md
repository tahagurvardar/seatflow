# SeatFlow

SeatFlow is a production-oriented event-ticketing portfolio project. The current repository contains **Phase 2: Venue management and versioned seat maps** on top of the Phase 0 public discovery and Phase 1 identity foundations.

All authenticated users are customers. Platform privilege is deliberately narrow (`USER` or `ADMIN`), while organizer and venue-operator capability comes from per-organization memberships (`OWNER`, `ADMIN`, or `MEMBER`).

## What is implemented

- Phase 0 landing page, event catalogue, event detail routes, responsive shell, and typed local fixtures
- PostgreSQL persistence through Prisma 7 and its PostgreSQL driver adapter
- Better Auth email/password registration, login, logout, and database-backed server sessions
- Server-owned platform roles; registration cannot submit or promote a role
- Multi-tenant organizations (`ORGANIZER` or `VENUE_OPERATOR`) and indexed memberships
- Protected customer, organizer, onboarding, and platform-admin routes
- Atomic organizer creation with an OWNER membership and duplicate-slug handling
- Venue-operator onboarding with an explicit `VENUE_OPERATOR` tenant and OWNER membership
- Tenant-scoped venue and space CRUD with draft/active/archive lifecycles
- Versioned draft seat maps with sections, rows, seats, bounded visual bulk-generation previews, coordinate-positioned canvases, reordering, seat types, and blocked states
- Physical, sellable, blocked, and per-type capacity summaries on maps and the space's current published configuration
- Atomic publication that archives the prior current version and makes the new snapshot immutable
- Atomic deep cloning from the current published map into the next server-assigned draft version
- PostgreSQL partial uniqueness, lifecycle checks, ownership/kind invariants, restrictive foreign keys, clone-provenance checks, and immutability triggers
- Server-rendered account navigation without an authentication flash
- Validated environment boundaries and an isolated, guarded integration-test database
- Unit/component tests plus security-focused PostgreSQL integration tests in CI

Phase 2 intentionally does **not** add persisted events or sessions, session inventory, pricing, holds, Redis, WebSockets, bookings, checkout, payments, refunds, coupons, QR tickets, scanning, email, analytics, or entry-control workflows.

## Routes

| Route | Access and purpose |
| --- | --- |
| `/` | Public marketing landing page |
| `/events` | Public filterable event catalogue backed by Phase 0 fixtures |
| `/events/[slug]` | Public event detail; future booking CTA remains disabled |
| `/login` | Better Auth email/password sign-in |
| `/register` | Customer registration; always creates a `USER` |
| `/customer/dashboard` | Any authenticated user; real identity and memberships |
| `/organizer/dashboard` | Members of an `ORGANIZER` tenant; deterministic tenant selection |
| `/organizer/onboarding` | Authenticated organization creation and OWNER assignment |
| `/venue-operator/onboarding` | Authenticated venue-operator creation and OWNER assignment |
| `/venue-operator/dashboard` | Select an authorized venue-operator tenant |
| `/venue-operator/organizations/[organizationSlug]/venues` | Tenant-scoped venue list and creation entry point |
| `/venue-operator/organizations/[organizationSlug]/venues/[venueSlug]` | Venue details, spaces, and archive lifecycle |
| `.../spaces/[spaceSlug]` | Space details and seat-map version history |
| `.../seat-maps/[version]` | Draft editor or immutable read-only preview |
| `/admin` | Platform `ADMIN` only; real identity/tenant counts |
| `/api/auth/[...all]` | Better Auth route handler |

## Local setup

Requirements: Node.js 22.12 or newer, npm, and PostgreSQL.

Create two different databases. The test command resets its target, so never point `TEST_DATABASE_URL` at a development or production database.

```sql
CREATE DATABASE seatflow;
CREATE DATABASE seatflow_test;
```

Then install, configure, and migrate:

```powershell
npm ci
Copy-Item .env.example .env
npm run db:migrate
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Environment parsing fails with a field-specific message when a required runtime value is missing or malformed.

`DIRECT_URL` is used by Prisma migrations. It can match `DATABASE_URL` locally; hosted providers that expose a pooled runtime URL should supply their direct/non-pooled connection here.

`SHADOW_DATABASE_URL` is optional and only needed when `prisma migrate dev` cannot create a temporary shadow database with the direct connection. Never point it at an application database.

## Database and quality commands

```bash
npm run db:generate
npm run db:migrate
npm run db:migrate:deploy
npm run db:reset
npm run db:studio
npm run db:test:migrate
npm run db:test:reset
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
```

`npm run test:integration` validates `TEST_DATABASE_URL`, refuses a shared or ambiguously named database, resets that database, applies committed migrations, and runs the serial integration suite.

## Administrator bootstrap

There is no public role-update endpoint or role field in registration. First register the account normally, then promote that exact existing email from a trusted terminal with database credentials:

```bash
npm run admin:promote -- --email admin@example.com --confirm
```

The explicit `--confirm` flag is required. The script cannot create an account and reports if the account is already an administrator.

## Project structure

```text
prisma/                       Schema and committed migrations
scripts/                      Guarded database and administrator commands
src/app/                      App Router pages, auth handler, and server actions
src/components/               Shared visual and interactive components
src/env/                      Environment schemas and runtime validation
src/features/                 Validation and pure organization/venue/seat-map domain logic
src/lib/                      Lazy database/auth clients and request authorization
src/server/                   Testable auth, authorization, venue, and seat-map services
tests/                        Unit/component tests
tests/integration/            Dedicated PostgreSQL integration tests
docs/                         Product, architecture, security, and roadmap contracts
```

See [product requirements](docs/product-requirements.md), [architecture](docs/architecture.md), [Phase 2 operations](docs/phase-2-operations.md), [security](docs/security.md), and [roadmap](docs/roadmap.md).
