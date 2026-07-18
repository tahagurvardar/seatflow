import type { NotificationEnvironment } from "@/env/schema";
import { LocalFileNotificationProvider } from "@/server/notifications/local-file-provider";
import type { NotificationProvider } from "@/server/notifications/notification-provider";

export function createNotificationProvider(
  environment: NotificationEnvironment,
): NotificationProvider {
  if (environment.NOTIFICATION_PROVIDER === "LOCAL_FILE") {
    return new LocalFileNotificationProvider(environment.LOCAL_EMAIL_CAPTURE_DIR!);
  }
  throw new Error(
    "The EXTERNAL notification provider is a deployment gate until a reviewed adapter is configured.",
  );
}
