# SeatFlow observability

## Structured logging

`src/server/observability/logger.ts` produces JSON-serializable records with a
fixed envelope:

```json
{
  "timestamp": "2026-07-19T10:04:11.482Z",
  "level": "info",
  "service": "seatflow-web",
  "environment": "production",
  "message": "ticket validation completed",
  "correlationId": "9f2c41ab7e0d4c8fa1b6e3d5c7902341",
  "operation": "ticket.validate",
  "outcome": "accepted",
  "durationMs": 41,
  "metadata": { "policy": "ticket.validate" }
}
```

Development emits the same record as a readable line; production emits one JSON
object per line. Both paths run identical redaction — the readable format is a
rendering choice, never a relaxation.

`LOG_LEVEL` selects the threshold (`debug`, `info`, `warn`, `error`).
`SEATFLOW_SERVICE_NAME` distinguishes the web process from each worker.

### Allow-list discipline

Logging is opt-in per field, not opt-out. `sanitizeMetadata`:

- drops any key whose normalized form contains a sensitive fragment
  (`secret`, `password`, `credential`, `signature`, `cookie`, `authorization`,
  `apikey`, `token`, `hash`, `salt`, `payload`, `rawbody`, `stack`, `email`,
  `databaseurl`, `redisurl`, `cardnumber`, `cvv`, `iban`, `pan`, …);
- accepts only bounded primitives — strings, finite numbers, booleans, null;
- **drops objects and arrays entirely** rather than serializing them, which is
  what stops a Prisma error, a request, an environment object, or a provider
  response from being flattened into a record wholesale;
- caps the record at 24 keys and each string at 256 characters.

### Value scrubbing

Every message and every string metadata value additionally passes through
`redactSensitiveText`, which removes:

| Pattern | Replacement |
| --- | --- |
| `postgres://…`, `postgresql://…`, `mongodb://…` | `[database endpoint redacted]` |
| `redis://…`, `rediss://…` | `[redis endpoint redacted]` |
| any URL with inline `user:password@` | `[credentialed url redacted]` |
| `SFT1.…` ticket credentials | `[ticket credential redacted]` |
| `t=…,v1=…` webhook signatures | `[webhook signature redacted]` |
| `Bearer …` / `Basic …` | `Bearer [redacted]` |
| JWTs (`eyJ….….…`) | `[jwt redacted]` |
| hex runs ≥ 32 chars (stored keyed hashes) | `[hash redacted]` |
| base64url runs ≥ 40 chars (grant, hold, credential tokens) | `[token redacted]` |
| email addresses | `[email redacted]` |
| CR, LF, tab | single space |

Two deliberate carve-outs:

- **Ticket public references stay readable.** They are 32 base64url characters —
  below the 40-character token threshold — because the Phase 5B operations
  contract requires them for support workflows. They are identifiers, not bearer
  credentials.
- **`redactEmailAddress` preserves the domain** (`***@example.com`) for the rare
  case where delivery triage genuinely needs it. Store the result under a
  non-`email` key; the raw value would otherwise be dropped by the key filter.

Collapsing CR/LF is a security control, not formatting: without it a caller could
inject a forged second log record.

### Error serialization

`serializeError` never serializes an error object. It produces four fields:

- `classification` — `expected_rejection` (a request the system correctly
  refused) or `internal_failure` (a fault worth paging for). Derived from the
  class-name suffix (`…ConflictError`, `…AuthorizationError`, …), the Zod error
  name, or the Prisma code.
- `code` — a bounded, stable identifier such as `HOLD_CONFLICT` or
  `PRISMA_P2002`. For Prisma, **only the code is used**, never the message,
  because Prisma messages embed query text and connection details.
- `message` — scrubbed and bounded.
- `correlationId`.

`toClientErrorBody` is the only thing a client sees. An expected rejection may
explain itself; an internal failure returns a generic sentence plus the
correlation ID. No stack trace, driver message, provider response, or schema
detail ever reaches a client.

## Correlation

`x-correlation-id` is accepted from the caller **only** when it matches
`^[A-Za-z0-9_-]{8,64}$`. Anything malformed, oversized, or containing CR/LF is
silently replaced with a freshly generated 128-bit value. That strict grammar is
what makes it safe to echo the value back in a response header.

The proxy (`src/proxy.ts`) establishes the ID for every request and sets it on
both the forwarded request and the response. Route handlers read it with
`correlationIdFromHeaders`. Workers mint their own with
`createOperationCorrelationId("outbox")`.

Propagation covers web requests, payment webhook processing, ticket issuance,
ticket validation, inventory outbox dispatch, notification dispatch, and
reconciliation.

> **This is correlation, not distributed tracing.** There is no span model, no
> parent/child relationship, no sampling, and no W3C `traceparent` support. A
> correlation ID groups log records inside SeatFlow. Do not describe it as
> tracing in a status report.

A correlation ID is never an authentication factor and never an idempotency key,
because it is partly client-supplied. Idempotency remains the caller's explicit
key plus PostgreSQL uniqueness.

## Health, readiness, liveness

| Probe | Dependencies | Failure meaning |
| --- | --- | --- |
| `/api/health/live` | none | The process is wedged; restart it. |
| `/api/health/ready` | bounded probes | The instance cannot serve safely; remove it from rotation but leave it running. |

Liveness performs **no** database, Redis, or provider I/O. A liveness probe that
touched dependencies would let one PostgreSQL blip convince an orchestrator to
restart every healthy instance, turning a dependency incident into a total
outage.

Readiness distinguishes `warn` from `fail` deliberately. A backlog is a warning:
draining it needs the instance to keep working, not to be removed. Only a hard
failure — PostgreSQL unreachable, migrations behind, provider configuration
invalid — returns 503.

Role matters. `redisRequiredForRole` marks Redis required for every worker role
and *not* required for `web`, because Phase 4B established that PostgreSQL alone
is sufficient for correct holds, payments, and entry.

The unauthenticated readiness body carries only an overall status. The per-check
breakdown requires a platform administrator, so an anonymous caller cannot
enumerate which dependency is currently unhealthy. Neither form contains a URL,
username, hostname, schema name, internal ID, secret, or stack trace — and an
integration test asserts exactly that.

## Worker heartbeats

`WorkerHeartbeat` is keyed by `(workerType, environment, instanceLabel)` and
stores only: status, an optional version, start time, last-seen time, last run
duration, and a consecutive-failure count.

It deliberately has **no** column for a hostname, address, connection string,
secret, or process command line, and database `CHECK` constraints bound the
label and version grammar so a heartbeat can never become a log-injection or
leak vector.

Heartbeats live in PostgreSQL, not Redis, because a Redis-based heartbeat would
disappear at exactly the moment a Redis-dependent worker stopped — leaving an
operator with no signal during the incident that most needs one.

Staleness is derived from `lastSeenAt` rather than self-reporting, because the
failure that matters most (a crashed or wedged worker) is precisely the one that
cannot report anything. A deliberate shutdown writes `STOPPED`, which keeps a
planned maintenance window distinguishable from a crash.

Continuous workers beat on a timer; bounded one-shot commands beat per
invocation, so a scheduler that stops calling them also surfaces as stale.

## Metrics

`GET /api/operations/metrics` (platform ADMIN) combines PostgreSQL aggregates
with per-process counters.

**From PostgreSQL** — outbox pending / dead letters / oldest age, transaction
retries, hold conflicts, dispatcher failures and duration, overdue holds and
expiry lag, pending orders, paid-unfulfilled, requires-review, failed and
verified-unprocessed webhooks, booking fulfillment failures, confirmed bookings,
ticket issuance backlog, missing tickets and credentials, notification pending /
dead letters / oldest age, notification delivery duration, ticket validation
outcomes by enum, duplicate scans, unauthorized scanner attempts, worker
heartbeat ages.

**From the process** — request count and latency percentiles by route group,
HTTP outcome classes, and rate-limit rejections by policy.

### Label bounding

Every label comes from a closed set. `classifyRouteGroup` collapses
`/events/summer-fest-2026/sessions/abc/seats` and
`/events/winter-gala/sessions/def/seats` to the single label `public_events`.
Rate-limit rejections accept only names from the policy catalogue; anything else
becomes `unclassified`.

No metric is keyed by user ID, ticket ID, booking reference, event slug, session
ID, email, IP address, or raw path. That is not only a cardinality concern — an
unbounded label set would quietly turn an operations dashboard into a
personal-data export. An integration test asserts no customer, session, or seat
identifier appears anywhere in the metrics payload.

Latency percentiles are approximated from fixed histogram buckets and reported as
the bucket's upper bound, so they are upper estimates rather than interpolations
that would imply more precision than a histogram carries.

Per-process counters reset on restart. Only the PostgreSQL aggregates survive a
deployment; treat the process block as instantaneous, not historical.

## Phase 5C2A: financial metrics and probes

### Bounded labels

Financial metrics use closed label sets only: refund status, dispute status, ledger entry type, and ISO currency code. Refund references, order ids, booking references, user ids, emails, provider identifiers, and IP addresses are deliberately absent — any of them as a label would make the series unbounded and turn a dashboard into a customer-data export.

`collectOperationalMetrics` gains a `financials` section covering refunds by status, reconciliation backlog, oldest pending age, provider failures and timeouts, refunded amount by currency, disputes by status, evidence-due count, disputed amount by currency, ledger entry counts by type, unprocessed refund/dispute webhook counts, and the ticket-revocation backlog.

### Live probes and fail-closed behaviour

`financial-probes.ts` supplies four deployment gates: refund reconciliation backlog, unresolved chargebacks, ledger divergence, and ticket-revocation backlog. Each is read-only, bounded, and indexed, and each runs in isolation so one failure does not mask the others.

A probe that fails returns an explicit failure **by name**, never a comforting zero, and `production:check` blocks on `financial_probe_unavailable`. This is the point: reporting "no backlog" because a query threw is how a broken check becomes a green light. The behaviour was confirmed in practice when PostgreSQL stopped mid-session and the gate blocked rather than reporting healthy.

Thresholds come from validated configuration: `REFUND_BACKLOG_STALE_SECONDS` (a refund still moving normally is not backlog), `FINANCIAL_DIVERGENCE_SCAN_LIMIT` (caps the scan so a preflight cannot itself become an outage), `DEPLOY_MAX_REFUND_BACKLOG`, and `DEPLOY_MAX_UNRESOLVED_CHARGEBACKS`.

Probe failures report a probe name only. A driver message can quote schema and connection details, so it is dropped rather than surfaced.

### Operational reporting

`npm run financial:report` prints bounded aggregates — refund and dispute queue depths, oldest pending age, divergence counts by reason, and revocation backlog — with no reference, id, email, or provider identifier. When a probe could not be evaluated it says so explicitly and instructs the reader to treat that gate as unknown rather than zero.

The `REFUND_RECONCILIATION` and `FINANCIAL_OUTBOX_DISPATCHER` worker types report liveness through the Phase 5C1 `WorkerHeartbeat` table, so a stopped reconciler is visible in readiness without any Redis dependency.

## Phase 5C2B — serverless job observability

### Heartbeats work identically in both modes

A serverless job writes a `WorkerHeartbeat` on every invocation, using the same
`WorkerType` its resident counterpart would. A scheduler that silently stops
delivering therefore shows up exactly as a crashed worker does: a stale
heartbeat in `/api/health/ready` and `/api/operations/metrics`.

This is why heartbeats live in PostgreSQL rather than in the scheduler. A
QStash-based heartbeat would disappear at the same moment QStash stopped
delivering, leaving an operator with no signal at the one time they need one.

### Expected workers depend on the mode

`expectedWorkerTypes({ jobMode })` omits `REALTIME_GATEWAY` in serverless mode,
because there genuinely is no gateway process there — clients poll instead.
Reporting it as missing would leave readiness permanently degraded for something
that is not a fault, and a signal that is always yellow is a signal nobody reads.

Every scheduled job is still expected, because a scheduler that stops **is** a
real failure.

### Readiness reports the profile

The platform-admin view of `/api/health/ready` includes `profile` and `jobMode`
alongside the per-check breakdown, so an operator can tell at a glance which
world they are looking at. The anonymous body stays minimal — an overall status
only — so a caller cannot enumerate which dependency is unhealthy.

### Delivery receipts

`JobDeliveryReceipt` records that a delivery arrived and how it ended:

| Column | Meaning |
| --- | --- |
| `messageId` | Scheduler-supplied, normalized to a constrained grammar |
| `job`, `environment` | Bounded labels |
| `receivedAt`, `completedAt` | A receipt completes only on a terminal outcome |
| `outcome` | `COMPLETED`, `RETRYABLE_FAILURE`, `PERMANENT_FAILURE` |
| `attemptCount`, `durationMs`, `safeErrorCode` | Bounded counters and a safe code |

There is deliberately **no** column for the signature, the raw payload, a
signing key, a caller address, or any booking, payment, refund, or ticket
identifier. A receipt records that an operation ran, never what it decided.

A retryable failure leaves the receipt uncompleted so the next delivery can claim
it again; marking it completed would strand the work. Receipt writes are
best-effort and swallowed on failure — observability must never break the work it
observes, and a lost receipt costs duplicate suppression, not correctness.

`pruneJobDeliveryReceipts` removes rows past a retention window in bounded
batches. Nothing reads them downstream, so pruning is safe.

### Interpreting a retry storm

Rising `attemptCount` across many receipts for one job means either a genuine
dependency failure or a permanent fault being misclassified as retryable. Check
`safeErrorCode` first: a repeated identical code that is not transient in nature
suggests the classification is wrong, and the job will retry until its budget is
exhausted rather than surfacing.
