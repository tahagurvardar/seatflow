# SeatFlow product requirements

## Purpose

SeatFlow is an event-ticketing product focused on the journey from discovery to a verified digital ticket. It should make complex seat inventory feel calm and understandable while giving operators dependable control over events, sessions, venues, and sales.

## Identity and audience model

Every authenticated user is a **customer**. Customer capability is not an exclusive role and cannot be lost by joining an organization.

Platform roles are intentionally limited to:

- `USER` — the default for every registration
- `ADMIN` — an explicitly bootstrapped platform-governance privilege

Tenant capability is independent from platform role. Users can hold multiple memberships in organizations of kind `ORGANIZER` or `VENUE_OPERATOR`. Each membership has one scoped role: `OWNER`, `ADMIN`, or `MEMBER`.

## Event scope

In scope for the eventual v1: concerts, cinema screenings, theatre performances, and sporting events.

Out of scope: transportation ticketing, travel inventory, route planning, and vehicle seat reservations.

## Phase 2 scope

Phase 2 delivers:

- PostgreSQL schema, migration history, and guarded development/test workflows
- Better Auth email/password accounts and database-backed server sessions
- server-owned platform roles and centralized authorization helpers
- multi-organization membership modeling and minimum-role enforcement
- protected customer, organizer, onboarding, and admin experiences
- atomic organizer/OWNER onboarding with normalized unique slugs
- real identity, membership, and platform-count displays
- security-focused integration testing with a dedicated database
- venue-operator onboarding with an explicit `VENUE_OPERATOR` organization
- tenant-scoped venues and spaces with archive/restore lifecycles
- versioned draft seat maps with sections, rows, seats, bulk generation, reordering, types, states, and coordinates
- capacity summaries and a reusable coordinate-positioned read-only renderer
- validated, atomic publication with immutable history and one current published version per space
- atomic deep cloning from the current published version into the next server-assigned draft

Phase 2 preserves the Phase 0 public information architecture and fixture catalogue. It does not pretend that persisted events, sessions, bookings, or ticket inventory exist.

## Explicit Phase 2 exclusions

Do not add persisted events or sessions, session inventory, pricing, holds, Redis, WebSockets, checkout, payments, bookings, coupons, refunds, QR tickets, scanning, email, analytics, or entry-control workflows during this phase.

## Planned booking lifecycle

1. A customer opens a published event.
2. The customer chooses a concrete event session.
3. The platform loads the seat map and current session inventory.
4. The customer selects seats and requests a temporary hold.
5. The server validates inventory and creates an expiring hold atomically.
6. Checkout is created from the authoritative hold and price snapshot.
7. A verified payment webhook confirms the booking idempotently.
8. The platform converts held inventory to sold inventory and issues digital tickets.
9. Customers retrieve tickets and authorized operators validate them at entry.

## Product quality requirements

- Semantic, keyboard-accessible interfaces with visible focus states and sufficient contrast
- Honest lifecycle language; unfinished capabilities never appear operational
- Server Components by default and narrow client islands for necessary interaction
- Authorization inside every server mutation and tenant-scoped data read
- Strict TypeScript, validated boundaries, no exposed secrets, reproducible CI, and meaningful behavior tests
