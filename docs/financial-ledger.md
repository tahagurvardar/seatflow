# Financial ledger

`FinancialLedgerEntry` is the append-only record of everything that happened to
money on this platform. It is what an auditor reads, what reconciliation
compares against, and what a dispute response is built from.

## Append-only means append-only

A database trigger rejects **every** `UPDATE` and `DELETE` on the table. There is
no privileged path, no admin override, and no repair script. The integration
suite asserts both operations are refused.

This is deliberate. A ledger you can edit is a ledger that tells you what
someone wanted to be true, not what happened. When the ledger disagrees with
another table, the answer is always investigation, never correction.

## Entry types and direction

Direction is fixed per entry type in code *and* enforced by a `CHECK`
constraint, so a refund can never be recorded as a credit that quietly cancels
out the original capture.

| Entry type | Direction | Settling |
|---|---|---|
| `PAYMENT_AUTHORIZED` | CREDIT | no |
| `PAYMENT_CAPTURED` | CREDIT | **yes** |
| `PAYMENT_FAILED` | DEBIT | no |
| `REFUND_REQUESTED` | DEBIT | no |
| `REFUND_PROCESSING` | DEBIT | no |
| `REFUND_SUCCEEDED` | DEBIT | **yes** |
| `REFUND_FAILED` | CREDIT | no |
| `REFUND_CANCELLED` | CREDIT | no |
| `DISPUTE_OPENED` | DEBIT | no |
| `DISPUTE_UPDATED` | DEBIT | no |
| `DISPUTE_WON` | CREDIT | no |
| `DISPUTE_LOST` | DEBIT | **yes** |
| `CHARGEBACK_RECORDED` | DEBIT | **yes** |
| `MANUAL_ADJUSTMENT_REQUESTED` | DEBIT | no |

Only **settling** entries count towards a balance. A pending refund request is
recorded so the intent is auditable, but it must never look like money that has
already moved.

## Idempotency

Every entry carries a deterministic `idempotencyKey` built from its type plus
the thing that caused it — a provider event id, a refund id, or a dispute id:

```
REFUND_SUCCEEDED:<providerEventId>
```

Writes use `skipDuplicates`, so two concurrent deliveries of the same provider
event race to insert the same key and exactly one row survives regardless of
which wins. Duplicate webhook delivery is therefore a no-op at the storage
layer, not a matter of timing.

## Provider references are hashed, never stored

`providerReferenceHash` is a SHA-256 of the provider identifier. The raw
reference is never written to the ledger, so an operator can read the full
financial history without any provider identifier being exposed to them.

## What is never in a ledger row

- customer email or name
- payment method details of any kind
- raw provider payloads or full provider objects
- webhook signatures
- ticket credentials or their hashes
- connection strings
- unbounded provider metadata

`safeMetadata` carries only bounded, non-identifying fields such as a scope or a
safe failure code, versioned by `metadataVersion`.

## Ancestry is enforced

A trigger validates on insert that the entry's order matches its payment
attempt's order, that provider and currency match the payment, that any booking
belongs to the same order, and that any linked refund or dispute belongs to the
same payment attempt. A ledger entry cannot be attached to the wrong payment
even by a buggy caller.

Additional `CHECK` constraints require that refund-typed entries carry a
`refundId` and dispute-typed entries carry a `disputeId`.

## Divergence detection

`detectLedgerDivergence` compares the settled ledger balance against the stored
aggregates:

```
expected = capturedMinor - refundedMinor
actual   = sum(settling credits) - sum(settling debits)
```

Any non-zero difference is an alarm. `production:check` treats **any** divergence
as a hard deployment block, because deploying on top of books that do not add up
is how a small discrepancy becomes an unauditable one.

Reconciliation reports divergence and raises it for review. It never adjusts
anything — the ledger cannot be rewritten, and the aggregates are
trigger-maintained, so a divergence means something needs a human.

## Related

- [Refunds and disputes](refunds-and-disputes.md)
- [Refund reconciliation](refund-reconciliation.md)
