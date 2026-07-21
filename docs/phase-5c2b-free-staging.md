# Phase 5C2B — Free serverless staging

This phase makes SeatFlow deployable to a **free, hosted, internet-reachable
staging environment** without weakening any rule that protects real production.

It is a demo. It cannot take a real payment, and it may only email one approved
address. Both facts are enforced in code and stated to visitors in the UI.

## What changed, and what deliberately did not

The Phase 4B/5B/5C worker architecture is untouched. Every BullMQ worker, the
Socket.IO gateway, and every CLI dispatcher still exist, still work, and are
still the local and production-grade path. What Phase 5C2B adds is a second
*trigger* for the same bounded operations.

That was possible because those operations were already written the right way:
`sweepExpiredHolds`, `dispatchInventoryEventBatch`, `dispatchNotificationBatch`,
`processTicketIssuanceBatch`, and `reconcileAmbiguousRefunds` are all bounded,
idempotent, one-shot functions. BullMQ was only ever a scheduler wrapped around
them. Replacing the scheduler therefore changed no business logic at all.

```
worker mode (local, production)        serverless mode (free staging)
──────────────────────────────         ──────────────────────────────
BullMQ scheduler                       QStash cron schedule
  → resident Worker process              → signed HTTPS delivery
    → sweepExpiredHolds(db)                → /api/internal/jobs/<job>
                                             → verify signature
                                             → claim delivery receipt
                                             → sweepExpiredHolds(db)
```

Both paths call the same function against the same authoritative database.

## The architecture

| Concern | Service | Tier |
|---|---|---|
| Web + API | Vercel | Hobby |
| Database | Neon PostgreSQL | Free |
| Cache, streams, rate limits | Upstash Redis | Free |
| Job scheduling | Upstash QStash | Free |
| Email | Resend | Free, test mode |
| Payments | `LOCAL_SIGNED` | Simulated, no account |

There is no continuously running process anywhere in this deployment, and no
paid component.

## PostgreSQL remains the only authority

Unchanged from Phase 4B, and load-bearing for everything below: PostgreSQL is
authoritative for inventory, holds, payments, bookings, refunds, disputes,
tickets, the ledger, webhook processing, and outbox state.

Redis and QStash are **never** financial or inventory authority:

- A job payload names an operation and, at most, a batch size. It carries no
  actor, organization, payment, refund, booking, or ticket fact — every one of
  those is read from PostgreSQL inside the handler. This is enforced by a strict
  schema that *rejects* unknown keys rather than ignoring them, so a payload
  attempting to smuggle `bookingId` or `amountMinor` fails loudly.
- If Redis is unavailable, inventory events are not delivered and clients fall
  back to polling. Correctness is unaffected.
- If QStash stops delivering, scheduled work stops. Nothing becomes wrong; work
  is delayed, and the stale heartbeats make it visible.

## Deployment profiles

Four worlds, with different rules:

| Profile | Simulated payments | Redirected email | Serverless jobs | Demo banner |
|---|---|---|---|---|
| `local` | yes | yes | yes | yes |
| `isolated-e2e` | yes | yes | yes | no |
| `staging-demo` | **yes** | **yes** | **yes** | **yes** |
| `production` | no | no | no | no |

Set by `SEATFLOW_DEPLOYMENT_PROFILE`. When unset, a production build resolves to
**`production`** — the strictest world. Forgetting to declare a profile fails
closed, never open.

### The staging-demo guard

`staging-demo` is the profile that permits `LOCAL_SIGNED` on a production build,
so it is granted the same way the isolated-E2E override is: every condition must
hold, and the evaluator returns the first refusal.

1. `SEATFLOW_DEPLOYMENT_PROFILE=staging-demo`
2. `NODE_ENV=production`
3. **Both** `BETTER_AUTH_URL` and `NEXT_PUBLIC_APP_URL` are https and on
   `*.vercel.app` (or the declared `SEATFLOW_STAGING_ORIGIN`)
4. `PAYMENT_PROVIDER=LOCAL_SIGNED`
5. `LOCAL_PAYMENT_WEBHOOK_SECRET` is present and ≥ 32 characters
6. No `STRIPE_SECRET_KEY` and no `STRIPE_WEBHOOK_SECRET_CURRENT`
7. No `STRIPE_MODE=live` and no `RESEND_MODE=live`
8. No `SEATFLOW_PRODUCTION_LAUNCH=true`

A deployment that *claims* `staging-demo` but fails any condition is classified
as **production**, not downgraded to something permissive — so it is refused the
simulated provider entirely rather than silently granted it.

See [`deployment-profile.ts`](../src/features/operations/deployment-profile.ts).

## Serverless job delivery

One route handles every job: `POST /api/internal/jobs/[job]`. A single route
means one signature implementation, one body bound, one replay guard, and one
error mapping — rather than seven near-identical copies that can drift.

| Job | Operation | Cadence |
|---|---|---|
| `inventory-outbox-dispatch` | publish pending inventory events | 2 min |
| `hold-expiry-sweep` | expire holds, release seats | 2 min |
| `ticket-issuance-dispatch` | issue tickets for confirmed bookings | 5 min |
| `notification-dispatch` | deliver queued email | 5 min |
| `refund-reconciliation` | adopt provider refund ids | hourly |
| `stale-webhook-reconciliation` | replay stuck verified webhooks | hourly |
| `ticket-revocation-audit` | escalate refunded-but-admissible bookings | hourly |

None of these cadences is a correctness deadline. Every operation is idempotent
and PostgreSQL is authoritative between runs, so a missed tick delays work
rather than losing it.

### Why the revocation job audits instead of revoking

`revokeTicket` requires an authorized actor and writes a permanent audit event
naming them. A scheduled delivery has no actor. Inventing one would put a
fabricated identity on an audit record for an action that invalidates someone's
admission — so the job **detects and escalates** through the financial outbox,
and a person performs the revocation.

## Request handling order

Deliberate, and it matters:

1. Bound the declared `content-length`
2. Confirm `SEATFLOW_JOB_MODE=serverless`
3. Verify the QStash signature over the **exact raw bytes**
4. Only then parse, against a strict schema
5. Confirm the path and the body name the same job
6. Claim a delivery receipt (duplicate → 200, no work)
7. Run the bounded operation
8. Record the outcome and a worker heartbeat

Verifying before parsing is the part that matters: a parser is a much larger
attack surface than a MAC comparison, and running it on unverified bytes would
expose it to anyone who can reach the URL.

## At-least-once delivery

QStash redelivers on timeout and on any non-2xx. The `JobDeliveryReceipt` table
makes a repeat cheap and visible rather than merely safe:

- **Completed** receipt → the delivery is a duplicate; return 200, run nothing.
- **Uncompleted** receipt → a prior attempt died mid-batch; claim it again and
  re-run the idempotent operation.
- A **retryable** failure deliberately leaves the receipt uncompleted, so the
  retry actually does something. Marking it completed would strand the work.
- A **permanent** failure answers **200**, not 5xx: QStash retries any non-2xx,
  so answering 5xx would redeliver a hopeless job until its budget ran out and
  bury the real fault under retry noise.

Deleting this table costs visibility and duplicate suppression, never
correctness — every job would simply run again, correctly.

## Free-tier limits and what they cost

| Limit | Consequence |
|---|---|
| Vercel Hobby: no resident process | No BullMQ worker, no Socket.IO gateway. Jobs are HTTP; realtime is polling. |
| Vercel Hobby: 60s function ceiling | Batches are bounded by size and `maxBatches`, so the runtime never decides where a batch stops. |
| Vercel Hobby: cold starts | First request after idle is slow. Not a correctness issue. |
| Neon Free: connection limit | Runtime **must** use the pooled URL. Migrations **must** use the direct URL. |
| Neon Free: scale-to-zero | First query after idle may take seconds. |
| Upstash Free: daily command budget | REST preferred; rate limiting degrades to per-process counters if exhausted. |
| QStash Free: daily message budget | Cadences above are deliberately conservative. |
| Resend Free: no custom domain | Sender must stay on `resend.dev`; only the approved recipient may receive. |

**There is no commercial SLA on any component.** This environment may be slow,
may be briefly unavailable, and may be reset. Do not put anything in it you are
not willing to lose.

## What this environment cannot do

- Take a real payment. There is no payment account of any kind.
- Email anyone except `RESEND_TEST_RECIPIENT`.
- Serve a custom domain.
- Run a WebSocket gateway.
- Be treated as evidence that real production is ready. Sanitized configuration
  validation is not provider verification.

## Related documents

- [Vercel staging](./vercel-staging.md) — project setup, env import, deployment
- [Neon staging](./neon-staging.md) — pooled vs direct, migration safety
- [Upstash and QStash](./upstash-qstash.md) — job model, signing, rotation
- [Resend staging](./resend-staging.md) — recipient redirection, verification
- [Deployment process matrix](./deployment-process-matrix.md)
- [Security](./security.md) · [Architecture](./architecture.md)
