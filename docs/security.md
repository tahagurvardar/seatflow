# SeatFlow Phase 5B security contract

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
- Customer ticket, QR, and PDF reads require an authenticated matching owner; neither a ticket reference nor a download token alone grants access.
- Scanner authorization is resolved against the target session before credential lookup. Organizer or venue-operator scope never grants customer ticket ownership.
- Ticket reference, QR credential, download grant, scanner session, idempotency key, rotation reason, and actor email are untrusted inputs with explicit bounds.

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
- one ticket per booked seat, immutable booking/event/session/organization ancestry, and one active credential per ticket
- keyed credential and grant hash grammar, legal credential replacement links, terminal ticket/credential state, and no terminal revival
- one accepted redemption per ticket, scanner/idempotency uniqueness, and append-only redemption/audit/delivery-attempt history
- owner-bound, expiring, mutually exclusive used/revoked download grants with immutable identity
- notification recipient/resource ancestry, strict terminal outbox lifecycle, bounded deduplication, and no raw credential fields

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

## Phase 5B ticket and delivery boundaries

Ticket issuance is driven only by a unique durable request tied to a confirmed booking. It rechecks exact booked-seat ancestry and creates one ticket per seat under database uniqueness. Issuance exceptions occur after booking commit, are reduced to bounded safe codes, and retry without changing payment state. A notification failure is further downstream and can never revoke, duplicate, or delay the validity of an issued ticket.

Ticket public references and download tokens use CSPRNG entropy. QR credentials are opaque, versioned HMAC derivations using a dedicated `TICKET_CREDENTIAL_SECRET`; the stored value is a separate keyed HMAC hash and comparisons use fixed-size constant-time comparison. The secret must not be reused for Better Auth, payment webhooks, Redis, or database access. Rotation invalidates the old version and links history. Revocation and first accepted use are terminal.

The scanner endpoint bounds both declared and actual body size, validates a narrow schema, requires authentication, applies a bounded rate limit, and authorizes the target session before looking up a credential. PostgreSQL time, read as an unambiguous Unix epoch, decides the entry window. Credential and ticket row locks plus uniqueness make concurrent scans single-use. Rejected unknown input records only a safe outcome/reason and never persists the submitted credential or its hash. Responses contain only minimal event/seat context after an authorized lookup.

QR and PDF responses use `no-store`, private/no-cache headers and restrictive content types. QR retrieval is unavailable after use or revocation, and terminal PDF pages display status without regenerating old QR material. PDF rendering accepts a bounded server-built view (one to eight tickets), embeds generated active QR bytes, and performs no remote fetch. Download grants are random, hash-only, owner-bound, short-lived, single-use, and locked before consumption; rendering failure rolls the consumption transaction back.

Notification payloads contain only bounded template context and relational IDs, never a credential, QR image, auth cookie, or reusable download token. A grant is minted just in time and placed in the provider message, while only its hash remains in PostgreSQL. Provider idempotency uses the stable outbox ID; delivery attempts are append-only. Header values and recipients reject control characters. Local capture paths are server-configured and the local provider is rejected in production.

The scan limiter is process-local and therefore defense in depth, not a production distributed abuse-control claim. A multi-instance deployment should add a reviewed shared edge/distributed rate limiter while retaining all database authorization and single-use invariants.

## Operations and incident safety

Reconciliation may create/retrieve provider intents and store a bounded provider status, but even a provider-reported success remains `awaitingVerifiedWebhook`. Verified-webhook reprocessing accepts an internal stored webhook ID and refuses unverified records. Paid-but-unfulfilled rows are preserved for operator review; Phase 5A has no automatic refund or inventory release path.

Redis failure occurs after the PostgreSQL transaction boundary. A verified booking, booking seats, permanent inventory state, converted hold, and outbox events commit together while Redis is unavailable. The outbox dispatcher retries after recovery. Redis cannot authorize, roll back, or duplicate fulfillment.

## Current security limitations

Email verification, password reset delivery, invitations, support/audit-log UI, distributed HTTP rate limiting, broader abuse controls, and stronger administrator lifecycle controls remain future work. Phase 5B has no production external payment or notification adapter and no refund, chargeback/dispute, coupon, waitlist, dynamic-pricing, tax/fee, or raw-card security model. Local signed payment and local file notification providers are development/test infrastructure only. PostgreSQL state, verified webhook authority, database time, and online scan validation remain decisive.

## Phase 5C1 trusted proxy, abuse control, and log boundaries

`X-Forwarded-For` is attacker-controlled unless every hop that appended to it is trusted. Phase 4B's `clientAddressFromRequest` returned its first entry unconditionally, so any caller could evade the process-local limiter by rotating a header it fully controls. Phase 5C1 replaces that with an explicit policy: `none` ignores forwarding headers entirely and is the default; `trusted-hop` selects the entry immediately left of a declared number of proxies; `platform-header` trusts exactly one platform header and rejects a list. A chain that is oversized, over-long, or contains any invalid entry is rejected outright rather than partially trusted, so a spoofed prefix cannot shift which entry is selected. A resolved address is used only for abuse control and coarse diagnostics; it is never an authorization input.

Rate-limit subjects are reduced to a keyed HMAC before reaching Redis or a log field, domain-separated from every other use of the signing secret. No raw address, email, session token, hold token, or ticket credential enters the key space, and key segments are validated so a caller cannot inject a separator and reach another namespace. Keys are environment-scoped with a bounded TTL set atomically with the increment, so a crash cannot leave a key without an expiry and lock a subject out permanently.

Failure modes are declared per policy. Most are fail-open, and that is a security judgement rather than a convenience: for each of them PostgreSQL remains decisive, so losing a counter degrades throttling without enabling an incorrect outcome. A payment webhook must not be dropped because a cache is down, or a verified payment goes unfulfilled. Ticket validation cannot falsely accept entry, because acceptance still requires the stored keyed hash to match and the single-accepted-redemption partial unique index to be free. Mutating administrative operations fail closed. Readiness reports when distributed protection has degraded to per-process counters, because that condition is otherwise invisible from outside.

Logs use an allow-list. A key whose normalized form contains a sensitive fragment is dropped, values are bounded primitives only, and objects and arrays are never serialized. Free text is additionally scrubbed for connection strings, credentialed URLs, ticket credentials, webhook signatures, bearer tokens, JWTs, hex hashes, long bearer-shaped tokens, and email addresses. CR and LF are collapsed, which is a control against forged log records rather than formatting. Ticket public references remain readable by design, matching the Phase 5B contract that they are identifiers and not bearer credentials.

Clients never receive a stack trace, driver message, provider response, or schema detail. An expected domain rejection may explain itself; an internal failure returns a generic sentence plus a correlation ID.

The security header policy sets a per-request nonce with `strict-dynamic`, denies framing and plugins, restricts the referrer, and grants only `camera=(self)` for the organizer scanner. `style-src` keeps `'unsafe-inline'` because inline style attributes position the seat map and cannot be nonce-covered; scripts remain nonce-gated, which is where the XSS risk actually lies. Sensitive API responses carry `private, no-store`; authenticated HTML pages receive the framework's `no-cache, must-revalidate`, which requires revalidation but permits storage — a documented limitation rather than a claim.

## Phase 5C2A: refunds, disputes, and the financial boundary

**Only a cryptographically verified provider webhook can settle money.** A browser redirect, a client response, an organizer action, and Redis all cannot. Even the provider's own reply during refund submission is a receipt, not authority: the only path that may set `Refund.succeededAt` is reached after a signature check over the exact raw request bytes.

**Over-refunding is prevented by PostgreSQL, not by careful callers.** Two trigger-maintained aggregates live on `PaymentAttempt`. Every refund write updates that row, which takes a row lock and serializes concurrent refund creation for one payment, and a CHECK constraint rejects any total exceeding the captured amount. Sixteen simultaneous refund requests against one payment stay within the captured amount; this is asserted by the integration suite.

**No client input decides money.** The refund form carries a booking reference, a scope, the customer's own seat identifiers, and a submission nonce. Amount, currency, provider, payment ancestry, ownership, and eligibility are all derived server-side. A field naming an amount, currency, user, organization, or status is not read at all.

**Authorization by role.** A customer may only act on their own booking, and their submission is a *request*, never refund authority. An organizer may read aggregates for organizations they are a member of, resolved from membership rather than from any client-supplied identifier, and has no control that can settle a refund or create a dispute. A platform admin sees the operational queues; the page deliberately contains no financial adjustment control.

**Cross-tenant reads are impossible by construction.** Organizer queries are filtered by the organization id that the membership lookup returned. A guessed slug renders as not-found, identical to a slug that does not exist, so tenant existence is not observable.

**Disputes cannot be fabricated.** No function reachable from a browser, an organizer, or an admin opens, advances, or closes a dispute; only a verified provider webhook does. The first terminal outcome is permanent, and a provider that contradicts itself freezes the dispute for a human rather than flipping it — notably without recording a chargeback.

**Webhook secret rotation closes by itself.** A previous secret requires an explicit expiry, is refused if it exceeds seven days or equals the current secret, and simply stops being offered for verification once it lapses. An invalid window verifies nothing at all rather than falling back. Verification tries every candidate in constant time for the local provider, and uses Stripe's own `constructEvent` for the external one.

**Exact-once webhook processing.** Payment, refund, and dispute events share one table so a single unique `(provider, providerEventId)` gives replay protection across every financial event type. Defence is layered: the unique event id, a row lock on the webhook record, deterministic ledger idempotency keys, and marking the webhook processed only inside the transaction that applied the change.

**The ledger cannot be edited.** A trigger rejects every UPDATE and DELETE on `FinancialLedgerEntry`. Provider references are stored only as SHA-256 hashes, so reading the full financial history exposes no provider identifier.

**Secrets never appear in output.** `production:check` findings name the variable at fault and never its value, asserted by a unit test. Probe failures report a probe name, never a driver message. Reconciliation commands print bounded aggregates only. Browser tests assert that no provider key, webhook secret, connection string, ticket credential, provider identifier, or webhook signature appears in rendered markup.

**Financial probes fail closed.** A probe that cannot be evaluated is reported as an explicit unknown and blocks the deployment gate. Treating a failed probe as "no backlog" would mean the one time the check could not see the books is the one time it waves a deployment through.

**Email content is gated centrally.** Ticket credentials, provider keys, webhook secrets, notification API keys, connection strings, and embedded QR images are refused before any adapter sends. Recipient and subject are validated against CR/LF injection. In Resend test mode every message is redirected to one approved test recipient, so a misconfigured non-production deployment cannot email a real customer.

### The isolated end-to-end test exception

Browser verification must run against a **production build**, because the dev server injects a hot-reload socket and a dev-tools portal that make "no console errors" and "no framework overlay" unverifiable. A production build sets `NODE_ENV=production`, where the development-only `LOCAL_SIGNED` provider is forbidden — the rule that must not be weakened.

`src/features/operations/e2e-test-mode.ts` is the single, narrow, audited exception. It grants nothing on its own and requires **every** one of the following to hold simultaneously:

| Condition | Refusal reason |
|---|---|
| `SEATFLOW_E2E_TEST_MODE=true` | `FLAG_NOT_SET` |
| `DATABASE_URL` names a clearly test-marked database | `DATABASE_NOT_TEST_MARKED` |
| That database is not the protected development/production one | `DATABASE_IS_PROTECTED` |
| `BETTER_AUTH_URL` and `NEXT_PUBLIC_APP_URL` are loopback | `ORIGIN_NOT_LOOPBACK` |
| A synthetic local webhook secret of at least 32 characters is present | `LOCAL_SECRET_MISSING` |
| **No** real provider credential (`STRIPE_SECRET_KEY`, `RESEND_API_KEY`) is present | `REAL_PROVIDER_CREDENTIALS_PRESENT` |

The flag alone proves nothing; a real deployment fails the database, origin, and credential conditions. The predicate is pure — no `process.env`, no I/O, no clock — so every refusal path is unit tested.

Two further containments:

- **`production:check` blocks on the flag's mere presence** (`e2e_test_mode_enabled`), regardless of whether the other conditions happen to hold. A deployment serving real traffic has no business carrying it.
- The override is **not reachable from any customer-controlled input**. It is read from process environment only, never from a request, header, cookie, or form field.

The browser harness itself never bypasses authentication or authorization: it signs in through the real login form, and it never writes a Refund, RefundAttempt, Booking, BookingSeat, Ticket, TicketCredential, inventory, ledger, dispute, or webhook-processing row. Its only privileged act is generating a valid synthetic LOCAL_SIGNED signature and POSTing it to the application's own webhook route, exactly as the provider would.
