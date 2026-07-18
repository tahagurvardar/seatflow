import { readPaymentEnvironment } from "@/env/schema";
import { getDatabase } from "@/lib/database";
import {
  PaymentProviderConfigurationError,
  PaymentWebhookSignatureError,
  PaymentWebhookValidationError,
} from "@/server/payments/errors";
import { getConfiguredPaymentProvider } from "@/server/payments/provider-registry";
import { processPaymentWebhook } from "@/server/payments/webhook-service";
import { PaymentWebhookPayloadTooLargeError } from "@/features/payments/webhook";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  const { provider: providerPath } = await context.params;
  let environment;
  try {
    environment = readPaymentEnvironment();
  } catch {
    return Response.json({ received: false }, { status: 503 });
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > environment.PAYMENT_WEBHOOK_MAX_BYTES) {
    return Response.json({ received: false }, { status: 413 });
  }

  let provider;
  try {
    provider = getConfiguredPaymentProvider();
  } catch (error) {
    if (error instanceof PaymentProviderConfigurationError) {
      return Response.json({ received: false }, { status: 503 });
    }
    throw error;
  }
  const expectedPath = provider.name.toLowerCase().replaceAll("_", "-");
  if (providerPath !== expectedPath) {
    return Response.json({ received: false }, { status: 404 });
  }

  const signature = request.headers.get("x-seatflow-signature") ?? "";
  const rawBody = new Uint8Array(await request.arrayBuffer());
  try {
    await processPaymentWebhook(
      getDatabase(),
      provider,
      { rawBody, signature },
      { maximumPayloadBytes: environment.PAYMENT_WEBHOOK_MAX_BYTES },
    );
    return Response.json({ received: true }, { status: 200 });
  } catch (error) {
    if (error instanceof PaymentWebhookPayloadTooLargeError) {
      return Response.json({ received: false }, { status: 413 });
    }
    if (
      error instanceof PaymentWebhookSignatureError ||
      error instanceof PaymentWebhookValidationError
    ) {
      return Response.json({ received: false }, { status: 400 });
    }
    // Retryable internal failure without leaking database or provider details.
    return Response.json({ received: false }, { status: 503 });
  }
}

