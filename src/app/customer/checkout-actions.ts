"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { ROUTES } from "@/config/site";
import { requireAuth } from "@/lib/authorization";
import { getDatabase } from "@/lib/database";
import {
  createCheckoutAndPayment,
  ensurePaymentIntent,
} from "@/server/payments/checkout-service";
import {
  CheckoutAuthorizationError,
  CheckoutConflictError,
  CheckoutEligibilityError,
  CheckoutValidationError,
  PaymentProviderConfigurationError,
  PaymentProviderError,
} from "@/server/payments/errors";
import { LocalSignedPaymentProvider } from "@/server/payments/local-signed-provider";
import { getConfiguredPaymentProvider } from "@/server/payments/provider-registry";
import { processPaymentWebhook } from "@/server/payments/webhook-service";

function checkoutErrorMessage(error: unknown) {
  if (error instanceof CheckoutValidationError) return error.issues.join(" ");
  if (
    error instanceof CheckoutAuthorizationError ||
    error instanceof CheckoutConflictError ||
    error instanceof CheckoutEligibilityError ||
    error instanceof PaymentProviderError ||
    error instanceof PaymentProviderConfigurationError
  ) {
    return error.message;
  }
  return "SeatFlow could not start checkout. Please refresh and try again.";
}

export async function createCheckoutAction(holdToken: string, formData: FormData) {
  const holdPath = ROUTES.customerHold(holdToken);
  const auth = await requireAuth(holdPath);
  let reference: string;
  try {
    const provider = getConfiguredPaymentProvider();
    const result = await createCheckoutAndPayment(
      getDatabase(),
      provider,
      { userId: auth.user.id },
      {
        holdToken,
        idempotencyKey: String(formData.get("idempotencyKey") ?? ""),
      },
    );
    reference = result.order.publicReference;
  } catch (error) {
    redirect(`${holdPath}?error=${encodeURIComponent(checkoutErrorMessage(error))}`);
  }
  redirect(ROUTES.customerCheckout(reference));
}

export async function retryPaymentInitializationAction(orderReference: string) {
  const checkoutPath = ROUTES.customerCheckout(orderReference);
  const auth = await requireAuth(checkoutPath);
  const database = getDatabase();
  const order = await database.checkoutOrder.findUnique({
    where: { publicReference: orderReference },
    select: { id: true, userId: true },
  });
  if (!order || order.userId !== auth.user.id) {
    redirect(`${checkoutPath}?error=${encodeURIComponent("That checkout was not found or is not yours.")}`);
  }
  try {
    await ensurePaymentIntent(database, getConfiguredPaymentProvider(), order.id);
  } catch (error) {
    redirect(`${checkoutPath}?error=${encodeURIComponent(checkoutErrorMessage(error))}`);
  }
  revalidatePath(checkoutPath);
  redirect(checkoutPath);
}

export async function simulateLocalPaymentAction(
  orderReference: string,
  outcome: "success" | "failure",
) {
  const checkoutPath = ROUTES.customerCheckout(orderReference);
  const auth = await requireAuth(checkoutPath);
  const database = getDatabase();
  const attempt = await database.paymentAttempt.findFirst({
    where: { order: { publicReference: orderReference, userId: auth.user.id } },
    include: { order: true },
  });
  if (!attempt || !attempt.providerIntentId) {
    redirect(`${checkoutPath}?error=${encodeURIComponent("Payment initialization is still pending.")}`);
  }
  const provider = getConfiguredPaymentProvider();
  if (!(provider instanceof LocalSignedPaymentProvider) || attempt.provider !== "LOCAL_SIGNED") {
    redirect(`${checkoutPath}?error=${encodeURIComponent("Simulated payment is not available for this checkout.")}`);
  }

  const delivery = provider.createSignedWebhook({
    providerIntentId: attempt.providerIntentId,
    outcome,
    amountMinor: attempt.amountMinor,
    currency: attempt.currency,
  });
  try {
    await processPaymentWebhook(database, provider, delivery);
  } catch {
    redirect(`${checkoutPath}?error=${encodeURIComponent("The simulated webhook could not be processed. Please retry.")}`);
  }

  revalidatePath(checkoutPath);
  revalidatePath(ROUTES.customerDashboard);
  revalidatePath(ROUTES.customerBookings);
  redirect(`${checkoutPath}?providerReturn=1`);
}

