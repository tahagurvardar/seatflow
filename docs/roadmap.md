# SeatFlow roadmap

## Phase 0 — Foundation (complete)

- Public landing, catalogue, event details, responsive design system, and navigation
- Central product configuration and strict domain types
- Validated mock events with stable local artwork
- Unit/component tests, CI, and product documentation

## Phase 1 — Identity and organizational boundaries (complete)

- Better Auth email/password identity and PostgreSQL-backed sessions
- Prisma schema and migration for Better Auth core records, organizations, and memberships
- `USER`/`ADMIN` platform roles separated from tenant membership roles
- Server-enforced customer, organizer, onboarding, and admin routes
- Atomic organization plus OWNER onboarding
- Server-aware navigation, explicit administrator bootstrap, and environment guards
- Dedicated PostgreSQL integration tests and CI service

Phase 1 intentionally stopped before venue, event, inventory, hold, payment, booking, ticket, and analytics persistence.

## Phase 2 — Venue management and versioned seat maps (complete)

- Venue-operator onboarding and tenant dashboard
- Venue and space CRUD with archive/restore lifecycles
- Section, row, and seat modeling with types, states, coordinates, ordering, and hard limits
- Reusable versioned seat-map editor, capacity summaries, and accessible read-only renderer
- Atomic publication, immutable snapshots, one current version, and deep clone-to-draft
- PostgreSQL constraints, triggers, and lifecycle integration tests

Phase 2 intentionally stopped before persisted events/sessions, pricing, inventory, holds, bookings, real-time availability, payments, tickets, scanning, and analytics.

## Phase 3 — Events, sessions, venue access, and pricing (complete)

- Persisted organizer events and UTC session schedules with venue-local display
- Operator-approved venue grants with safe revocation and multi-tenant authorization
- Exact immutable published seat-map binding and PostgreSQL overlap exclusion
- Integer-minor-unit price tiers, section assignments, and capacity coverage
- Separate event/session publication, cancellation/archive history, and database-backed public discovery
- Real organizer/operator dashboard counts without simulated bookings or revenue

Phase 3 deliberately has configured capacity rather than session inventory. It contains no holds, availability engine, Redis, WebSockets, bookings, checkout, payments, tickets, or analytics.

## Phase 4A — PostgreSQL inventory and temporary holds (complete)

- PostgreSQL-authoritative per-session inventory derived from the immutable map binding and section pricing
- Immutable integer-minor-unit price/currency snapshots on inventory and hold items
- Atomic all-or-nothing multi-seat holds with a ten-minute default TTL and eight-seat default maximum
- Deterministic row locks, guarded claims, bounded transaction retries, and exact-seat-set idempotency
- Manual owner release, lazy expiry reclamation, bounded `SKIP LOCKED` sweeps, and session-cancellation release
- Coordinate-based customer selection, owner hold details/countdowns/dashboard, and organizer aggregate inventory
- Boundary, component, security, invariant, race-condition, and recovery tests

Phase 4A deliberately keeps PostgreSQL as the sole source of truth. It has no Redis, BullMQ, WebSockets, Socket.IO, live seat delivery, booking, checkout, payment, ticket, or automatic worker scheduling.

## Phase 4B — Availability delivery and operations (planned)

- Define Redis as a disposable projection/cache only after failure-mode and reconciliation design; PostgreSQL remains authoritative
- Schedule durable execution of the existing idempotent expiry sweep with leaderless/concurrent-worker safety
- Add real-time availability fan-out with session-scoped channels, authorization, reconnect, and snapshot/version recovery
- Use a transactional outbox or equivalent post-commit publication so no database state change is lost
- Measure hold conflicts, sweeper lag, expired-row recovery, projection drift, and reconnect load
- Prove load, failover, replay, cache-loss, and stale-client behavior before operational rollout

## Phase 5 — Checkout, payments, bookings, and tickets

- Checkout creation that consumes the immutable Phase 4A hold/item price snapshots
- Payment provider integration and signed idempotent webhooks
- Booking state machine and refund/cancellation foundations
- QR-coded digital tickets and secure ticket retrieval
- Reconciliation and failure recovery

## Phase 6 — Operations and scale

- Organizer reporting, venue operations, and entry scanning
- Notifications, customer support, and admin workflows
- Observability, rate limiting, abuse prevention, and incident playbooks
- Performance and accessibility hardening under realistic inventory load
