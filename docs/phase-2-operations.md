# Phase 2 operations and seat-map contract

## Local development

Use Node.js 22.12 or newer and PostgreSQL. Create distinct `seatflow`, `seatflow_test`, and—only when your database role cannot create temporary databases—`seatflow_shadow` databases. Copy `.env.example` to `.env`, install with `npm ci`, apply migrations with `npm run db:migrate`, then start `npm run dev`.

The required runtime secrets are:

- `DATABASE_URL`: application PostgreSQL connection
- `DIRECT_URL`: direct/non-pooled migration connection; it may match `DATABASE_URL` locally
- `TEST_DATABASE_URL`: disposable database whose name visibly contains `test`; the integration runner resets it
- `BETTER_AUTH_SECRET`: random value of at least 32 characters
- `BETTER_AUTH_URL`: canonical Better Auth origin
- `NEXT_PUBLIC_APP_URL`: browser-visible canonical application origin

`SHADOW_DATABASE_URL` is optional. When present, it is used only by Prisma Migrate development commands and must never target an application or test database.

## Deployment

1. Provision PostgreSQL and set the production environment variables above.
2. Run `npm ci` with the committed lockfile.
3. Run `npm run db:migrate:deploy` before promoting application traffic.
4. Run `npm run build`; the build generates Prisma Client and does not need to open a database connection.
5. Start the Next.js Node application behind HTTPS. Production Better Auth cookies are secure.

Do not run `db:reset`, `test:integration`, or `prisma migrate dev` against production. Do not use the pooled runtime URL for migrations when a provider supplies a direct URL.

## CI expectations

The committed GitHub Actions workflow provisions PostgreSQL 17, creates a separate test database, applies the application migrations, and then runs lint, TypeScript, unit/component tests, PostgreSQL integration tests, and the production build. Integration tests are serial because they intentionally reset and reuse one guarded test database.

A change is not complete when only mocked tests pass. Schema, authorization, publication, clone, and immutability behavior must continue to pass against PostgreSQL.

## Schema and migration decisions

- Venue slugs are unique per organization; space slugs are unique per venue.
- A seat-map version is a server-assigned positive integer unique per space.
- Section codes are unique per map, row labels per section, and seat labels per row.
- Coordinates are integers from 0 through 10,000 and are local to a section. Publication rejects overlaps inside a section.
- `Organization → Venue`, `Venue → Space`, and `Space → SeatMap` use restrictive deletion. Draft layout children use cascading deletion.
- PostgreSQL rejects a venue attached to a non-`VENUE_OPERATOR` organization, a clone source from another space, and direct deletion of a published or archived seat-map snapshot.
- Venue and space archive timestamps must agree with their `ARCHIVED` status.
- A raw PostgreSQL partial unique index enforces one `PUBLISHED` map per space. It is committed in migration SQL rather than enabling Prisma's preview partial-index feature.
- PostgreSQL triggers make published/archived map identity and all non-draft layout children immutable. The follow-up ancestry-hardening migration checks both sides of a section, row, or seat re-parenting update so content cannot be moved into or out of an immutable map.

Migrations are append-only after deployment. The Phase 2 migration creates enums, tables, indexes, checks, foreign keys, the partial unique index, and immutability trigger functions together. Future changes must add a new migration; they must not edit an already deployed migration.

## Authorization rules

- All authenticated accounts remain customers.
- Venue capability comes only from a membership in an organization whose kind is `VENUE_OPERATOR`.
- `OWNER` and `ADMIN` can create, update, archive, restore, edit, publish, and clone.
- `MEMBER` can view authorized tenant data and immutable/draft previews but cannot mutate.
- Every page and Server Action performs a server-side session check.
- Every nested lookup verifies the complete organization → venue → space → map → section → row → seat ownership chain relevant to the operation.
- Route params, bound arguments, hidden fields, requested versions, and client-side previews are untrusted inputs.
- Archiving a venue or space preserves descendant records and versions but makes nested drafts read-only. Restore the parent hierarchy before editing, publishing, or cloning.

## Seat-map lifecycle

`DRAFT` is the only editable status. Draft creation allocates `max(version) + 1` inside a serializable transaction. Published versions are never edited in place.

Publishing reloads and validates the complete draft inside a serializable transaction. It requires at least one section, row, and seat; unique sibling ordering; valid coordinates; no section-local coordinate overlap; and at least one accessible seat per companion seat in the same row. The transaction archives the prior current version and publishes the draft. Validation failure rolls back without changing the current published version. Repeated publication of the already current version is idempotent.

Cloning is allowed from the current `PUBLISHED` version. It deep-copies every section, row, and seat with new identifiers, records `sourceSeatMapId`, and allocates the next version atomically. The source snapshot remains unchanged.

Physical capacity counts every seat. Sellable capacity counts only `ACTIVE` seats. `BLOCKED` seats remain part of the physical layout and are excluded from sellable capacity. Capacity is also summarized by `STANDARD`, `ACCESSIBLE`, `COMPANION`, and `PREMIUM` type.

## Editor limits

| Limit | Value |
| --- | ---: |
| Sections per map | 20 |
| Rows per section | 60 |
| Seats per row | 80 |
| Seats per map | 3,000 |
| Rows per bulk operation | 30 |
| Coordinate range | 0–10,000 |
| Horizontal/vertical spacing | 1–200 |

Bulk generation accepts a starting alphabetic row label, row count, seats per row, starting seat number, and spacing. It renders a bounded row-and-seat label preview in the browser, then repeats all validation on the server and commits the nested rows/seats atomically. Labels continue from `Z` to `AA` through `ZZZ`; an operation that would overflow `ZZZ` is rejected before persistence. The editor and read-only preview use the same scrollable coordinate canvas, so horizontal and vertical spacing remain visible on desktop and narrow screens without introducing a CAD-style interaction model.

## Explicit exclusions

Phase 2 does not include persisted events or sessions, session-specific seat availability, inventory, pricing, holds, Redis, WebSockets, bookings, checkout, payments, refunds, coupons, QR tickets, scanning, email, analytics, or entry-control workflows. The seat renderer is a venue-management preview and is not a customer booking interface.
