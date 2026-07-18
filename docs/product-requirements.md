# SeatFlow product requirements

## Purpose and identity

SeatFlow supports the journey from event discovery through verified digital entry. Every authenticated user is a customer. Platform roles are `USER` and explicitly bootstrapped `ADMIN`; tenant capability comes independently from `OWNER`, `ADMIN`, or `MEMBER` memberships in `ORGANIZER` or `VENUE_OPERATOR` organizations.

## Phase 3 through Phase 5B delivered scope

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
- Authenticated checkout derived only from an owned, live hold and its immutable price snapshots
- Integer-minor-unit order totals and immutable order-item ancestry; no client financial fields
- Retry-safe provider-intent creation with a precommitted idempotency key and no database transaction held across provider I/O
- Exact-raw-body signed webhook verification as the only authority for payment success
- Exact-once booking creation, permanent booked inventory, converted hold history, and atomic booking invalidations
- Customer checkout/booking views and aggregate-only organizer booking summaries
- Operational queues for stale checkouts, verified webhook reprocessing, reconciliation, and paid-but-unfulfilled review
- Durable issuance requests created with confirmed bookings, with exact one ticket per booked seat and retry-safe recovery
- Opaque versioned QR credentials derived from a dedicated secret while only keyed hashes are persisted
- Customer-owned ticket list/detail, protected QR retrieval, and short-lived single-use booking PDF grants
- Organizer/authorized venue entry validation with session binding, database time, rate limits, idempotency, and atomic first use
- Credential rotation, terminal revocation, immutable audit/redemption history, and stale-credential rejection
- Transactional notification outbox, deterministic local capture, bounded retries, delivery attempts, and dead letters

OWNER and ADMIN members manage their authorized tenant resources. MEMBER users can inspect them but are read-only. All mutations re-authorize the current user and validate route context, nested ancestry, and lifecycle on the server.

## Public visibility contract

An event is public only when the event is `PUBLISHED` and has a future, non-cancelled session in `SCHEDULED`, `ON_SALE`, or `SALES_PAUSED`. The session must have passed publication validation: active venue/space, immutable published map, positive sellable capacity, complete section pricing, one supported currency, valid windows, and no overlap. The catalogue shows the earliest eligible session and lowest configured tier price. Empty databases show an honest empty state.

Seat selection is allowed only for a published event and an `ON_SALE` session, at or after `salesStartAt`, strictly before `salesEndAt`, and strictly before session start. Stored status alone never overrides server time. A public seat view reports another customer's held or booked seat only as `UNAVAILABLE`; it exposes no customer identity, hold ID, booking ID, or token.

## Lifecycle contract

- Event content is editable in `DRAFT`; event publication and session publication are separate.
- Session venue, space, map, times, and pricing are editable only in `DRAFT`.
- Publication freezes the session configuration. Repeated publication is safe and idempotent.
- Session cancellation and event cancellation preserve records; event cancellation cancels non-completed sessions.
- Publishing a session atomically materializes exactly one inventory row per active seat in each priced section.
- A hold begins `ACTIVE`, then terminates as `RELEASED`, `EXPIRED`, or `CONVERTED`; terminal holds and their items remain immutable history and cannot be revived.
- Only the authenticated owner can view or manually release a hold. Releasing or expiring returns every seat to `AVAILABLE` together.
- Checkout begins `PENDING`, advances to `PAYMENT_PENDING`, and can finish as `FULFILLED`, `PAYMENT_FAILED`, `EXPIRED`, or a protected paid/review state. A success redirect is never a lifecycle transition.
- A cryptographically verified success webhook creates exactly one `CONFIRMED` booking, copies exactly the ordered seats, changes inventory to permanent `BOOKED`, and converts the corresponding hold in one PostgreSQL transaction.
- A verified success that cannot be safely fulfilled records paid-but-unfulfilled/review state for operators and never invents a booking or releases the seats as though payment had failed.
- Booking fulfillment enqueues a durable issuance request in the booking transaction. Ticket issuance failure cannot undo a confirmed booking and is retried independently.
- Every booked seat receives at most one ticket. A ticket begins `ACTIVE` and may terminate as `USED` after the first accepted scan or `REVOKED`; neither terminal state can be revived.
- A credential begins `ACTIVE` and may terminate as `USED`, `REVOKED`, or `REPLACED`. Rotation creates a newer active version and preserves the linked predecessor.
- A download grant is owner-bound, short-lived, single-use, and stores only a keyed token hash. PDF generation must succeed before consumption commits.
- Cancelling a session releases all of its active holds before the cancellation transaction commits and rejects new acquisition.
- An event can archive from draft, published, or cancelled state, but only an archived draft or published event can restore.
- Only a securely authorized event with no sessions can be hard-deleted while still draft.
- Revoking a venue grant blocks new sessions and draft publication while preserving published history.

## Pricing and capacity

Prices never use floating point. A tier stores a non-negative integer number of minor currency units. Zero-price tiers are intentionally allowed for complimentary admission. Every sellable section needs one tier; blocked seats remain physical seats but do not count as sellable or priced capacity. Physical seat type (`STANDARD`, `ACCESSIBLE`, `COMPANION`, or `PREMIUM`) does not automatically choose a commercial tier.

`SessionSeatInventory` is the sellable capacity for one concrete session, not a mutable view of the seat map. Each row copies the published session tier's integer price and currency at materialization time. `SeatHoldItem` and then `CheckoutOrderItem` copy that trusted snapshot. The server calculates subtotal/total in integer minor units and requires one currency. Client-supplied price, total, currency, expiry, ownership, payment status, or booking status is outside the contract and is rejected.

## Payment and fulfillment authority

The browser may start checkout and follow a provider/test flow, but cannot assert payment success. Provider intent creation and reconciliation may observe provider state but cannot create a booking. Only a signature-verified webhook over the exact raw request body can authorize success, and the database rechecks provider intent, amount, currency, order, hold, session, inventory, and lifecycle while holding deterministic row locks. Duplicate or concurrent events remain exact once.

Redis and Socket.IO remain invalidation transport only. Redis unavailability may delay outbox delivery but cannot roll back or duplicate PostgreSQL payment fulfillment.

## Ticket and delivery authority

Only a stored `CONFIRMED` booking and its immutable booked-seat ancestry can create tickets. Ticket plaintext is deterministically re-derived only inside protected QR/PDF rendering; PostgreSQL stores a keyed hash, version, lifecycle, and audit history. Possession of a public ticket reference is never authorization.

Entry validation is online and PostgreSQL-authoritative. The scanner must be authorized for the target session before credential lookup. The server locks the credential and ticket, verifies the exact session and entry window using database time, writes one append-only redemption outcome, and atomically changes the first valid ticket/credential to `USED`. Offline acceptance is not supported or implied.

Notification delivery is downstream of issuance. Provider timeout or permanent failure cannot invalidate tickets. Email contains event/session/seat context and a short-lived authenticated download link, never a reusable QR credential. A local file provider exists only for deterministic development/test capture; production requires a reviewed external adapter.

## Explicit Phase 5B exclusions

There is no refund execution, chargeback/dispute workflow, coupon, waitlist, dynamic pricing, per-seat override, tax/fee engine, split tender, raw-card collection, sales analytics, or checked-in production external payment/notification adapter. Session cancellation preserves ticket and booking history; it does not silently refund or release booked inventory.

## Product quality requirements

- Semantic, keyboard-accessible interfaces with visible focus and responsive layouts
- Server Components by default and narrow client islands where dependent input is needed
- Authorization inside every protected read and mutation, not only in navigation
- Central runtime validation, strict TypeScript, reproducible CI, and behavior-focused PostgreSQL tests
- Honest lifecycle and availability wording; incomplete capabilities never appear operational
