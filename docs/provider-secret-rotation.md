# Provider webhook secret rotation

Rotating a webhook secret without dropping in-flight deliveries needs a window
in which both the new and the previous secret verify. The danger is that the
window never closes and a leaked old secret stays valid forever.

## The window always closes

There is no "accept any previous secret" mode. Setting a previous secret
**requires** an explicit expiry:

| Variable | Meaning |
|---|---|
| `STRIPE_WEBHOOK_SECRET_CURRENT` | Required. The secret being rotated to. |
| `STRIPE_WEBHOOK_SECRET_PREVIOUS` | Optional. The secret being retired. |
| `STRIPE_WEBHOOK_SECRET_PREVIOUS_EXPIRES_AT` | **Required whenever the previous secret is set.** |

Configuration is refused when:

- the current secret is missing or shorter than 32 characters
- a previous secret is set without an expiry
- the previous secret equals the current one
- the window exceeds 7 days (`MAXIMUM_PREVIOUS_SECRET_WINDOW_MS`)

The window closes by itself. Once `previousExpiresAt` passes,
`activeSecretsForVerification` simply stops returning the old secret — no one
has to remember to remove a variable.

## Verification behaviour

`activeSecretsForVerification` returns the secrets a verifier may try right now,
newest first. Both adapters use it:

- **Local signed provider** — computes an HMAC per candidate secret and compares
  in constant time with `timingSafeEqual`. Every candidate is compared even
  after a match, so verification time does not reveal which secret matched or
  whether an early one did.
- **Stripe adapter** — calls Stripe's own `constructEvent` once per candidate.
  Signature checking is never reimplemented. The failure reason is deliberately
  not captured, because it would distinguish "wrong secret" from "malformed",
  and neither is safe to report to a caller.

An invalid window verifies **nothing at all** rather than falling back to the
current secret. A misconfigured rotation fails closed.

## Rotating safely

1. Create the new signing secret at the provider.
2. Set `STRIPE_WEBHOOK_SECRET_PREVIOUS` to the current value, and
   `STRIPE_WEBHOOK_SECRET_PREVIOUS_EXPIRES_AT` to a near-future timestamp
   (hours, not days — long enough to cover provider retry backoff).
3. Set `STRIPE_WEBHOOK_SECRET_CURRENT` to the new secret.
4. Deploy. Both secrets now verify.
5. After the expiry passes, remove both `..._PREVIOUS` variables.

`isRotationComplete` reports when step 5 is safe.

## What is never logged

No secret value, key fragment, signature header, or raw payload is ever logged,
returned in an error, or included in a readiness or `production:check` finding.
Findings name the **variable at fault and why**, never its value — verified by a
unit test that asserts no configured secret appears anywhere in the output.

## Related

- [Refunds and disputes](refunds-and-disputes.md)
- [Phase 5C2A external providers](phase-5c2a-external-providers.md)
