# Phase 5C2A — external provider adapters

## Verification status: sandbox testing NOT performed

**No Stripe or Resend sandbox credentials were available in this environment.**

Concretely, that means:

| Claim | Status |
|---|---|
| Stripe adapter compiles and typechecks | yes |
| Stripe adapter exercised against real Stripe test mode | **no — not performed** |
| Resend adapter compiles and typechecks | yes |
| Resend adapter exercised against real Resend | **no — not performed** |
| Local provider contracts pass | yes |
| Any real-money charge made | **no** |
| Any real customer email sent | **no** |
| `production:check` passing | **no — correctly blocked** |

Both adapters are written against the official SDKs (`stripe`, `resend`) and are
type-checked, but their network behaviour is unverified. **Do not treat either
as production-ready.** Sandbox verification against real test-mode credentials
is a Phase 5C2B gate.

## External providers are disabled by default

An adapter is constructed only when it is *explicitly selected* and *fully
configured*. A credential sitting in the environment is never enough on its own,
so a leftover key cannot quietly switch a deployment onto a live payment network
or start sending real email.

```
PAYMENT_PROVIDER=LOCAL_SIGNED        # default; forbidden in production
PAYMENT_PROVIDER=STRIPE              # requires key + webhook secret + explicit mode

NOTIFICATION_PROVIDER=LOCAL_FILE     # default; forbidden in production
NOTIFICATION_PROVIDER=RESEND         # requires key + sender identity + explicit mode
```

`STRIPE_MODE` and `RESEND_MODE` have **no default**. The mode must be stated, never
inferred, and `production:check` rejects a live mode holding a test key, a test
mode holding a live key, and test mode reaching production traffic at all.

## The provider boundary

`payment-provider.ts` defines provider-neutral types. **No Stripe object, Resend
object, or raw provider payload crosses it.** A provider change cannot reach into
domain services, and a provider field can never be trusted merely because it
arrived in a familiar shape.

Capabilities are *reported*, not assumed, so an operator can see before enabling
traffic whether partial refunds, dispute events, or secret rotation are actually
available.

An event type this build does not model normalizes to `UNSUPPORTED` rather than
being guessed at — an unknown provider event can never be interpreted as a
financial outcome.

### Stripe adapter specifics

- API version pinned to `2026-06-24.dahlia` so a Stripe-side default change
  cannot silently alter what is normalized.
- `maxNetworkRetries: 0` — retries are the platform's decision, driven by its own
  idempotency keys, not the SDK's.
- Signature verification uses Stripe's own `constructEvent`; it is never
  reimplemented.
- Errors reduce to bounded safe codes. Stripe messages can quote request
  parameters, so the message is dropped rather than forwarded.
- Only a non-identifying `orderReference` is sent as metadata. No customer email,
  name, seat, or internal user id ever leaves the platform.

### Resend adapter specifics

- In **test mode every message is redirected** to one approved test recipient, so
  a misconfigured non-production deployment cannot email a real customer. The
  intended recipient survives only as a short non-reversible digest in the
  subject.
- Failures are classified retryable vs permanent. Retrying a permanent failure
  forever would hide a broken message behind a growing attempt count.
- Sends carry an idempotency key, so a dispatcher retry after an ambiguous
  timeout cannot produce a second real email.

## Content that may never be emailed

Enforced centrally in `validateOutgoingMessage`, so a new template cannot quietly
introduce a leak:

- ticket credentials (`SFT1.…`)
- provider secret keys, webhook secrets, notification API keys
- database or Redis connection strings
- embedded base64 QR images
- any permanent ticket-bearing URL — retrieval links are short-lived single-use
  grants

Recipient and subject are validated against CR/LF and tab injection. A recipient
carrying a newline could otherwise append its own headers to the outgoing
message.

## Migration

One chronological migration: `20260719120000_phase_5c2a_refunds_disputes_ledger`.

Verified:

- full 10-migration chain replays cleanly on `seatflow_test`
- non-destructive deploy to the development `seatflow` database
- all existing rows intact; both paid-but-unfulfilled orders still visible
- existing webhook rows correctly defaulted to `eventCategory = PAYMENT`
- the development database was never reset
- no previous migration was edited

One note on `Booking_refund_lifecycle_check`: it compares `"status"::text`
deliberately. PostgreSQL forbids using an enum value added earlier in the same
transaction, and `REFUNDED` is added by this migration, so an enum-typed literal
would fail on a fresh replay of the chain.

## Known pre-existing drift (not introduced here)

`prisma migrate diff` reports two index renames on `InventoryEventOutbox` and
`NotificationDeliveryAttempt`. These come from Phases 4B and 5B creating index
names longer than PostgreSQL's 63-byte identifier limit, which PostgreSQL then
truncated. The drift predates this phase, is cosmetic, and was deliberately
**not** included — fixing it would mean touching earlier phases' artifacts for no
correctness gain.

## Phase 5C2B remains required

Phase 5C2A is not a launch. Everything below is deployment work that this phase
deliberately did not attempt:

1. Real Stripe test-mode sandbox verification against a real test account
2. Real Resend sandbox verification to an approved internal test recipient only
3. Staging deployment
4. Live-traffic runbook rehearsal
5. The launch decision

Delivered in 5C2A and no longer outstanding: the customer, organizer, and
platform-admin financial UI; authenticated browser verification including the
full refund lifecycle, 390×844, and 320 CSS px reflow; the documentation set;
and a sanitized production-like `production:check` that reports no findings.

That sanitized pass validates only that the configuration rules are
*satisfiable* — the values are synthetic and it is **not** provider
verification.

## Related

- [Refunds and disputes](refunds-and-disputes.md)
- [Financial ledger](financial-ledger.md)
- [Provider secret rotation](provider-secret-rotation.md)
- [Refund reconciliation](refund-reconciliation.md)

## Authenticated browser verification

The Playwright suite runs against a production build, pointed at the disposable
test database, and drives a complete authenticated refund lifecycle:

1. The synthetic customer signs in through the real login form (real Better Auth
   session; nothing is forged).
2. They open their own paid booking and see the server-calculated refundable
   amount.
3. Injected financial fields (`amountMinor`, `currency`, `provider`, `status`,
   `organizationId`, `userId`) have no effect — the server action reads named
   fields only, so they are never consulted.
4. A replayed submission creates no second refund.
5. The refund shows Requested/Processing, and no URL parameter, redirect, or
   client navigation can move it to Succeeded.
6. Settlement happens only when a validly signed LOCAL_SIGNED event reaches the
   application's own raw-body webhook route.
7. A forged signature is refused and changes nothing.
8. A duplicate valid delivery settles nothing twice — verified by exactly one
   `REFUND_SUCCEEDED` ledger entry despite multiple stored webhook rows.
9. The booking becomes REFUNDED, unused tickets are revoked, a USED ticket keeps
   its history, and inventory stays BOOKED.

The `LOCAL_SIGNED` provider is permitted under that production build only
through the isolated-E2E predicate documented in
[security.md](security.md#the-isolated-end-to-end-test-exception), which
requires a test-marked database, loopback origins, synthetic secrets, and the
absence of any real provider credential. `production:check` rejects the flag
outright.
