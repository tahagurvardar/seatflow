import { readPaymentEnvironment } from "@/env/schema";
import { correlationIdFromHeaders, CORRELATION_HEADER } from "@/features/observability/correlation";
import { getDatabase } from "@/lib/database";
import { getLogger } from "@/server/observability/logger";
import {
  PaymentProviderConfigurationError,
  PaymentWebhookSignatureError,
  PaymentWebhookValidationError,
} from "@/server/payments/errors";
import { getConfiguredPaymentProvider } from "@/server/payments/provider-registry";
import { processPaymentWebhook } from "@/server/payments/webhook-service";
import { PaymentWebhookPayloadTooLargeError } from "@/features/payments/webhook";
import { applyRateLimit } from "@/server/security/route-guard";

export const dynamic = "force-dynamic";

/**
 * Provider webhook ingress.
 *
 * Phase 5C1 adds correlation and structured logging without altering the
 * Phase 5A verification order: bound the declared length, resolve the provider,
 * then verify the signature over the exact raw bytes before anything is parsed
 * or persisted.
 *
 * The rate limit is a global, fail-open policy. A verified payment must never
 * go unfulfilled because a counter was unavailable, and this endpoint is not
 * attacker-authenticated in the usual sense — replay protection is the stored
 * `(provider, providerEventId)` uniqueness, not the limiter.
 *
 * Nothing here logs the raw body, the signature header, provider metadata, or
 * customer identity.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  const correlationId = correlationIdFromHeaders(request.headers);
  const logger = getLogger().child({ operation: "payment.webhook", correlationId });
  const startedAt = Date.now();
  const headers = { [CORRELATION_HEADER]: correlationId };

  const { provider: providerPath } = await context.params;
  let environment;
  try {
    environment = readPaymentEnvironment();
  } catch {
    return Response.json({ received: false }, { status: 503, headers });
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > environment.PAYMENT_WEBHOOK_MAX_BYTES) {
    return Response.json({ received: false }, { status: 413, headers });
  }

  const limited = await applyRateLimit({
    policyName: "payment.webhook",
    request,
    operation: "payment.webhook",
  });
  if (limited) return limited;

  let provider;
  try {
    provider = getConfiguredPaymentProvider();
  } catch (error) {
    if (error instanceof PaymentProviderConfigurationError) {
      return Response.json({ received: false }, { status: 503, headers });
    }
    throw error;
  }
  const expectedPath = provider.name.toLowerCase().replaceAll("_", "-");
  if (providerPath !== expectedPath) {
    return Response.json({ received: false }, { status: 404, headers });
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
    logger.info("payment webhook processed", {
      outcome: "processed",
      durationMs: Date.now() - startedAt,
      metadata: { provider: provider.name },
    });
    return Response.json({ received: true }, { status: 200, headers });
  } catch (error) {
    if (error instanceof PaymentWebhookPayloadTooLargeError) {
      logger.warn("payment webhook rejected", { outcome: "too_large" });
      return Response.json({ received: false }, { status: 413, headers });
    }
    if (
      error instanceof PaymentWebhookSignatureError ||
      error instanceof PaymentWebhookValidationError
    ) {
      // A rejected delivery is an expected outcome, not an internal fault.
      logger.warn("payment webhook rejected", { outcome: "rejected", error });
      return Response.json({ received: false }, { status: 400, headers });
    }
    // Retryable internal failure without leaking database or provider details.
    logger.error("payment webhook processing failed", {
      outcome: "internal_failure",
      durationMs: Date.now() - startedAt,
      error,
    });
    return Response.json({ received: false }, { status: 503, headers });
  }
}
