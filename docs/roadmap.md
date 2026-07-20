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

**Production traffic remains disabled.** At the close of 5C1 `production:check`
failed by design on two gates: no reviewed external payment adapter and no
reviewed external notification adapter existed in this build. Phase 5C2A
replaced both gates with real adapters plus explicit credential, mode, and
webhook-coverage checks; traffic is still disabled because those credentials do
not exist here.

## Phase 5C2A — external adapters, refunds, disputes, ledger (complete, unverified against real providers)

Delivered: provider-neutral payment and notification boundaries; Stripe and
Resend adapters built on the official SDKs and disabled unless explicitly
selected; webhook secret rotation with a window that closes by itself; refund
requests with server-calculated amounts; refund submission that holds no
database lock across the provider call; exact-once refund settlement from
verified webhooks only; an append-only financial ledger; the dispute and
chargeback lifecycle; deliberate ticket-revocation consequences that never
reopen inventory; live fail-closed financial probes; reconciliation CLI
commands; and customer, organizer, and platform-admin financial UI.

One additive migration
(`20260719120000_phase_5c2a_refunds_disputes_ledger`).

**Stripe and Resend have not been verified against real sandbox credentials.**
Both adapters compile and are type-checked; neither has made a real call. No
real-money charge and no real customer email has occurred at any point. See
[phase-5c2a-external-providers.md](phase-5c2a-external-providers.md) for the
verification-status table.

`npm run production:check` fails by design in the local configuration. Against a
sanitized production-like configuration with synthetic placeholders it reports
no findings, which validates that the configuration rules are satisfiable — not
that any provider has been verified.

## Phase 5C2B — sandbox verification and launch (next)

1. Real Stripe test-mode verification: payment intent, partial and full refund,
   refund webhook settlement, dispute events, and secret rotation against a real
   test account.
2. Real Resend verification against an approved internal test recipient only.
3. Authenticated end-to-end browser coverage: the current Playwright suite
   verifies authorization boundaries, layout, and leak-safety, but does not yet
   drive a signed-in customer through a refund, because no Better Auth session
   seed helper exists.
4. Staging deployment, live-traffic runbook rehearsal, and the launch decision.
