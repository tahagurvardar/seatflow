# SeatFlow Phase 3 security contract

## Trust boundaries

- A valid Better Auth session proves identity, not platform or tenant permission.
- Registration cannot set `platformRole`; administrator promotion remains a confirmed trusted-terminal operation.
- Every protected read and Server Action re-resolves the current user, tenant kind, tenant identity, and minimum membership role from PostgreSQL.
- Organizer IDs are not accepted from event forms. Ownership is derived from the authorized organization slug.
- Route params, bound action arguments, hidden fields, selected venue/space/map IDs, tier IDs, section IDs, and stale forms are untrusted.
- Organizer OWNER/ADMIN can mutate authorized event resources; organizer MEMBER is read-only.
- Venue-operator OWNER/ADMIN can grant or revoke access for their owned venue; operator MEMBER is read-only. Organizer membership cannot self-approve venue access.
- Public queries expose only deliberately published content and the venue/space/map information needed for discovery.

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

Repeated publish/revoke requests are safe. Unique/exclusion races are mapped to domain errors where practical and cannot leave partially published configuration.

## Venue access revocation

Revocation closes the grant and prevents new sessions and draft-session publication. It deliberately does not cancel, delete, or retarget an already published session. Operators may see limited upcoming configured-session counts for owned venues but cannot edit organizer event content.

## Data deletion and history

Only a draft event with no sessions can be hard-deleted by an authorized organizer manager. Cancellation and archive preserve events, sessions, map references, and pricing. Published map snapshots cannot be deleted. Deleting a user may null historical grant actor fields but cannot erase the grant record.

## Test database safety

Integration commands require `TEST_DATABASE_URL`. The name must visibly contain `test`, it must differ from development/runtime URLs, and only that validated target is reset. Tests apply the complete append-only migration chain.

## Current security limitations

Email verification, password reset delivery, invitations, audit-log UI, rate limits, abuse controls, and stronger administrator lifecycle controls remain future work. Seat holds, availability concurrency, booking, payment verification, tickets, and scanning are outside Phase 3 and must not be inferred from configured capacities.
