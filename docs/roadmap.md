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

## Phase 4 — Holds and real-time availability

- Authoritative per-session seat inventory derived from the immutable map binding
- Atomic temporary holds with explicit expiry
- Redis or equivalent short-lived coordination after failure-mode design
- Real-time session availability projections
- Idempotent expiry workers and reconnection behavior
- Load, race-condition, and recovery tests

## Phase 5 — Checkout, payments, bookings, and tickets

- Authoritative price snapshots and checkout creation
- Payment provider integration and signed idempotent webhooks
- Booking state machine and refund/cancellation foundations
- QR-coded digital tickets and secure ticket retrieval
- Reconciliation and failure recovery

## Phase 6 — Operations and scale

- Organizer reporting, venue operations, and entry scanning
- Notifications, customer support, and admin workflows
- Observability, rate limiting, abuse prevention, and incident playbooks
- Performance and accessibility hardening under realistic inventory load
