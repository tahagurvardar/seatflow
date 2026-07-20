import "server-only";

import { readPaymentEnvironment } from "@/env/schema";
import { validateSecretWindow } from "@/features/payments/secret-rotation";
import type { Currency } from "@/generated/prisma/enums";
import { PaymentProviderConfigurationError } from "@/server/payments/errors";
import { LocalSignedPaymentProvider } from "@/server/payments/local-signed-provider";
import type { PaymentProvider } from "@/server/payments/payment-provider";
import { StripePaymentProvider } from "@/server/payments/stripe-provider";

/**
 * Provider selection.
 *
 * An external adapter is constructed only when it is explicitly selected and
 * fully configured. A credential sitting in the environment is never enough on
 * its own, so a leftover key cannot quietly switch a deployment onto a live
 * payment network.
 */

let configuredProvider: PaymentProvider | undefined;

function parseAllowedCurrencies(value: string | undefined): readonly Currency[] {
  if (!value) return ["AZN", "EUR", "GBP", "USD"];
  return value.split(",").map((entry) => entry.trim().toUpperCase() as Currency);
}

export function getConfiguredPaymentProvider(now = new Date()): PaymentProvider {
  if (configuredProvider) return configuredProvider;
  const environment = readPaymentEnvironment();

  if (environment.PAYMENT_PROVIDER === "LOCAL_SIGNED") {
    if (!environment.LOCAL_PAYMENT_WEBHOOK_SECRET) {
      throw new PaymentProviderConfigurationError(
        "The local signed payment provider secret is not configured.",
      );
    }
    configuredProvider = new LocalSignedPaymentProvider(
      { current: environment.LOCAL_PAYMENT_WEBHOOK_SECRET },
      environment.NODE_ENV,
    );
    return configuredProvider;
  }

  if (environment.PAYMENT_PROVIDER === "STRIPE") {
    if (
      !environment.STRIPE_SECRET_KEY ||
      !environment.STRIPE_WEBHOOK_SECRET_CURRENT ||
      !environment.STRIPE_MODE
    ) {
      throw new PaymentProviderConfigurationError(
        "The Stripe adapter is selected but its configuration is incomplete.",
      );
    }

    const webhookSecrets = {
      current: environment.STRIPE_WEBHOOK_SECRET_CURRENT,
      previous: environment.STRIPE_WEBHOOK_SECRET_PREVIOUS ?? null,
      previousExpiresAt: environment.STRIPE_WEBHOOK_SECRET_PREVIOUS_EXPIRES_AT
        ? new Date(environment.STRIPE_WEBHOOK_SECRET_PREVIOUS_EXPIRES_AT)
        : null,
    };
    // A rotation window that never closes is a configuration error, not a
    // warning: an old secret would keep verifying indefinitely.
    const validation = validateSecretWindow(webhookSecrets, now);
    if (!validation.valid) {
      throw new PaymentProviderConfigurationError(
        `The Stripe webhook secret rotation window is invalid (${validation.reason}).`,
      );
    }

    configuredProvider = new StripePaymentProvider({
      secretKey: environment.STRIPE_SECRET_KEY,
      webhookSecrets,
      mode: environment.STRIPE_MODE,
      allowedCurrencies: parseAllowedCurrencies(environment.STRIPE_ALLOWED_CURRENCIES),
      requestTimeoutMs: environment.STRIPE_REQUEST_TIMEOUT_MS,
    });
    return configuredProvider;
  }

  throw new PaymentProviderConfigurationError(
    "No verified external payment-provider adapter is configured for this deployment.",
  );
}

/** Test-only: drop the memoized provider so configuration can be re-read. */
export function resetConfiguredPaymentProvider() {
  configuredProvider = undefined;
}
