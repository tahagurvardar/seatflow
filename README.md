# SeatFlow

SeatFlow is a production-oriented event-ticketing portfolio project. The repository now contains **Phase 3: persistent events, sessions, venue access, and section pricing**, built on the Phase 0 discovery, Phase 1 identity, and Phase 2 venue/seat-map foundations.

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
- Database-backed public catalogue, featured content, and true event-detail 404 behavior with no mock fallback
- Real organizer and venue-operator dashboard counts without invented booking, sales, or revenue data
- Guarded development/test database workflows and unit, component, and PostgreSQL integration tests

Phase 3 does **not** implement inventory, seat holds, Redis, WebSockets, bookings, orders, checkout, payments, tickets, QR codes, refunds, coupons, dynamic pricing, waitlists, email, or sales analytics.

## Main routes

| Route | Access and purpose |
| --- | --- |
| `/`, `/events`, `/events/[slug]` | Database-backed public discovery and read-only event/session detail |
| `/login`, `/register` | Better Auth identity flows |
| `/customer/dashboard` | Authenticated identity and membership summary |
| `/organizer/dashboard` | Organizer tenant selection and real Phase 3 counts |
| `/organizer/organizations/[organizationSlug]/events` | Organizer event list and management entry point |
| `.../events/new`, `.../events/[eventSlug]/edit` | Authorized draft event creation/editing |
| `.../events/[eventSlug]/sessions/new` | Session creation from approved venues and published maps |
| `.../sessions/[sessionId]` | Session lifecycle, coverage, and bound-map preview |
| `.../sessions/[sessionId]/pricing` | Draft tier and section-pricing configuration |
| `.../events/[eventSlug]/preview` | Organizer publication preview |
| `/organizer/organizations/[organizationSlug]/venues` | Approved venue/space/published-map information |
| `/venue-operator/dashboard` | Operator tenant selection and Phase 3 grant/session counts |
| `/venue-operator/organizations/[organizationSlug]/venues` | Tenant-scoped venue management |
| `.../venues/[venueSlug]/access` | Grant and revoke organizer venue access |
| `.../spaces/[spaceSlug]/seat-maps/[version]` | Draft editor or immutable map preview |
| `/admin` | Platform `ADMIN` only |
| `/api/auth/[...all]` | Better Auth handler |

## Local setup

Requirements: Node.js 22.12 or newer, npm, and PostgreSQL. Create separate development and test databases; the integration command resets its target.

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
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
```

`npm run test:integration` validates `TEST_DATABASE_URL`, refuses a shared or ambiguously named database, resets only that target, applies all committed migrations, and runs the serial PostgreSQL suite.

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

See [product requirements](docs/product-requirements.md), [architecture](docs/architecture.md), [Phase 3 operations](docs/phase-3-operations.md), [security](docs/security.md), and [roadmap](docs/roadmap.md).
