# Resend in staging

The staging demo sends email through a **real** provider, because a simulated
one proves nothing about deliverability, idempotency, or error classification.
What makes that safe is that no real customer can receive anything.

## Test mode redirects everything

With `RESEND_MODE=test`, `ResendNotificationProvider` redirects **every** message
to `RESEND_TEST_RECIPIENT`, whatever the intended recipient was. There is no
code path in test mode that puts a customer address in an outbound envelope.

The intended recipient survives only as an 8-character SHA-256 prefix in the
subject:

```
[test 3f9a1c7e] Your SeatFlow tickets
```

That is enough to correlate a message with the booking that produced it and not
enough to recover the address.

Two independent things enforce this:

1. The environment schema requires `RESEND_TEST_RECIPIENT` whenever
   `RESEND_MODE=test`, so test mode cannot exist without a redirect target.
2. The staging-demo profile guard refuses `RESEND_MODE=live` outright.

Real production refuses `RESEND_MODE=test` for the mirror-image reason: it would
mean no customer ever received anything.

## No custom sending domain

There is no verified domain for this project, so the sender must stay on Resend's
onboarding address:

```
RESEND_FROM_ADDRESS=SeatFlow <onboarding@resend.dev>
```

That display-name form is an RFC 5322 mailbox and is what every provider
expects. Phase 5C2A validated senders with the *recipient* rule, which requires
a bare `local@domain` — so this correct value could not boot. Senders now parse
through [`sender-address.ts`](../src/features/notifications/sender-address.ts),
which accepts both forms while keeping recipients strictly bare.

The display name remains bounded and stripped of anything that could restructure
a header: CR, LF, tab, angle brackets, quotes, commas, semicolons.

## What never leaves the platform

Enforced centrally in `validateOutgoingMessage`, so a new template cannot quietly
introduce a leak:

- QR credentials (`SFT1.…`)
- provider secret keys (`sk_test_`, `sk_live_`, `whsec_`, `re_`)
- connection strings
- embedded base64 images
- permanent ticket-bearing URLs — the retrieval link is always a short-lived,
  single-use download grant

## Verifying delivery

```bash
npm run staging:verify:email
```

Sends exactly one clearly-marked test message to `RESEND_TEST_RECIPIENT`.

It is deliberately **not** wired into the build, any deployment, any test suite,
or any scheduled job. A network call that spends free-tier quota and puts mail
in a real inbox is an explicit human decision every time.

The command:

- reads the recipient from `RESEND_TEST_RECIPIENT` and cannot be overridden by
  an argument
- refuses to run if `RESEND_MODE=live`
- masks both addresses in its output (`op*******@example.com`)
- prints neither the API key nor the provider's raw response
- reports only a truncated message id, enough to find the send in the Resend
  dashboard
- sends a body with no credential, no ticket reference, and no link into the
  platform

## Idempotency and retries

Each delivery attempt carries a stable idempotency key
(`<outboxId>:attempt:<n>`), which Resend deduplicates on. A dispatcher retry
after an ambiguous timeout therefore cannot produce a second real email.

Failures are classified rather than blindly retried:

| Class | Examples | Behaviour |
|---|---|---|
| Retryable | 408, 429, 5xx, timeout | Backoff and retry |
| Permanent | `validation_error`, `invalid_to_address`, 4xx | Dead-letter; needs a human |

Retrying a permanent failure forever would keep a broken message in the outbox
and hide it behind a growing attempt count.

## Free-tier limits

| Limit | Consequence |
|---|---|
| Daily and monthly send caps | Adequate for a demo, not for load testing |
| No custom domain | Sender fixed to `resend.dev` |
| Approved recipient only | Only the account address can receive |
| No commercial SLA | Delivery may be delayed |

## Before real production

None of this carries over. Real production requires a verified sending domain
with SPF, DKIM, and DMARC; `RESEND_MODE=live`; and no test recipient. The
production check enforces all three and refuses test mode outright.
