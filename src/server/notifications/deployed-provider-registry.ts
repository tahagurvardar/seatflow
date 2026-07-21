import "server-only";

import type { NotificationEnvironment } from "@/env/schema";
import type { NotificationProvider } from "@/server/notifications/notification-provider";
import { ResendNotificationProvider } from "@/server/notifications/resend-provider";

/**
 * Notification adapter selection for a **deployed** process.
 *
 * This exists as a separate module from `provider-registry.ts` for a concrete
 * bundling reason. `LocalFileNotificationProvider` resolves paths against
 * `process.cwd()` and writes captured mail to disk. Any serverless function
 * that can reach it — even through a dynamic import — makes the bundler's
 * dependency tracer conclude the whole project might be read at runtime, and it
 * then traces `tests/`, `docs/`, `prisma/migrations/`, and `public/` into the
 * function. Measured on the internal job route that was 657 traced files
 * against ~170 for comparable routes.
 *
 * Cutting the import edge rather than suppressing the warning is the point:
 * suppression would leave those files shipping.
 *
 * Refusing `LOCAL_FILE` here is also correct on its own terms. A serverless
 * filesystem is ephemeral, so captured mail would vanish with the invocation —
 * the adapter cannot do its job in that environment, and production forbids it
 * outright. The CLI dispatchers keep using the full registry, so local
 * development is unaffected.
 */
export function createDeployedNotificationProvider(
  environment: NotificationEnvironment,
): NotificationProvider {
  if (environment.NOTIFICATION_PROVIDER === "RESEND") {
    if (
      !environment.RESEND_API_KEY ||
      !environment.RESEND_FROM_ADDRESS ||
      !environment.RESEND_MODE
    ) {
      throw new Error("PERMANENT_RESEND_CONFIGURATION_INCOMPLETE");
    }
    return new ResendNotificationProvider({
      apiKey: environment.RESEND_API_KEY,
      fromAddress: environment.RESEND_FROM_ADDRESS,
      replyToAddress: environment.RESEND_REPLY_TO_ADDRESS ?? null,
      mode: environment.RESEND_MODE,
      testRecipient: environment.RESEND_TEST_RECIPIENT ?? null,
      requestTimeoutMs: environment.RESEND_REQUEST_TIMEOUT_MS,
    });
  }

  if (environment.NOTIFICATION_PROVIDER === "LOCAL_FILE") {
    // Permanent: retrying cannot make an ephemeral filesystem useful. The
    // deployment needs a real adapter, which is a configuration change.
    throw new Error("PERMANENT_LOCAL_FILE_PROVIDER_UNAVAILABLE_IN_DEPLOYED_MODE");
  }

  throw new Error("PERMANENT_NOTIFICATION_PROVIDER_NOT_CONFIGURED");
}
