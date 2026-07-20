# Refunds and disputes

Phase 5C2A. This document describes how money goes back to a customer, what
that does to their tickets, and what happens when a provider disagrees with us.

## The one rule everything else follows

**Only a cryptographically verified provider webhook can settle money.**

A browser redirect cannot. A client response cannot. An organizer action cannot.
Redis cannot. Even the provider's own reply during refund submission cannot —
that reply is a receipt, not authority. The only code path that may set
`Refund.succeededAt` is `settleRefundFromVerifiedEvent`, reached exclusively
after a signature check over the exact raw request bytes.

## A refund never rewrites the original payment

Refunding is additive. `PaymentAttempt.amountMinor`, `succeededAt`, and
`Booking.totalMinor` are what the customer actually paid, and they stay that way
forever. A refund creates new, independently auditable rows plus append-only
ledger entries. Database triggers reject any attempt to edit the original
payment or booking financial snapshot.

This means "paid" and "refunded" are separately answerable questions, which is
exactly what an auditor, a dispute response, and a support conversation all
need.

## Over-refunding is prevented by PostgreSQL, not by careful callers

Two aggregates live on `PaymentAttempt`:

- `refundedMinor` — refunds that actually succeeded
- `inFlightRefundMinor` — refunds still reserved against the payment

Both are maintained by a trigger on `Refund`, never by application code. Every
refund write therefore issues an `UPDATE` against the parent payment row, which
takes a row lock and **serializes all concurrent refund creation for that
payment**. A `CHECK` constraint then enforces:

```
refundedMinor + inFlightRefundMinor <= amountMinor
```

The consequence is that over-refunding is impossible even if a caller forgets to
lock anything, and even under contention. The integration suite drives sixteen
simultaneous refund requests at one payment and asserts the totals never exceed
what was captured.

`succeededAt`, not `status`, decides what counts as refunded — so a refund
escalated to `REQUIRES_REVIEW` after succeeding is never counted twice.

## Amounts are always calculated on the server

Callers pass a booking reference, a scope, and at most a set of booking-seat
identifiers. They never pass an amount, a currency, a provider, or a status.

Prices come from the immutable `BookingSeat` snapshots captured at purchase, not
from current event pricing. A seat repriced after the sale does not change what
its buyer gets back.

Scopes:

| Scope | Amount |
|---|---|
| `FULL_BOOKING` | Every not-yet-refunded seat, capped at remaining capacity |
| `SELECTED_SEATS` | Exactly the named seats, validated for ownership |
| `FIXED_AMOUNT` | An operator-approved amount, still bounded by capacity |

A booking seat can never be refunded twice. A trigger rejects a second
`RefundSeat` for a seat already covered by a live or succeeded refund; failed
and cancelled refunds release their seats so a retry stays possible.

## Submission never holds a database lock

The ordering in `submission-service.ts` is the whole point:

1. The refund already exists with a **deterministic provider idempotency key**,
   committed before anything leaves the process.
2. Claim it (`REQUESTED` → `SUBMITTING`) in a short transaction. The claim is
   what stops two workers submitting the same refund.
3. Call the provider **with no row lock held**. An external HTTP call inside a
   transaction pins a lock for the duration of someone else's network.
4. Record the outcome in a second short transaction.

Because the key is committed before step 3, every failure mode converges:

| Failure | Behaviour |
|---|---|
| Provider timeout after accepting | Refund stays `PROCESSING`, **not** failed, and is raised for reconciliation. Failing it here would let a retry create a second external refund. |
| Crash between 3 and 4 | Reconciliation adopts the external refund found under our own key. |
| Clean provider rejection | Refund fails, reservation is released, seats become refundable again. No success entry of any kind is written. |

## Refund lifecycle

```
REQUESTED → SUBMITTING → PROCESSING → SUCCEEDED
                              ↓            ↓
                           FAILED   REQUIRES_REVIEW
```

`REQUIRES_REVIEW` is a one-way escalation that **preserves** whatever outcome
was already recorded. When a provider reports success and then failure for one
refund, the first result survives and the refund freezes for a human — because
the money either moved or it did not, and a provider contradicting itself is not
a state machine we may follow.

Out-of-order delivery is handled by comparing the provider's own event timestamp
against the outcome already applied. A late `processing` after settlement is
dropped as stale, not replayed over fresher state.

## Ticket and inventory consequences

Refunding money revokes the admission it paid for. It does not rewrite history.

| Rule | Behaviour |
|---|---|
| Partial refund | Only the refunded seats' tickets are revoked; booking stays `CONFIRMED` |
| Full refund | Booking moves to terminal `REFUNDED`; all active tickets revoked |
| Used ticket | Stays `USED`, keeps its redemption history, is never revoked |
| Credentials | Revoked with the ticket so the QR stops validating; rows preserved |
| Inventory | **Never** returns to `AVAILABLE` |
| Deletion | Nothing is deleted — not bookings, seats, tickets, credentials, or ledger rows |

Inventory staying `BOOKED` is enforced by the Phase 5A trigger, which makes
`BOOKED` terminal. Nothing in this phase weakens it. Releasing a refunded seat
back to sale is deliberately left to a future controlled resale phase; doing it
automatically would let a refund silently resell a seat whose holder may still
be disputing.

## Disputes and chargebacks

A dispute exists **only** because a verified provider webhook created it. There
is deliberately no function an organizer, admin, or browser request can reach
that opens, advances, or closes one — fabricating a dispute would fabricate a
reason to revoke a customer's tickets.

| Status | Ticket consequence |
|---|---|
| `OPEN` / `NEEDS_RESPONSE` / `UNDER_REVIEW` | None. Booking is flagged for review; the customer may still attend and the platform may still win. |
| `LOST` | Unused tickets revoked, chargeback ledger entry written |
| `WON` | Credit entry; admission unaffected |

The first terminal outcome is permanent. A provider reporting `WON` then `LOST`
escalates the dispute to `REQUIRES_REVIEW` with the original outcome intact, and
critically **does not** record a chargeback.

`PaymentDisputeEvent` is append-only normalized history, unique on
`(disputeId, providerEventId)`. Raw evidence documents and provider payloads are
deliberately not stored in this phase.

## Refund and dispute overlap

A customer already refunded who then also wins a chargeback would be compensated
twice for the same seat. This is detected — never auto-resolved — and raises the
order to `CHARGEBACK_REVIEW` with a reconciliation event. Deciding what to do
about double compensation is a human judgement, not a rule a script should apply
to someone's money.

## Exact-once webhook processing

Payment, refund, and dispute events all share one `PaymentWebhookEvent` table.
That is deliberate: a single unique `(provider, providerEventId)` constraint gives
exact-once replay protection across **every** financial event type, so a refund
event and a payment event can never collide or be double-processed.

Defence is layered:

1. Unique provider event id — a duplicate delivery never reaches processing.
2. Row lock on the webhook record — concurrent deliveries serialize.
3. Deterministic ledger idempotency keys — even a repeat that got through could
   not write a second entry.
4. The webhook is marked processed **only inside the transaction that applied
   the change**, so a failure leaves it retryable rather than recorded as done.

Sixteen simultaneous duplicate success webhooks produce exactly one settlement
and one ledger entry. This is covered by the integration suite.

## What has no command

There is intentionally **no** operational command that can:

- mark a refund succeeded
- create or close a dispute
- issue an unrestricted manual financial adjustment
- edit or delete a ledger entry

Reconciliation may only *adopt* an external refund the provider already created
under our own precommitted key, replay verified-but-unprocessed webhooks, and
report divergence. Anything else would be a way to move money without a provider
ever confirming it.

## Related

- [Financial ledger](financial-ledger.md)
- [Provider secret rotation](provider-secret-rotation.md)
- [Refund reconciliation](refund-reconciliation.md)
- [Phase 5C2A external providers](phase-5c2a-external-providers.md)
