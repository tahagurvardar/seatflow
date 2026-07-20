import type { NotificationEnvironment } from "@/env/schema";
import { LocalFileNotificationProvider } from "@/server/notifications/local-file-provider";
import type { NotificationProvider } from "@/server/notifications/notification-provider";
import { ResendNotificationProvider } from "@/server/notifications/resend-provider";

/**
 * Notification adapter selection. As with payments, an external adapter is
 * built only when it is explicitly selected and fully configured, so a stray
 * API key in the environment can never start sending real email.
 */
export function createNotificationProvider(
  environment: NotificationEnvironment,
): NotificationProvider {
  if (environment.NOTIFICATION_PROVIDER === "LOCAL_FILE") {
    return new LocalFileNotificationProvider(environment.LOCAL_EMAIL_CAPTURE_DIR!);
  }

  if (environment.NOTIFICATION_PROVIDER === "RESEND") {
    if (
      !environment.RESEND_API_KEY ||
      !environment.RESEND_FROM_ADDRESS ||
      !environment.RESEND_MODE
    ) {
      throw new Error("The Resend adapter is selected but its configuration is incomplete.");
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

  throw new Error(
    "The EXTERNAL notification provider is a deployment gate until a reviewed adapter is configured.",
  );
}
