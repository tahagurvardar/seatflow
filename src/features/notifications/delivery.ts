export function calculateNotificationBackoffMs(
  attempt: number,
  baseMs: number,
  maximumMs: number,
) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("Notification attempt must be a positive integer.");
  }
  return Math.min(maximumMs, baseMs * 2 ** Math.min(attempt - 1, 30));
}

export function sanitizeNotificationError(error: unknown) {
  const message = error instanceof Error ? error.message : "UNKNOWN_NOTIFICATION_FAILURE";
  return message
    .replace(/postgres(ql)?:\/\/[^\s]+/gi, "[database endpoint redacted]")
    .replace(/redis(s)?:\/\/[^\s]+/gi, "[redis endpoint redacted]")
    .replace(/SFT1\.[A-Za-z0-9_-]+/g, "[ticket credential redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 240);
}

export function shouldDeadLetterNotification(input: {
  status: "RETRYABLE_FAILURE" | "PERMANENT_FAILURE" | "TIMEOUT";
  nextAttemptCount: number;
  maximumAttempts: number;
}) {
  return input.status === "PERMANENT_FAILURE" || input.nextAttemptCount >= input.maximumAttempts;
}
