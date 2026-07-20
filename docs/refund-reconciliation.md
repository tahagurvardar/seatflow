# Refund reconciliation

Reconciliation answers one question: does what the provider believes match what
PostgreSQL believes? Everything here is idempotent and read-mostly.

## What reconciliation may not do

There is deliberately **no** command that can mark a refund succeeded, create or
close a dispute, issue an unrestricted manual adjustment, or edit the ledger. A
command that could do any of those would be a way to move money without a
provider ever confirming it — which is precisely the authority this phase keeps
with verified webhooks.

## What it may do

| Operation | Behaviour |
|---|---|
| `reconcileAmbiguousRefunds` | Asks the provider what exists under our own precommitted idempotency key. May only **adopt** an external refund identifier; the refund stays `PROCESSING` and still waits for a verified webhook to settle. |
| `reconcileUnprocessedWebhooks` | Replays webhook records that were verified and stored but never reached a terminal processing state — what a crash between storing and processing leaves behind. |
| `detectFinancialDivergence` | Compares the append-only ledger against stored aggregates. Reports only. |
| `detectTicketRevocationBacklog` | Finds refunded bookings still holding an active ticket. |
| `raiseDivergenceForReview` | Emits a deduplicated reconciliation event per payment and reason. |
| `retrySafeNotificationFailures` | Makes back-off-delayed notifications available again. Dead-lettered rows are left alone: they failed permanently and need a human. |

## Reports

`reportRefundBacklog` and `reportDisputeBacklog` return bounded counts only —
statuses, totals, and ages. No reference, id, email, or provider identifier
appears in either.

```
refunds:  requested / submitting / processing / requiresReview / failed
          + oldestPendingAgeSeconds
disputes: open / needsResponse / underReview / lost / requiresReview
          + evidenceDueWithin48Hours
```

## The ambiguous-timeout case

This is the case reconciliation exists for.

When a provider accepts a refund request and then the connection breaks, the
external outcome is genuinely unknown. The refund is **not** failed — failing it
would let a retry create a second external refund and pay the customer twice.
Instead it stays `PROCESSING` and a `FINANCIAL_RECONCILIATION_REQUIRED` event is
raised.

Reconciliation then lists the provider's refunds for that payment and matches on
amount against refunds not already adopted locally. Because the idempotency key
was committed **before** the call, the provider created at most one refund under
it, so adoption is unambiguous.

If nothing matches, the refund is reported as still unknown rather than
resolved. Guessing here would be guessing about someone's money.

## Divergence is never auto-corrected

The ledger is append-only and the payment aggregates are trigger-maintained, so
neither can be "fixed" by a script. A divergence means one of them is telling
the truth and something else went wrong — which is a human's problem, not a
retry's.

`production:check` treats any divergence as a hard deployment block.

## Suggested cadence

| Command | Cadence |
|---|---|
| Submit pending refunds | continuous worker |
| Reconcile ambiguous refunds | every 5–15 minutes |
| Reconcile unprocessed webhooks | every 5 minutes, for records older than 60s |
| Detect divergence | hourly, and before every deploy |
| Ticket revocation backlog | hourly |

The `REFUND_RECONCILIATION` and `FINANCIAL_OUTBOX_DISPATCHER` worker types
report liveness through the Phase 5C1 `WorkerHeartbeat` table, so a stopped
reconciler becomes visible in readiness without any Redis dependency.

## Related

- [Refunds and disputes](refunds-and-disputes.md)
- [Financial ledger](financial-ledger.md)
