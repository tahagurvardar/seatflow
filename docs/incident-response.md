# SeatFlow incident response runbooks

Every runbook below assumes least-privilege access from a trusted terminal.

**Universal rules**

- PostgreSQL is authoritative. Never reconstruct inventory, bookings, tickets, or
  entry decisions from Redis, a log line, or a provider dashboard.
- Never run `npm run db:reset` against a development or production URL. It is a
  test-only command guarded by `readSafeTestDatabaseUrl`.
- Never edit payment, booking, ticket, credential, redemption, or audit rows by
  hand. Those tables are append-only or trigger-protected by design; a manual
  write can silently violate an invariant the application relies on.
- Never paste a secret, connection string, webhook signature, QR credential,
  download token, or session cookie into a ticket, chat, or log.
- Record the correlation ID (`x-correlation-id`) from the affected responses.

**Universal first three commands**

```bash
curl -sS https://<host>/api/health/live
curl -sS https://<host>/api/health/ready          # authenticate as admin for detail
npm run production:check                          # read-only; never mutates
```

---

## 1. PostgreSQL unavailable

**Detection** — `/api/health/ready` returns 503 with `postgresql: fail`. Every
page errors. Workers log `internal_failure`.

**Immediate containment** — Stop the load, not the database. Leave web instances
running: readiness has already removed them from rotation and they will recover
without a restart. Pause dispatchers to stop retry amplification.

**Safety assumptions** — No booking, ticket, or entry decision can be made while
PostgreSQL is down. Scanning must stop; there is no offline acceptance path.

**Safe commands**

```bash
npx prisma migrate status          # read-only connectivity probe
npm run production:check -- --skip-probes
```

**Must not be used** — `db:reset`, `migrate reset`, `migrate dev`, any manual
`UPDATE`/`DELETE`, or a failover that has not been rehearsed.

**Recovery verification** — `/api/health/ready` returns `ready` or `degraded`;
`npx prisma migrate status` reports up to date; outbox backlog drains toward
zero; `npm run tickets:report` shows no new dead letters.

**Escalation** — Any suspected data loss, a failed failover, or an outage
exceeding the recovery objective goes to the database owner immediately.

---

## 2. Redis unavailable

**Detection** — `/api/health/ready` shows `redis: warn` (web) or `fail`
(workers), plus `distributed_rate_limit: process_local_only`. Outbox backlog
grows. Clients fall back to polling.

**Immediate containment** — None required for correctness. Keep the web tier and
PostgreSQL hold path running.

**Safety assumptions** — Redis holds no authority. A total key loss cannot free a
seat, transfer a hold, confirm a payment, issue a ticket, or accept an entry.
Abuse protection degrades to per-process counters, so a multi-instance
deployment is temporarily easier to abuse.

**Safe commands**

```bash
npm run holds:sweep -- --batch-size 100 --max-batches 10   # PostgreSQL sweeper
npm run inventory:dispatch                                  # retries safely
```

**Must not be used** — Do not clear the outbox to "reduce backlog". Do not
disable rate limiting to reduce Redis load.

**Recovery verification** — `redis: pass`; outbox backlog returns to zero;
`distributed_rate_limit: pass`; clients reconnect and perform a full refresh.

**Escalation** — Escalate if backlog exceeds `READINESS_MAX_OUTBOX_BACKLOG` for
longer than one dispatch interval after Redis returns, or if dead letters appear.

---

## 3. Realtime gateway unavailable

**Detection** — Gateway heartbeat is `stale` or `missing` in
`/api/operations/metrics`. Browsers show the disconnected indicator.

**Immediate containment** — Restart the gateway process. No data action needed.

**Safety assumptions** — The gateway never computes availability. Clients already
fall back to focus-triggered and 30-second polling, and hold creation remains the
decisive check.

**Safe commands**

```bash
npm run realtime:gateway
```

**Must not be used** — Do not rebuild client state from Redis; do not extend
hold TTLs to compensate.

**Recovery verification** — Heartbeat returns `healthy`; a browser reconnects and
performs a full PostgreSQL refresh.

**Escalation** — Repeated crashes, or connection counts far above expectation
(possible abuse), go to the platform owner.

---

## 4. Payment provider unavailable

**Detection** — Checkout creation succeeds but intents stay `CREATED`.
`npm run payments:report` shows growing stale pending orders.

**Immediate containment** — Consider disabling new checkout entry points. Do not
touch existing orders.

**Safety assumptions** — A provider timeout leaves a retryable attempt with a
stable idempotency key; retrying produces the same intent, never a second charge.
Only a signature-verified webhook can mark an order paid.

**Safe commands**

```bash
npm run payments:report
npm run payments:reconcile -- --limit=100
npm run checkouts:expire -- --batch-size=100 --max-batches=10
```

**Must not be used** — Never mark an order paid manually. Never treat a
reconciliation "success" as fulfillment authority; it only sets
`awaitingVerifiedWebhook`.

**Recovery verification** — Pending intents resolve; no order sits in
`PAID_UNFULFILLED`; webhook processing returns 200.

**Escalation** — Any customer-visible charge without a booking escalates
immediately to the payments owner. See runbook 9.

---

## 5. Notification provider unavailable

**Detection** — Notification pending count and oldest-pending age climb in
`/api/operations/metrics`; delivery attempts record retryable failures.

**Immediate containment** — Slow or pause the dispatcher. Do not rotate ticket
credentials because email is late.

**Safety assumptions** — Delivery is strictly downstream of ticket validity. A
notification failure can never revoke, duplicate, or delay a valid ticket.

**Safe commands**

```bash
npm run tickets:report
npm run notifications:retry
npm run notifications:dispatch
```

**Must not be used** — Do not rewrite `DEAD_LETTER` rows; they are terminal
history. Do not enable `LOCAL_FILE` capture in production.

**Recovery verification** — Pending count drains; no new dead letters; delivery
duration returns to baseline.

**Escalation** — Escalate when dead letters appear or pending age exceeds the
delivery objective.

---

## 6. Ticket credential secret unavailable

**Detection** — Readiness reports `ticket_credential: invalid_configuration`.
Issuance fails; QR rendering and validation fail.

**Immediate containment** — Restore the secret from the secret manager. Do not
generate a new one.

**Safety assumptions** — A *different* secret makes every existing QR credential
and download-grant hash unverifiable. This is not recoverable by rotation alone;
it would require reissuing every active credential.

**Safe commands**

```bash
npm run production:check -- --skip-probes   # confirms presence, never prints it
npm run tickets:report
```

**Must not be used** — Never print, echo, or log the secret. Never substitute a
placeholder to "get things running".

**Recovery verification** — Issuance drains; a known ticket validates end to end
in a controlled scan.

**Escalation** — If the original value cannot be restored, escalate immediately:
this becomes a mass credential-reissue incident, not a configuration fix.

---

## 7. Ticket issuance backlog

**Detection** — `tickets.issuancePending` climbs, or `missingTickets` /
`missingCredentials` are non-zero.

**Immediate containment** — Confirm bookings are intact. Issuance failure never
invalidates payment or booking.

**Safety assumptions** — Database uniqueness guarantees one ticket per booked
seat regardless of how many times issuance runs.

**Safe commands**

```bash
npm run tickets:report
npm run tickets:issue                       # repeat until claimed=0
npm run tickets:retry -- --request-id=<internal-request-id>
```

**Must not be used** — Do not insert tickets or credentials by hand. Do not
requeue every dead letter blindly; requeue only reviewed ones, by ID.

**Recovery verification** — `pending`, `missingTickets`, and `missingCredentials`
all return to zero.

**Escalation** — Escalate if the same request dead-letters again after the
underlying cause was believed fixed.

---

## 8. Notification dead letters

**Detection** — `notifications.deadLetters > 0` in metrics or the protected
tickets health route.

**Immediate containment** — Fix provider configuration first; otherwise a replay
simply dead-letters again.

**Safety assumptions** — Dead letters are terminal, immutable history. Ticket
validity is unaffected.

**Safe commands**

```bash
npm run tickets:report
npm run notifications:dispatch
```

**Must not be used** — Do not mutate a `DEAD_LETTER` row back to `PENDING`.
Redelivery must be a new, domain-approved notification.

**Recovery verification** — No new dead letters after the next dispatch cycle.

**Escalation** — Any customer who cannot obtain their ticket goes to support with
the booking reference only — never a grant link or credential.

---

## 9. Paid but unfulfilled orders

**Detection** — `payments.paidUnfulfilled` or `requiresReview` is non-zero.
`production:check` blocks deployment on this gate.

**Immediate containment** — Freeze automated remediation. This is a
money-touching state and is resolved deliberately.

**Safety assumptions** — Payment was verified but fulfillment could not be proven
safe (hold released, session cancelled, or amount/ancestry contradiction). The
system deliberately refuses to invent a booking.

**Safe commands**

```bash
npm run payments:report
npm run payments:webhook:reprocess -- --event-id=<internal-webhook-id>
```

**Must not be used** — Never fabricate a booking to clear an alert. Never
reprocess an unverified webhook. Phase 5C1 has no refund path.

**Recovery verification** — The order reaches `FULFILLED` with exactly one
booking and the expected booked seats, or it remains in review with a recorded
decision.

**Escalation** — Every occurrence escalates to the payments owner with the safe
order reference and failure code.

---

## 10. Duplicate webhook storm

**Detection** — A spike in `api_payments` request count with flat booking counts.

**Immediate containment** — None. This is a designed-for condition.

**Safety assumptions** — `(provider, providerEventId)` uniqueness plus row locks
make fulfillment exact-once. This is verified continuously by the load harness,
which delivers 16 concurrent duplicates and asserts exactly one booking.

**Safe commands**

```bash
npm run payments:report
npm run load:test          # local only; re-proves the invariant
```

**Must not be used** — Do not disable the webhook route; a dropped delivery is
worse than a duplicated one.

**Recovery verification** — Booking count per order remains exactly one.

**Escalation** — Escalate only if a second booking ever appears for one order.

---

## 11. Scanner abuse or credential brute force

**Detection** — `validation.unauthorizedScannerAttempts` or
`duplicateScanAttempts` spikes; `rateLimitRejections` rises for
`ticket.validate`.

**Immediate containment** — Identify the scanner account through the audit trail
and suspend it. Tighten the limit if required.

**Safety assumptions** — A credential is an opaque HMAC derivation; only its
keyed hash is stored, comparison is constant-time, and acceptance additionally
requires the single-accepted-redemption index to be free. A rate-limit bypass
cannot forge acceptance. Authorization is resolved against the target session
*before* any credential lookup.

**Safe commands**

```bash
curl -sS https://<host>/api/operations/metrics   # as platform admin
npm run tickets:manage -- --action=rotate --ticket-reference=<ref> --actor-email=<authorized>
```

**Must not be used** — Do not lower authorization to "let the door move". Do not
log submitted credentials while investigating.

**Recovery verification** — Unauthorized attempts return to baseline; accepted
redemptions remain exactly one per ticket.

**Escalation** — Suspected credential disclosure follows runbook 12.

---

## 12. Suspected secret exposure

**Detection** — A secret appears in a log, ticket, screenshot, repository, or
third-party system.

**Immediate containment** — Treat as compromised. Rotate in the secret manager
under the owning team's procedure.

**Safety assumptions** — Rotation impact differs per secret:
`BETTER_AUTH_SECRET` invalidates sessions and realtime room tickets;
`TICKET_CREDENTIAL_SECRET` invalidates every QR credential and download grant;
the payment webhook secret must be rotated through the provider's overlap
window.

**Safe commands**

```bash
npm run production:check -- --skip-probes    # confirms strength, never prints values
npm run tickets:manage -- --action=rotate --ticket-reference=<ref> --actor-email=<authorized>
```

**Must not be used** — Do not `echo` or `cat` the secret to confirm it. Do not
reuse one secret for another purpose; `production:check` blocks that.

**Recovery verification** — New secret in place, `production:check` passes its
secret checks, affected credentials rotated, exposure source removed.

**Escalation** — Always. Secret exposure is a security incident, not an
operational one.

---

## 13. Migration failure

**Detection** — `npx prisma migrate status` reports a pending or failed
migration; readiness reports `migrations: incomplete_migration` or
`database_behind_code`.

**Immediate containment** — Stop the rollout. Do not deploy further instances.

**Safety assumptions** — Migrations are append-only. Code that expects a newer
schema must not receive traffic, which is why readiness fails rather than warns.

**Safe commands**

```bash
npx prisma migrate status
npm run db:migrate:deploy
```

**Must not be used** — `migrate reset`, `migrate dev`, and `db push` against any
non-disposable database. Never hand-edit `_prisma_migrations`.

**Recovery verification** — `migrate status` reports up to date; readiness
`migrations: pass`.

**Escalation** — A partially applied migration escalates to the database owner
before any further attempt.

---

## 14. Bad deployment rollback

**Detection** — Error rate rises after a release; `5xx` climbs in
`/api/operations/metrics`.

**Immediate containment** — Roll the application back to the previous release.

**Safety assumptions** — Migrations are additive and forward-only. Rolling code
back is safe; rolling the *schema* back is not, and is never done as an incident
action.

**Safe commands**

```bash
npm run production:check
curl -sS https://<host>/api/health/ready
```

**Must not be used** — Never revert a migration to match rolled-back code. If old
code cannot run against the new schema, fix forward.

**Recovery verification** — Error classes return to baseline; readiness `ready`;
no new paid-unfulfilled orders or dead letters.

**Escalation** — Escalate if rollback requires a schema change.

---

## 15. Database restore

**Detection** — Confirmed data loss or corruption requiring recovery.

**Immediate containment** — Stop writes to the affected database. Take a fresh
backup of the damaged state before touching anything; it is evidence.

**Safety assumptions** — Restore is destructive. Tooling refuses any target whose
name is not marked disposable and any target matching `DATABASE_URL` or
`DIRECT_URL`, and requires `--confirm`.

**Safe commands**

```bash
npm run backup:create -- --out <directory outside the repo>
npm run backup:verify -- --file <dump> --target <disposable url> --confirm
```

**Must not be used** — Never restore directly over production without a verified
rehearsal. Never store a backup inside the repository; the tooling refuses it.

**Recovery verification** — Integrity, restore, migration compatibility, and
critical row counts all pass. Then reconcile: outbox, issuance, and notification
backlogs are drained before reopening traffic.

**Escalation** — Always involve the database owner and record the recovery point
actually achieved, not the one targeted.

---

## 16. Loss of local worker processes

**Detection** — One or more worker heartbeats are `stale` or `missing`. Backlogs
grow without an obvious dependency failure.

**Immediate containment** — Restart the missing processes.

**Safety assumptions** — Every worker is idempotent and partitions work with
`FOR UPDATE SKIP LOCKED`. Restarting, or running several instances, is safe.
A stopped worker delays delivery; it never corrupts state.

**Safe commands**

```bash
npm run inventory:dispatcher
npm run holds:worker
npm run realtime:gateway
npm run tickets:issue
npm run notifications:dispatch
npm run payments:reconcile -- --limit=100
```

**Must not be used** — Do not clear queues to make a backlog "go away". Do not
disable heartbeats to silence an alert.

**Recovery verification** — Every declared worker reports a fresh heartbeat and
every backlog trends to zero.

**Escalation** — Escalate if a worker restarts repeatedly, or if a backlog keeps
growing while the worker reports healthy.
