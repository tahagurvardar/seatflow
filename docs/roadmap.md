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

## Phase 4B — Availability delivery and operations (complete)

- PostgreSQL transactional outbox for every inventory mutation with bounded concurrent delivery
- Durable Redis Streams invalidations with atomic event deduplication and environment-scoped keys
- BullMQ repeat scheduling of the existing idempotent `SKIP LOCKED` PostgreSQL expiry sweep
- Signed session-scoped Socket.IO rooms with strict safe payloads and connection limits
- Authoritative refresh on invalidation/reconnect plus focus and low-frequency disconnected fallback
- Customer selection reconciliation, aggregate-only organizer refresh, and protected operational health
- PostgreSQL concurrency regression plus real Redis reconnect, isolation, outage/recovery, and multi-worker tests

Phase 4B deliberately leaves every allocation decision in PostgreSQL and implements no booking, checkout, payment, order, ticket, QR code, refund, coupon, email, waitlist, dynamic pricing, or sales analytics.

## Phase 5A — Checkout, payments, and bookings (complete)

- Checkout creation that consumes the immutable Phase 4A hold/item price snapshots
- Provider boundary and a deterministic signed development/test provider with a production deployment gate
- Precommitted provider idempotency, exact-raw-body signature verification, and duplicate/concurrent webhook safety
- Exact-once confirmed booking fulfillment, permanent booked inventory, and converted hold history
- Customer checkout/booking pages and aggregate organizer booking summaries
- Reconciliation, verified-webhook reprocessing, stale-checkout expiry, paid-unfulfilled reporting, and Redis-outage recovery

## Phase 5B — Tickets and post-payment lifecycle

**Status: complete.**

- Durable one-ticket-per-booked-seat issuance with independent retry and backlog operations
- Opaque hash-only QR credentials with linked rotation, terminal revocation, and immutable audit history
- Owner-only ticket/QR views plus short-lived, owner-bound, single-use PDF grants
- Online session-bound entry scanning with tenant authorization and atomic first-use redemption
- Transactional notification outbox, provider idempotency, deterministic local capture, retries, and dead letters
- Protected operational health plus issuance, delivery, scan-outcome, rotation, and revocation commands

## Phase 6 — Operations and scale

- Reviewed production payment and notification adapters with credential rotation/runbooks
- Refund, cancellation, chargeback, and dispute workflows that preserve booked-seat and ticket history
- Distributed scan abuse controls, fleet/device identity, and offline-policy product decisions
- Delivery/issuance dashboards, structured observability, alerting, and customer-support tools
- End-to-end accessibility, load, resilience, backup/restore, and incident-response verification

This recommended next phase is not started in the current repository.

## Phase 5C1 — production hardening (complete, traffic still gated)

Delivered: structured redacted logging, request/operation correlation, separated
liveness/readiness/protected metrics, durable worker heartbeats with stale
detection, Redis-backed distributed rate limiting with declared failure modes,
an explicit trusted-proxy model, a production security-header policy,
`npm run production:check`, non-destructive backup and guarded restore
verification, a correctness-asserting load harness, controlled outage/chaos
verification, and an honest accessibility audit.

One additive migration (`20260719000000_phase_5c1_worker_heartbeats`).

**Production traffic remains disabled.** `npm run production:check` fails by
design on two gates: no reviewed external payment adapter and no reviewed
external notification adapter exist in this build.

## Phase 5C2 — external providers (next)

1. External payment adapter: raw-body signature verification preserved,
   contract tests mirroring the local signed provider, secret rotation with an
   overlap window, and a webhook endpoint review.
2. External notification adapter: bounded template context, provider
   idempotency, and delivery-status mapping onto the existing outbox.
3. Refunds and disputes: a new append-only ledger rather than mutation of
   existing payment rows; inventory release policy decided explicitly.
4. Re-run every Phase 5C1 gate with the adapters installed, then remove the two
   deployment gates from `production-check.ts`.
