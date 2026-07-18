export interface NotificationMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
}

export type NotificationSendResult =
  | { status: "SUCCEEDED"; providerMessageId: string; duplicate: boolean }
  | {
      status: "RETRYABLE_FAILURE" | "PERMANENT_FAILURE" | "TIMEOUT";
      safeErrorCode: string;
    };

export interface NotificationProvider {
  readonly name: "LOCAL_FILE" | "EXTERNAL";
  send(message: NotificationMessage): Promise<NotificationSendResult>;
}

export function assertSafeEmailAddress(value: string) {
  if (
    value.length > 254 ||
    /[\r\n\t]/.test(value) ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value)
  ) {
    throw new Error("PERMANENT_INVALID_RECIPIENT");
  }
  return value;
}
