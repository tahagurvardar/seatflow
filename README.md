# SeatFlow

SeatFlow is a production-oriented event-ticketing portfolio project. The repository now contains **Phase 5B: secure ticket issuance, delivery, and authoritative entry validation**, built on exact-once payment and booking fulfillment.

Every authenticated user remains a customer. Platform privilege is deliberately narrow (`USER` or `ADMIN`); organizer and venue-operator capability comes from organization memberships (`OWNER`, `ADMIN`, or `MEMBER`).

## What is implemented

- PostgreSQL and Prisma persistence with Better Auth email/password sessions
- Multi-tenant `ORGANIZER` and `VENUE_OPERATOR` organizations with scoped memberships
- Tenant-owned venues, active spaces, and immutable versioned published seat maps
- Organizer-owned persistent events with normalized organizer-scoped slugs and public composite slugs
- Separate event and session publication lifecycles with cancellation, archive, restore, and history preservation
- Append-only venue access grants controlled by venue-operator OWNER/ADMIN members
- UTC session instants displayed in each venue's IANA time zone
- Exact published seat-map binding that cannot be silently replaced after publication
- PostgreSQL overlap exclusion for non-cancelled sessions in one space; exact end/start boundaries are allowed
- Session price tiers stored as integer minor units in centrally supported currencies
- One section-level price assignment per session/map section, with sellable, priced, unpriced, and tier capacity summaries
- Atomic publication validation for access, ancestry, dates, capacity, pricing coverage, currency, and conflicts
- Per-session inventory materialized from the exact immutable published map, with blocked seats excluded
- Immutable integer-minor-unit price and currency snapshots on inventory rows and hold items
- Atomic all-or-nothing temporary holds with a ten-minute default TTL and eight-seat default maximum
- PostgreSQL row locking, conditional claims, bounded deadlock/serialization retries, and idempotent acquisition
- Manual release, lazy expired-seat reclamation, a bounded expiry sweeper, and release on session cancellation
- Transactional, identity-free inventory-event outbox records committed with every inventory mutation
- Concurrent `SKIP LOCKED` outbox dispatch with bounded retry, backoff, deduplication, and dead-letter state
- Redis Streams delivery used only as an invalidation transport, never as seat authority
- BullMQ repeat scheduling that invokes the existing PostgreSQL expiry sweeper in bounded batches
- Signed session-room Socket.IO subscriptions, reconnect refresh, duplicate/stale tolerance, and fallback polling
- Customer selection reconciliation plus aggregate-only organizer inventory refresh
- Protected operational health for Redis, outbox, dispatcher, expiry lag, conflicts, retries, and realtime clients
- Server-owned checkout totals copied from immutable hold/inventory snapshots, with bounded expiry and retry-safe idempotency
- A payment-provider boundary plus deterministic signed development/test provider that is impossible to enable in production
- Raw-body HMAC webhook verification, provider-event deduplication, amount/currency checks, and first-terminal-state protection
- Exact-once booking fulfillment that converts the hold, permanently marks inventory `BOOKED`, and writes booking/outbox records atomically
- Customer checkout status and booking history/detail pages plus organizer aggregate booking summaries
- Reconciliation, verified-webhook reprocessing, stale-checkout expiry, and paid-but-unfulfilled operational reporting
- Retry-safe one-ticket-per-booked-seat issuance with immutable ticket ancestry and hash-only credential persistence
- Versioned HMAC-derived QR credentials with rotation, terminal revocation, atomic first-use redemption, and append-only scan history
- Owner-only customer ticket pages, protected QR rendering, and short-lived, owner-bound, single-use booking PDF grants
- Server-rendered bounded PDFs with one ticket and QR per page and no remote asset fetches
- Transactional notification outbox delivery with deterministic local capture, provider idempotency, attempt history, backoff, and dead letters
- Mobile organizer scanning with camera support, manual fallback, strict tenant authorization, and honest online-only validation
- Ticket issuance, notification, scan-outcome, rotation, revocation, backlog, and protected health operations
- Coordinate-based customer seat selection, owner-safe hold details/countdowns, dashboard summaries, and aggregate organizer inventory counts
- Database-backed public catalogue, featured content, and true event-detail 404 behavior with no mock fallback
- Real organizer and venue-operator dashboard counts without invented booking, sales, or revenue data
- Guarded development/test database workflows and unit, component, and PostgreSQL integration tests

Phase 5B does **not** process refunds, chargebacks/disputes, coupons, waitlists, dynamic pricing, taxes/fees, split tender, raw card data, or sales analytics. The checked-in payment and notification providers are deterministic local development/test adapters and are rejected in production; reviewed external adapters remain deployment gates. Client redirects and Redis messages never authorize payment, ticket issuance, or entry.

## Main routes

| Route | Access and purpose |
| --- | --- |
| `/`, `/events`, `/events/[slug]` | Database-backed public discovery and read-only event/session detail |
| `/login`, `/register` | Better Auth identity flows |
| `/customer/dashboard` | Authenticated identity, membership, and own-hold summary |
| `/customer/holds/[holdToken]` | Owner-only active/released/expired hold detail and manual release |
| `/customer/checkouts/[orderReference]` | Owner-only checkout status; simulated payment controls exist only outside production |
| `/customer/bookings` | Authenticated customer's confirmed booking history |
| `/customer/bookings/[bookingReference]` | Owner-only booking, booked-seat, ticket, and booking-PDF actions |
| `/customer/tickets` | Authenticated customer's issued tickets |
| `/customer/tickets/[ticketReference]` | Owner-only ticket detail with protected QR and PDF action |
| `/events/[slug]/sessions/[sessionId]/seats` | Public availability preview; authenticated customers can select and hold seats |
| `/organizer/dashboard` | Organizer tenant selection and real Phase 3 counts |
| `/organizer/organizations/[organizationSlug]/events` | Organizer event list and management entry point |
| `.../events/new`, `.../events/[eventSlug]/edit` | Authorized draft event creation/editing |
| `.../events/[eventSlug]/sessions/new` | Session creation from approved venues and published maps |
| `.../sessions/[sessionId]` | Session lifecycle, pricing coverage, aggregate inventory, and bound-map preview |
| `.../sessions/[sessionId]/scanner` | Organizer OWNER/ADMIN mobile entry scanner for the bound session |
| `.../sessions/[sessionId]/pricing` | Draft tier and section-pricing configuration |
| `.../events/[eventSlug]/preview` | Organizer publication preview |
| `/organizer/organizations/[organizationSlug]/venues` | Approved venue/space/published-map information |
| `/venue-operator/dashboard` | Operator tenant selection and Phase 3 grant/session counts |
| `/venue-operator/organizations/[organizationSlug]/venues` | Tenant-scoped venue management |
| `.../venues/[venueSlug]/access` | Grant and revoke organizer venue access |
| `.../spaces/[spaceSlug]/seat-maps/[version]` | Draft editor or immutable map preview |
| `/admin` | Platform `ADMIN` only |
| `/api/auth/[...all]` | Better Auth handler |
| `/api/inventory/sessions/[sessionId]` | No-store authoritative customer snapshot plus a short-lived signed room ticket |
| `/api/inventory/sessions/[sessionId]/organizer` | Membership-protected aggregate inventory snapshot |
| `/api/operations/inventory/health` | Platform-admin-only non-sensitive Phase 4B health and metrics |
| `/api/payments/webhooks/[provider]` | Raw-body provider webhook ingress with signature verification before parsing/persistence |
| `/api/operations/payments/health` | Platform-admin-only non-sensitive Phase 5A health counts |
| `/api/tickets/[ticketReference]/qr` | Owner-only, no-store SVG credential QR |
| `/api/tickets/download/[token]` | Authenticated, owner-bound, single-use booking PDF download |
| `/api/tickets/validate` | Authenticated, rate-limited, tenant-authorized entry validation |
| `/api/operations/tickets/health` | Platform-admin-only non-sensitive issuance and delivery health counts |

## Local setup

Requirements: Node.js 22.12 or newer, npm, PostgreSQL, and a Redis 7+ compatible endpoint. Create separate development and test databases; integration commands reset only the test target.

```sql
CREATE DATABASE seatflow;
CREATE DATABASE seatflow_test;
```

```powershell
npm ci
Copy-Item .env.example .env
npm run db:migrate
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). `DIRECT_URL` may equal `DATABASE_URL` locally; hosted pooled connections should provide a direct migration URL. `SHADOW_DATABASE_URL` is optional and must never target an application database.

## Database and quality commands

```bash
npm run db:generate
npm run db:migrate
npm run db:migrate:deploy
npm run db:reset
npm run db:studio
npm run db:test:migrate
npm run db:test:reset
npm run holds:backfill
npm run holds:sweep
npm run inventory:dispatch
npm run inventory:dispatcher
npm run holds:schedule
npm run holds:worker
npm run realtime:gateway
npm run payments:reconcile
npm run payments:webhook:reprocess -- --event-id=<internal-webhook-id>
npm run payments:report
npm run checkouts:expire
npm run tickets:issue
npm run tickets:report
npm run tickets:retry -- --request-id=<internal-request-id>
npm run tickets:manage -- --action=rotate --ticket-reference=<reference> --actor-email=<email>
npm run notifications:dispatch
npm run notifications:retry
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:redis
npm run test:provider
npm run test:notification
npm run test:pdf
npm run build
```

`npm run test:integration` validates `TEST_DATABASE_URL`, refuses a shared or ambiguously named database, resets only that target, applies all committed migrations, and runs the serial PostgreSQL suite.

`npm run holds:backfill` additively materializes inventory for eligible sessions published before Phase 4A. It never resets data or invents pricing and refuses partial inconsistent inventory. `npm run holds:sweep -- --batch-size 100 --max-batches 10` expires overdue active holds in bounded, concurrency-safe batches. See the Phase 4A operations guide before running either command outside local development.

`npm run inventory:dispatch` processes one bounded outbox batch; `npm run inventory:dispatcher` runs continuously. `npm run holds:schedule` idempotently registers the BullMQ repeat schedule, `npm run holds:worker` consumes it, and `npm run realtime:gateway` serves signed session rooms. The manual expiry command remains supported. See the [Phase 4B operations guide](docs/phase-4b-operations.md) for rollout, health, Redis outage, and production process requirements.

`npm run payments:reconcile -- --limit=100` initializes or refreshes pending provider intents but deliberately cannot grant payment success. `npm run payments:webhook:reprocess` accepts only an internally stored, verified webhook ID. Use `npm run payments:report` for paid-unfulfilled/stale queues and `npm run checkouts:expire -- --batch-size=100 --max-batches=10` for bounded unpaid expiry. See the [Phase 5A operations guide](docs/phase-5a-operations.md) before deployment or incident recovery.

`npm run tickets:issue` processes one bounded issuance batch and is safe to repeat. `npm run notifications:dispatch` processes one bounded notification batch; `npm run notifications:retry` makes eligible pending failures immediately due. Management commands re-authorize the supplied actor and never print a credential. Use `npm run tickets:report` and the protected health route for backlogs. See the [Phase 5B operations guide](docs/phase-5b-operations.md) before rollout, secret rotation, or incident recovery.

## Administrator bootstrap

Registration cannot submit a platform role. Promote an existing account from a trusted terminal:

```bash
npm run admin:promote -- --email admin@example.com --confirm
```

## Project structure

```text
prisma/                       Schema and append-only migrations
scripts/                      Guarded database and administrator commands
src/app/                      App Router pages, auth handler, and Server Actions
src/components/               Shared UI and narrow client components
src/features/                 Zod contracts and pure domain rules
src/lib/                      Database/auth clients and request authorization
src/server/                   Testable authorization and application services
tests/                        Unit and component tests
tests/integration/            Dedicated PostgreSQL integration tests
docs/                         Product, architecture, security, operations, roadmap
```

See [product requirements](docs/product-requirements.md), [architecture](docs/architecture.md), [Phase 4A operations](docs/phase-4a-operations.md), [Phase 4B operations](docs/phase-4b-operations.md), [Phase 5A operations](docs/phase-5a-operations.md), [Phase 5B operations](docs/phase-5b-operations.md), [security](docs/security.md), and [roadmap](docs/roadmap.md).

## Phase 5C1 — production readiness

Phase 5C1 adds observability, abuse controls, health separation, backup
verification, load and outage testing, and a deployment gate.

**Production traffic is not enabled.** `npm run production:check` fails by
design until Phase 5C2 delivers reviewed external payment and notification
adapters.

### Commands

```bash
npm run production:check              # read-only deployment gate
npm run production:check -- --json
npm run production:check -- --skip-probes

npm run backup:create -- --out <directory outside the repo>
npm run backup:verify -- --file <dump> --target <disposable url> --confirm

npm run load:test -- --concurrency=8 --iterations=40
npm run chaos:verify
```

### Endpoints

| Route | Access |
| --- | --- |
| `GET /api/health/live` | public — process liveness, no dependency I/O |
| `GET /api/health/ready` | public status; per-check detail for platform ADMIN |
| `GET /api/operations/metrics` | platform ADMIN — bounded aggregate metrics |

### Guides

- [Production readiness](docs/phase-5c1-production-readiness.md)
- [Observability](docs/observability.md)
- [Deployment process matrix](docs/deployment-process-matrix.md)
- [Incident response runbooks](docs/incident-response.md)
- [Backup and restore](docs/backup-and-restore.md)
- [Load and outage testing](docs/load-testing.md)
- [Accessibility verification](docs/accessibility-verification.md)

### Local infrastructure

PostgreSQL and Redis run from durable local paths rather than `%TEMP%`, which a
Windows cleanup can delete. Start them before running the database-backed
suites; `PG_BIN_DIR` points the backup tooling at the PostgreSQL binaries.

## Phase 5C2A — refunds, disputes, and the financial ledger

Refunds, disputes, chargebacks, an append-only financial ledger, external
provider adapters, and the customer/organizer/admin financial interfaces.

**External providers are disabled by default.** Stripe and Resend adapters are
built on the official SDKs and are constructed only when explicitly selected
*and* fully configured, so a leftover credential cannot switch a deployment onto
a live payment network or start sending real email. `STRIPE_MODE` and
`RESEND_MODE` have no default — the mode must be stated, never inferred.

> **Verification status.** The Stripe and Resend adapters compile and are
> type-checked, but have **not** been verified against real sandbox
> credentials, which are absent from this environment. External sandbox suites
> are reported as *SKIPPED — credentials absent*. **No real-money charge and no
> real customer email has occurred.** Sandbox, staging, and launch are Phase
> 5C2B. See [docs/phase-5c2a-external-providers.md](docs/phase-5c2a-external-providers.md).

### Financial guarantees

- **Refunds never rewrite the original payment.** What the customer paid stays
  recorded; a refund adds new, independently auditable state.
- **Over-refunding is prevented by PostgreSQL**, via trigger-maintained
  aggregates whose row lock serializes concurrent refunds, plus a CHECK
  constraint. Sixteen simultaneous requests stay within the captured amount.
- **Only a verified provider webhook settles money.** Not a browser redirect,
  not a client response, not an organizer, not Redis.
- **The ledger is append-only.** A trigger rejects every UPDATE and DELETE.
- **Refunds never reopen inventory.** A refunded seat stays `BOOKED`; resale is
  a future controlled phase.
- **Used tickets stay used.** A scanned ticket keeps its redemption history and
  is never rewritten by a refund or a lost dispute.
- **Financial probes fail closed.** A probe that cannot be evaluated blocks the
  deployment gate rather than reporting a comforting zero.

### Financial operations

```bash
npm run financial:report                     # read-only aggregates
npm run refunds:reconcile -- all --dry-run   # what would be done
npm run refunds:reconcile -- ambiguous       # adopt provider-side refunds
npm run production:check                     # deployment gates
```

No command can settle a refund, fabricate a dispute, reopen inventory, or
rewrite financial history.

### Documentation

- [Refunds and disputes](docs/refunds-and-disputes.md)
- [Financial ledger](docs/financial-ledger.md)
- [Provider secret rotation](docs/provider-secret-rotation.md)
- [Refund reconciliation](docs/refund-reconciliation.md)
- [Phase 5C2A external providers](docs/phase-5c2a-external-providers.md)

### Browser verification

```bash
npm run test:browser
```

Runs against a production build (the dev server injects a hot-reload socket and
a dev-tools portal that make "no console errors" unverifiable) and against the
disposable test database — never the development one. Sessions are obtained by
signing in through the real login form; nothing forges a session.
