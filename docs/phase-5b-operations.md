# Phase 5B operations guide

This guide covers ticket issuance, credential management, PDF delivery, entry validation, and notification delivery. It does not authorize refunds, disputes, transfers, resale, offline acceptance, or production use of the checked-in local providers.

## Required deployment configuration

`TICKET_CREDENTIAL_SECRET` is a dedicated high-entropy secret and must not equal any Better Auth, payment webhook, Redis, or database credential. Changing it without rotating every active ticket makes existing QR and grant hashes unverifiable. Store it in the deployment secret manager, restrict worker/web access to it, back it up under the same recovery policy as other signing keys, and never print it.

Ticket entry windows, scan/body limits, issuance batch/retry settings, PDF-grant TTL, notification batch/retry settings, and application base URL are validated at startup. `LOCAL_FILE` notification delivery and `LOCAL_SIGNED` payment processing are development/test adapters and are rejected when `NODE_ENV=production`. Production rollout must stop until reviewed external adapters exist.

Before deployment:

1. Back up PostgreSQL and confirm restore procedures.
2. Configure the dedicated ticket secret and reviewed provider settings.
3. Run `npm ci`, `npm run db:generate`, `npm run lint`, `npm run typecheck`, every required test suite, and `npm run build`.
4. Inspect `npm run db:migrate:deploy` against the intended direct database URL. The Phase 5B migration is additive and backfills tickets/issuance requests without resetting data.
5. Run `npm run tickets:report` and retain the aggregate pre-rollout snapshot.

## Ticket issuance

Booking fulfillment commits a unique pending issuance request with the confirmed booking. Best-effort immediate issuance runs after that transaction; failure cannot undo payment, booking, converted hold, or booked inventory. A scheduler or process supervisor must invoke the bounded one-shot command repeatedly:

```bash
npm run tickets:issue
```

Run until `claimed=0`, then schedule it at an interval appropriate to delivery objectives. Multiple invocations are safe: database uniqueness enforces one ticket per booked seat and one request per booking, while `SKIP LOCKED` partitions work. The command derives plaintext only in memory, stores its keyed hash, and prints counts only.

Inspect aggregate state with:

```bash
npm run tickets:report
```

Investigate any non-zero `missingTickets`, `missingCredentials`, issuance `pending`, or issuance `deadLetters`. Pending failures use bounded exponential backoff automatically. After correcting the underlying cause, explicitly requeue one reviewed dead letter by internal request ID, then drain issuance:

```bash
npm run tickets:retry -- --request-id=<internal-request-id>
npm run tickets:issue
```

The retry command only changes a matching `DEAD_LETTER` row and reports `rows=0` for a missing, pending, or completed request. It resets the attempt counter and removes the safe error/dead-letter timestamp. Do not update ticket, credential, or issuance tables by hand.

## Credential hashing, rotation, and revocation

An `SFT1` QR value is an opaque HMAC derivation over the ticket public reference and credential version. PostgreSQL stores only a second keyed HMAC-SHA256 hash. Public references are identifiers, not bearer authorization. Never log credentials, include them in notification payloads, paste them into tickets, or retain rendered PDF bytes.

An organizer OWNER/ADMIN or platform ADMIN may rotate a suspected compromised credential. Rotation preserves the ticket, marks the prior version `REPLACED`, links it to a newer active version, writes audit history, and enqueues a notice. The command deliberately does not print the new credential:

```bash
npm run tickets:manage -- --action=rotate --ticket-reference=<reference> --actor-email=<authorized-email>
```

Revocation is terminal and does not refund or release inventory. Use a bounded reason from the supported domain set:

```bash
npm run tickets:manage -- --action=revoke --ticket-reference=<reference> --actor-email=<authorized-email> --reason=COMPROMISED
```

Used tickets cannot be rotated or revoked into a different lifecycle. Every management call re-authorizes the actor against current PostgreSQL membership and records an append-only audit event.

## PDF and authenticated grants

Customer PDF actions create 256-bit random, owner-bound, short-lived, single-use grants. Only keyed hashes are stored. The download endpoint also requires the matching authenticated session. Rendering occurs before `usedAt` commits, so a rendering exception does not burn the grant. A replay, expired grant, wrong owner, revoked grant, or invalid token receives a not-found response.

PDFs contain one ticket per page, a generated QR, event/session/venue/seat context, and a public ticket reference. Rendering is bounded to eight tickets and uses no remote assets. Do not cache responses or upload generated ticket PDFs to public object storage.

## Entry validation

Entry is online-only. The organizer scanner route uses camera detection when the browser supports it and provides a manual fallback. It never claims an offline acceptance. Each request is authenticated, size/rate bounded, authorized for the target session before credential lookup, and decided with PostgreSQL time and row locks.

Organizer OWNER/ADMIN is authorized for its session. Venue-operator OWNER/ADMIN is authorized for a session hosted at its venue. Ordinary customers, tenant MEMBER roles, and unrelated organizations are denied. Concurrent valid scans produce one `ACCEPTED`; later attempts produce `ALREADY_USED`. Wrong session, cancellation, entry-window, replacement, revocation, and malformed/unknown outcomes remain append-only aggregate history.

If the web application or PostgreSQL is unavailable, scanning cannot validate and must stop. Redis, Socket.IO, the inventory outbox, and the notification provider are not consulted for entry correctness; a Redis outage therefore does not change acceptance decisions.

## Notification dispatcher and outage behavior

Issuance, rotation, and revocation commit a notification outbox row with the domain transaction. The dispatcher is a bounded one-shot process:

```bash
npm run notifications:dispatch
```

Schedule it through a process supervisor. Concurrent dispatchers use `SKIP LOCKED`; each provider call receives an idempotency key stable for that outbox attempt. The just-in-time grant token is derived from the same attempt identity, making a crash retry content-stable; a later committed attempt gets a fresh link and key. Email never contains the QR credential. Success, retryable failure, permanent failure, and timeout become append-only delivery attempts with safe codes.

Provider failure never changes ticket validity. Retryable failures remain pending with exponential backoff. To make all pending failures immediately due, or one reviewed pending row due, run:

```bash
npm run notifications:retry
npm run notifications:retry -- --outbox-id=<internal-outbox-id>
npm run notifications:dispatch
```

Permanent or exhausted rows are terminal `DEAD_LETTER` history and are reported by `npm run tickets:report` and the protected health route. Correct provider configuration first. Because terminal history is immutable, redelivery should be an explicit support workflow that creates a new domain-approved notification rather than rewriting an old dead letter.

During an email outage, keep issuance and scanning running, pause or slow dispatch if needed, monitor pending age/count, restore the provider, schedule pending retries, and drain bounded batches. Do not rotate credentials merely because email was delayed.

## Health, logs, and incident checks

`GET /api/operations/tickets/health` requires platform ADMIN and returns aggregate ticket status, issuance backlog, notification health, and scan outcomes only. It must not return database URLs, provider configuration, recipient addresses, payload bodies, credentials, grants, or stack traces. `npm run tickets:report` is the trusted-terminal equivalent.

Logs and alerts may include public ticket references, internal outbox/request IDs, aggregate counts, bounded safe error codes, and credential versions. They must not contain QR credentials, grant tokens/links, cookies, secrets, PDF bytes, email bodies, database URLs, or provider credentials.

For an issuance incident, preserve the confirmed booking, inspect missing counts and safe request errors, fix configuration/code, requeue only reviewed dead letters, and drain. For suspected credential disclosure, rotate if active or revoke if entry must be denied. For scan anomalies, inspect aggregate outcomes and append-only audit/redemption records; never edit an accepted redemption.

## Release verification

The release gate includes Prisma format/validate/generate, lint, type-check, unit/component tests, the guarded PostgreSQL suite, real Redis tests, payment-provider contract tests, notification-provider contract tests, PDF parsing/rendering tests, production build, a clean diff check, secret/artifact scanning, and browser verification at 390x844 with isolated customer and organizer/scanner profiles.

The migration and application tree must contain no captured email directory, generated ticket PDF, QR artifact, plaintext credential, grant token, real `.env`, or provider secret. Phase 5B explicitly excludes refunds, disputes/chargebacks, coupons, transfers/resale, waitlists, dynamic pricing, tax/fee/payout systems, native applications, analytics, and production adapters that have not been reviewed.
