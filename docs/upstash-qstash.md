# Upstash Redis and QStash

Free-tier Redis and job scheduling in AWS `eu-central-1` (Frankfurt).

## Redis: transport, never authority

Unchanged from Phase 4B and worth restating, because a serverless deployment
makes it tempting to forget: Redis carries inventory invalidation events and
rate-limit counters. It decides nothing. It cannot grant a hold, confirm a
payment, issue a ticket, or accept an entry scan.

If Redis disappears entirely, the platform stays correct. Clients fall back to
authoritative polling and rate limiting degrades to per-process counters.

### Three transports

| Transport | When | Why |
|---|---|---|
| **REST** (`UPSTASH_REDIS_REST_URL` + token) | preferred on serverless | No socket lifecycle. Concurrent isolates cannot exhaust the connection limit. |
| **TCP** (`REDIS_URL`) | local, and required by BullMQ | Real Redis semantics: streams, Lua, blocking reads. |
| **Unavailable** | neither configured | Explicit refusal, not silent success. |

Selection is automatic — REST when both REST values are present, TCP when only
`REDIS_URL` is, unavailable otherwise. Both transports run the *same* Lua
scripts, so deduplication, stream trimming, and rate-limit policy are identical
either way.

### Why "unavailable" throws

`UnavailableInventoryEventTransport.publish()` throws rather than returning
quietly. That looks backwards until you follow the dispatcher: it marks an
outbox row `processedAt` only if `publish` resolved. A transport that returned
success would mark the row processed and **lose the invalidation permanently**.
Throwing leaves it pending and retryable.

### Connection reuse

The TCP client is module-scoped and `lazyConnect`, so constructing it opens
nothing and a warm isolate reuses one socket across invocations. The rate
limiter additionally backs off for 5 seconds after a failure, so a Redis outage
does not make every request pay the timeout.

## QStash: signed job delivery

QStash replaces the BullMQ scheduler. It calls
`POST /api/internal/jobs/<job>` on a cron schedule with a signed body.

```bash
npm run staging:schedule -- list     # show the intended schedule, no network
npm run staging:schedule -- apply    # publish, requires typed "yes"
npm run staging:schedule -- remove   # delete every SeatFlow schedule
```

### Security model

Every delivery must satisfy all of:

| Check | Failure response |
|---|---|
| `SEATFLOW_JOB_MODE=serverless` | 503 (retryable — mode may not be switched yet) |
| Job name is known | 400 |
| `content-length` within `JOB_REQUEST_MAX_BYTES` | 413 |
| Actual body within the same bound | 413 |
| Valid signature, current **or** next key | 401 |
| Body parses against the strict schema | 400 |
| Path and body name the same job | 400 |

Signature verification happens **before parsing**, over the exact raw bytes. A
parser is a far larger attack surface than a MAC comparison, and running it on
unverified input would expose it to anyone who can reach the URL.

### Key rotation

Both `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY` are required and
must differ. The verifier tries current, then next, and records which one
matched. That matters during a rotation: if every delivery is suddenly verifying
on the *next* key, Upstash has already retired the current one and the
deployment's environment is behind.

To rotate: read both keys from the Upstash console, update both variables in
Vercel, redeploy. There is no window in which deliveries fail, because the
verifier accepts either.

### Payloads carry no business state

```json
{ "job": "hold-expiry-sweep" }
```

That is the entire body. The schema is strict — unknown keys are **rejected**,
not ignored — so a payload carrying `bookingId`, `actorUserId`, `amountMinor`,
or `paymentStatus` fails verification rather than being silently dropped.

Consequently a forged payload can at most ask for work to happen sooner, which
the scheduler is allowed to do anyway. It can never assert that a payment
succeeded, a refund settled, or a ticket belongs to someone.

### Retry semantics

QStash retries any non-2xx, which makes the status mapping a correctness
decision:

| Outcome | Status | Reason |
|---|---|---|
| Completed | 200 | Done. |
| Duplicate | 200 | Already completed; nothing re-ran. |
| **Permanent failure** | **200** | Retrying cannot help. A 5xx would redeliver until the budget ran out and bury the fault. |
| Retryable failure | 503 | A transient dependency failed; deliver again. |

Failures are recorded in `JobDeliveryReceipt` regardless, so answering 200 to a
permanent failure loses no visibility.

### What is never logged

The signature header, either signing key, the QStash token, the raw body, and
any identifier a job touched. Error summaries are stripped of connection strings
and URLs and truncated to 80 characters before they can travel to a scheduler
log this platform does not control.

## Free-tier budgets

| Service | Limit | Mitigation |
|---|---|---|
| Redis | daily command budget | REST preferred; limiter degrades gracefully |
| Redis | ~256 MB | Streams are `MAXLEN`-trimmed; dedup keys expire |
| QStash | daily message budget | Conservative cadences (2 min fastest) |
| QStash | bounded retries | 3 per message; operations are idempotent |

Running out of QStash budget stops scheduled work. Nothing becomes incorrect —
holds still expire lazily during acquisition, and the stale worker heartbeats
make the gap visible in `/api/health/ready`.
