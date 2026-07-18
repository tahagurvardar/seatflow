# SeatFlow Phase 5A security contract

## Trust boundaries

- A valid Better Auth session proves identity, not platform or tenant permission.
- Registration cannot set `platformRole`; administrator promotion remains a confirmed trusted-terminal operation.
- Every protected read and Server Action re-resolves the current user, tenant kind, tenant identity, and minimum membership role from PostgreSQL.
- Organizer IDs are not accepted from event forms. Ownership is derived from the authorized organization slug.
- Route params, bound action arguments, hidden fields, selected venue/space/map IDs, tier IDs, section IDs, and stale forms are untrusted.
- Organizer OWNER/ADMIN can mutate authorized event resources; organizer MEMBER is read-only.
- Venue-operator OWNER/ADMIN can grant or revoke access for their owned venue; operator MEMBER is read-only. Organizer membership cannot self-approve venue access.
- Public queries expose only deliberately published content and the venue/space/map information needed for discovery.
- Anonymous customers may preview availability but cannot create or manage holds.
- Hold actions derive the customer ID from the authenticated Better Auth session. A form cannot nominate another user.
- Session IDs, physical-seat IDs, idempotency keys, and public hold tokens are untrusted. Price, currency, expiry, status, and ownership are not accepted from the client contract.
- A hold token is a 32-byte CSPRNG value encoded as URL-safe base64. Detail and release queries still require the matching authenticated owner, and unknown/cross-user tokens return the same not-found-style result.
- Another customer's held seat is exposed only as `UNAVAILABLE`; no customer ID, internal hold ID, expiry, or public token is included.
- Checkout actions accept only an owned hold token and idempotency key. Price, currency, total, user ID, provider status, order status, and booking state are server/database owned.
- A client redirect, query parameter, provider-create response, reconciliation response, Redis message, or browser callback is never payment authority. Only a cryptographically verified provider webhook can authorize success.
- Customer checkout and booking reads require both an authenticated user and matching ownership; public references are not bearer credentials.

Better Auth stores HTTP-only PostgreSQL sessions using the `seatflow` cookie prefix. Production enables secure cookies; origin and CSRF protections remain enabled.

## Defense in depth

Application services validate full ancestry and lifecycle inside transactions. PostgreSQL additionally enforces:

- organizer/event and operator/venue organization kinds
- organizer-scoped event slugs and globally stable public slugs
- one active grant per organizer/venue and append-only grant history
- venue/space/map ancestry, active parents, published map status, and grant presence for draft creation/publication
- immutable published session references, times, pricing, and section assignments
- same-session tiers, same-map sections, one assignment per session/section, non-negative prices, and lifecycle timestamps
- same-space non-overlap for non-cancelled session ranges
- restrictive deletion of referenced seat maps and other historical parents
- one inventory row per session/seat, faithful seat/map/section/tier ancestry, and immutable integer price/currency snapshots
- consistent `AVAILABLE`/`HELD` linkage, same-session current holds, and non-negative prices
- one active hold per customer/session, bounded idempotency keys, unguessable token length, and legal terminal timestamps
- immutable hold identity/items, no revival of released/expired holds, and permanent inventory/hold history
- immutable checkout/order-item financial snapshots, exact ancestry, integer totals, one currency, and legal lifecycle timestamps
- unique provider event identity, stable provider idempotency, first-terminal payment behavior, and immutable normalized webhook observations
- one booking per order, one booking seat per inventory row, one physical seat per session, and deferred exact order-to-booking fulfillment
- `BOOKED` inventory only after its booking seat exists, no transition out of `BOOKED`, and exact hold conversion

Repeated publish/revoke requests are safe. Unique/exclusion races are mapped to domain errors where practical and cannot leave partially published configuration.

## Hold acquisition and release

Every acquisition rechecks event/session status, sales-window boundaries, session start, inventory presence, and every requested physical-seat ID using server time. Cross-session inventory mixing, blocked seats, unknown inventory, duplicate seats, and over-limit selections are rejected. Deterministic row locks and a guarded `AVAILABLE` update make a multi-seat request atomic; a conflict rolls back the hold and every selected row.

Idempotency is scoped by session, authenticated user, and bounded client key. A retry returns the original hold only when the exact order-independent seat set matches; a different payload is a conflict. No client-supplied price, total, currency, TTL, status, hold ID, or user ID influences persistence.

Only the hold owner may release. Session organizers and venue operators do not gain customer-hold release rights from tenant membership. Cancellation is the explicit exception: the session lifecycle transaction releases every active hold for that session, preserves hold items, and prevents a concurrent acquisition from slipping past cancellation.

## Venue access revocation

Revocation closes the grant and prevents new sessions and draft-session publication. It deliberately does not cancel, delete, or retarget an already published session. Operators may see limited upcoming configured-session counts for owned venues but cannot edit organizer event content.

## Data deletion and history

Only a draft event with no sessions can be hard-deleted by an authorized organizer manager. Cancellation and archive preserve events, sessions, map references, and pricing. Published map snapshots cannot be deleted. Deleting a user may null historical grant actor fields but cannot erase the grant record.

## Test database safety

Integration commands require `TEST_DATABASE_URL`. The name must visibly contain `test`, it must differ from development/runtime URLs, and only that validated target is reset. Tests apply the complete append-only migration chain.

## Phase 4B event and realtime boundaries

- PostgreSQL writes the inventory mutation and outbox event atomically. Redis is never queried to decide whether a seat is available or who owns a hold.
- Outbox payloads contain session ID, event ID/type, and server timestamp only; customer email/ID, hold public token, auth state, and private tenant data are forbidden and size-bounded.
- Redis keys come only from validated environment prefixes and server event IDs. Public room/session input cannot enumerate or construct Redis keys.
- Redis Stream publication atomically deduplicates before append. PostgreSQL is marked processed only after delivery, so crash retries are safe.
- Gateway subscriptions require a short-lived HMAC ticket signed after public-session visibility or organizer membership authorization. The ticket binds one validated session and carries no identity.
- The gateway accepts no client inventory mutation, enforces browser origin and per-address connection bounds, and validates every Redis entry before broadcasting.
- Browsers reject cross-session, duplicate, malformed, and stale events. A valid event triggers a PostgreSQL snapshot reload; it never changes availability directly.
- Snapshot endpoints are no-store, input-validated, rate-limited, and re-authorize organizer scope on every request.
- Redis outage moves clients to focus plus 30-second fallback refresh. Hold acquisition, release, expiry, cancellation, and conflict behavior remain PostgreSQL-correct.

The platform-admin health endpoint returns only counts, durations, ages, and connectivity booleans. It never returns URLs, credentials, tokens, payload bodies, customer data, or stack traces.

## Phase 5A checkout and payment boundaries

The checkout service locks and reloads the hold and inventory, validates authenticated ownership, live eligibility, session ancestry, and exact immutable amounts, then commits the order and payment-attempt idempotency key before provider I/O. Provider timeouts cannot hold database locks or create a second order/attempt; retry uses the stored key. No endpoint accepts raw card, CVV, bank, or payment-method data.

The webhook endpoint bounds `Content-Length` before reading and bounds the actual byte body afterward. It verifies the signature over the exact raw bytes before parsing or persisting normalized data. The local provider uses HMAC-SHA256 and Node's constant-time digest comparison, accepts only a strict timestamp/signature grammar, and is constructor- and configuration-gated out of production. Webhook secrets belong only in the deployment secret manager and must be rotated independently of Better Auth and Redis secrets.

Verified webhook fulfillment re-locks every authoritative record and verifies provider, intent, amount, currency, ownership, session, hold, and ordered inventory. Duplicate deliveries are identified by `(provider, providerEventId)`; concurrent distinct success events converge through row locks and database uniqueness. Failure or contradictory terminal events cannot overwrite an already accepted success. A mismatch or unsafe post-payment state becomes a bounded review code, never a fabricated booking.

The success page queries PostgreSQL. It may show pending, failed, review, or confirmed state, and shows confirmed only after a stored `CONFIRMED` booking exists. A confirmed booking summary contains event/session/venue and seat labels but is explicitly not a ticket or entry credential.

## Operations and incident safety

Reconciliation may create/retrieve provider intents and store a bounded provider status, but even a provider-reported success remains `awaitingVerifiedWebhook`. Verified-webhook reprocessing accepts an internal stored webhook ID and refuses unverified records. Paid-but-unfulfilled rows are preserved for operator review; Phase 5A has no automatic refund or inventory release path.

Redis failure occurs after the PostgreSQL transaction boundary. A verified booking, booking seats, permanent inventory state, converted hold, and outbox events commit together while Redis is unavailable. The outbox dispatcher retries after recovery. Redis cannot authorize, roll back, or duplicate fulfillment.

## Current security limitations

Email verification, password reset delivery, invitations, audit-log UI, distributed HTTP rate limiting, broader abuse controls, and stronger administrator lifecycle controls remain future work. Phase 5A has no production external-provider adapter, ticket/QR/scan credential, refund, chargeback/dispute, coupon, email, waitlist, dynamic-pricing, tax/fee, or raw-card security model. The local signed provider is simulated development/test infrastructure only. PostgreSQL state, verified webhook authority, and server time remain decisive.
