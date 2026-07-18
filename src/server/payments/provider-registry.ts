import "server-only";

import { readPaymentEnvironment } from "@/env/schema";
import { PaymentProviderConfigurationError } from "@/server/payments/errors";
import { LocalSignedPaymentProvider } from "@/server/payments/local-signed-provider";
import type { PaymentProvider } from "@/server/payments/payment-provider";

let configuredProvider: PaymentProvider | undefined;

export function getConfiguredPaymentProvider(): PaymentProvider {
  if (configuredProvider) return configuredProvider;
  const environment = readPaymentEnvironment();
  if (environment.PAYMENT_PROVIDER === "LOCAL_SIGNED") {
    if (!environment.LOCAL_PAYMENT_WEBHOOK_SECRET) {
      throw new PaymentProviderConfigurationError(
        "The local signed payment provider secret is not configured.",
      );
    }
    configuredProvider = new LocalSignedPaymentProvider(
      environment.LOCAL_PAYMENT_WEBHOOK_SECRET,
      environment.NODE_ENV,
    );
    return configuredProvider;
  }
  throw new PaymentProviderConfigurationError(
    "No verified external payment-provider adapter is configured for this deployment.",
  );
}
