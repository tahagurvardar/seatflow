# SeatFlow product requirements

## Purpose and identity

SeatFlow supports the journey from event discovery to a future verified digital ticket. Every authenticated user is a customer. Platform roles are `USER` and explicitly bootstrapped `ADMIN`; tenant capability comes independently from `OWNER`, `ADMIN`, or `MEMBER` memberships in `ORGANIZER` or `VENUE_OPERATOR` organizations.

## Phase 3 delivered scope

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

OWNER and ADMIN members manage their authorized tenant resources. MEMBER users can inspect them but are read-only. All mutations re-authorize the current user and validate route context, nested ancestry, and lifecycle on the server.

## Public visibility contract

An event is public only when the event is `PUBLISHED` and has a future, non-cancelled session in `SCHEDULED`, `ON_SALE`, or `SALES_PAUSED`. The session must have passed publication validation: active venue/space, immutable published map, positive sellable capacity, complete section pricing, one supported currency, valid windows, and no overlap. The catalogue shows the earliest eligible session and lowest configured tier price. Empty databases show an honest empty state.

## Lifecycle contract

- Event content is editable in `DRAFT`; event publication and session publication are separate.
- Session venue, space, map, times, and pricing are editable only in `DRAFT`.
- Publication freezes the session configuration. Repeated publication is safe and idempotent.
- Session cancellation and event cancellation preserve records; event cancellation cancels non-completed sessions.
- An event can archive from draft, published, or cancelled state, but only an archived draft or published event can restore.
- Only a securely authorized event with no sessions can be hard-deleted while still draft.
- Revoking a venue grant blocks new sessions and draft publication while preserving published history.

## Pricing and capacity

Prices never use floating point. A tier stores a non-negative integer number of minor currency units. Zero-price tiers are intentionally allowed for complimentary admission. Every sellable section needs one tier; blocked seats remain physical seats but do not count as sellable or priced capacity. Physical seat type (`STANDARD`, `ACCESSIBLE`, `COMPANION`, or `PREMIUM`) does not automatically choose a commercial tier.

## Explicit Phase 3 exclusions

There is no session inventory, seat availability, hold, reservation timer, Redis, WebSocket, booking, order, checkout, payment, webhook, ticket, QR code, email delivery, coupon, refund, sales analytics, waitlist, dynamic pricing, or per-seat price override. Public calls to action accurately state that booking starts in Phase 4 or later.

## Product quality requirements

- Semantic, keyboard-accessible interfaces with visible focus and responsive layouts
- Server Components by default and narrow client islands where dependent input is needed
- Authorization inside every protected read and mutation, not only in navigation
- Central runtime validation, strict TypeScript, reproducible CI, and behavior-focused PostgreSQL tests
- Honest lifecycle and availability wording; incomplete capabilities never appear operational
