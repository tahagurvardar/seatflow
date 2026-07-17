# SeatFlow Phase 2 security contract

## Trust boundaries

- Registration accepts only name, email, and password. Better Auth marks `platformRole` as `input: false`, and PostgreSQL independently defaults it to `USER`.
- There is no browser or HTTP endpoint for platform-role mutation. Administrator promotion is a confirmed CLI operation for one already registered email.
- A valid session proves identity, not tenant permission. Organization reads include the current user ID, organization identity, optional kind, and minimum membership role in the database lookup.
- Server actions re-check authentication and derive user ID, organization kind, and OWNER role on the server. Hidden form inputs are never trusted for authorization.
- Venue mutations require a current `VENUE_OPERATOR` membership with `OWNER` or `ADMIN`. `MEMBER` is read-only.
- Every nested resource action verifies organization, venue, space, map, section, row, and seat ancestry as applicable. An identifier alone never grants access.
- Redirect targets must be same-origin paths. External and protocol-relative candidates fall back to a known dashboard.

## Session posture

Better Auth stores sessions in PostgreSQL and sends an HTTP-only cookie with the `seatflow` prefix. Production enables secure cookies. Better Auth's origin and CSRF protections remain enabled, and the configured application origin is the only trusted origin.

## Data deletion

- Deleting a user cascades accounts, sessions, and memberships.
- Deleting an organization cascades memberships but is restricted when it owns venues.
- Venue-to-space and space-to-seat-map deletion is restricted. Layout children cascade only with their containing draft snapshot.
- UI deletion is limited to draft sections, rows, and seats and requires explicit confirmation.
- Deleting one user does not delete a shared tenant.
- Organization deletion and user self-deletion are not exposed in Phase 2.
- Archiving a venue or space keeps descendants intact but server-side lifecycle checks deny nested draft mutations until the parent is restored.

## Test database safety

Integration commands require `TEST_DATABASE_URL`. Its database name must be visibly marked with `test`, and it must differ from the configured development runtime/direct URLs before the command aliases it for the test process. The test command then resets only that validated target and applies committed migrations.

## Published-layout integrity

- A partial unique index permits one current `PUBLISHED` map per space.
- Lifecycle and coordinate checks reject malformed direct database writes.
- PostgreSQL triggers reject section, row, or seat changes outside a draft, validate both old and new ancestry during re-parenting, and reject changes to published/archived map identity.
- PostgreSQL rejects venues under organizer tenants, cross-space clone provenance, and deletion of published or archived snapshots.
- Publication and deep cloning are serializable, retryable transactions; failed validation leaves the current published version untouched.
- Seat-map limits cap sections, rows, seats, batch size, spacing, and coordinates to bound server and browser work.

## Future work

Email verification, password reset delivery, invitations, audit records, rate limits, abuse controls, and stronger administrator lifecycle controls belong in later security increments. Booking security, holds, payment verification, ticket issuance, and scanning are explicitly not implemented yet.
