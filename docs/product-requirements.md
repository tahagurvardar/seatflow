# SeatFlow product requirements

## Purpose and identity

SeatFlow supports the journey from event discovery to a future verified digital ticket. Every authenticated user is a customer. Platform roles are `USER` and explicitly bootstrapped `ADMIN`; tenant capability comes independently from `OWNER`, `ADMIN`, or `MEMBER` memberships in `ORGANIZER` or `VENUE_OPERATOR` organizations.

## Phase 3 through Phase 4B delivered scope

- Organizer-owned persistent events in concert, cinema, theatre, sport, and other categories
- One or more concrete sessions stored as UTC instants and rendered in venue-local time
- Operator-controlled venue access grants; knowing a venue ID never grants scheduling access
- Exact immutable published seat-map bindings and historical reference protection
- Same-space overlap rejection with half-open time ranges: `[start, end)`
- Integer-minor-unit session tiers in `AZN`, `EUR`, `GBP`, and `USD`
- Section-level pricing and sellable/priced/unpriced capacity validation
- Separate event/session publication and honest database-backed public discovery
- Draft-only content, schedule, and pricing editing; controlled cancellation/archive/restore
- Real operational counts without fake sales or revenue metrics
- Authoritative per-session sellable inventory materialized when a session is published
- Immutable per-seat price/currency snapshots derived from section pricing, never from the customer
- Atomic multi-seat temporary holds with all-or-nothing conflict behavior
- Ten-minute default server-owned hold lifetime and eight-seat default maximum, both bounded configuration
- Request idempotency scoped to customer, session, key, and exact order-independent seat set
- Manual owner release, lazy expiry reclamation, bounded expiry sweeping, and cancellation release
- Coordinate-based seat selection, customer-safe availability states, hold details/countdowns, and organizer aggregate counts
- Transactional inventory invalidations for materialization, hold creation/release/expiry, and cancellation
- Redis Streams fan-out, BullMQ expiry automation, signed session rooms, reconnect refresh, and disconnected fallback
- Live customer selection reconciliation and aggregate-only organizer refresh without trusting notification payloads

OWNER and ADMIN members manage their authorized tenant resources. MEMBER users can inspect them but are read-only. All mutations re-authorize the current user and validate route context, nested ancestry, and lifecycle on the server.

## Public visibility contract

An event is public only when the event is `PUBLISHED` and has a future, non-cancelled session in `SCHEDULED`, `ON_SALE`, or `SALES_PAUSED`. The session must have passed publication validation: active venue/space, immutable published map, positive sellable capacity, complete section pricing, one supported currency, valid windows, and no overlap. The catalogue shows the earliest eligible session and lowest configured tier price. Empty databases show an honest empty state.

Seat selection is allowed only for a published event and an `ON_SALE` session, at or after `salesStartAt`, strictly before `salesEndAt`, and strictly before session start. Stored status alone never overrides server time. A public seat view reports another customer's held seat only as `UNAVAILABLE`; it exposes no customer identity, hold ID, or token. Phase 4A availability is request-time, not live synchronized.

## Lifecycle contract

- Event content is editable in `DRAFT`; event publication and session publication are separate.
- Session venue, space, map, times, and pricing are editable only in `DRAFT`.
- Publication freezes the session configuration. Repeated publication is safe and idempotent.
- Session cancellation and event cancellation preserve records; event cancellation cancels non-completed sessions.
- Publishing a session atomically materializes exactly one inventory row per active seat in each priced section.
- A hold begins `ACTIVE`, then terminates as `RELEASED` or `EXPIRED`; terminal holds and their items remain immutable history and cannot be revived.
- Only the authenticated owner can view or manually release a hold. Releasing or expiring returns every seat to `AVAILABLE` together.
- Cancelling a session releases all of its active holds before the cancellation transaction commits and rejects new acquisition.
- An event can archive from draft, published, or cancelled state, but only an archived draft or published event can restore.
- Only a securely authorized event with no sessions can be hard-deleted while still draft.
- Revoking a venue grant blocks new sessions and draft publication while preserving published history.

## Pricing and capacity

Prices never use floating point. A tier stores a non-negative integer number of minor currency units. Zero-price tiers are intentionally allowed for complimentary admission. Every sellable section needs one tier; blocked seats remain physical seats but do not count as sellable or priced capacity. Physical seat type (`STANDARD`, `ACCESSIBLE`, `COMPANION`, or `PREMIUM`) does not automatically choose a commercial tier.

`SessionSeatInventory` is the sellable capacity for one concrete session, not a mutable view of the seat map. Each row copies the published session tier's integer price and currency at materialization time. `SeatHoldItem` copies the inventory snapshot again when acquired. Client-supplied price, currency, expiry, ownership, or status is outside the hold contract and is ignored or rejected.

## Explicit Phase 4B exclusions

There is no booking, order, checkout, payment, payment webhook, ticket, QR code, email delivery, coupon, refund, sales analytics, waitlist, dynamic pricing, or per-seat override. Redis and Socket.IO deliver invalidations only; BullMQ invokes PostgreSQL expiry only. The countdown remains informational, and PostgreSQL plus server time decide expiry. Phase 5 begins checkout/payment/booking work.

## Product quality requirements

- Semantic, keyboard-accessible interfaces with visible focus and responsive layouts
- Server Components by default and narrow client islands where dependent input is needed
- Authorization inside every protected read and mutation, not only in navigation
- Central runtime validation, strict TypeScript, reproducible CI, and behavior-focused PostgreSQL tests
- Honest lifecycle and availability wording; incomplete capabilities never appear operational
