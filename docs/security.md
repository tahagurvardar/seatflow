# SeatFlow Phase 4A security contract

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

## Current security limitations

Email verification, password reset delivery, invitations, audit-log UI, rate limits, abuse controls, and stronger administrator lifecycle controls remain future work. Phase 4A has no Redis, real-time push, automatic expiry scheduler, booking, checkout, payment verification, ticket, or scanning security model. The countdown is presentation only; PostgreSQL state and server time remain authoritative.
