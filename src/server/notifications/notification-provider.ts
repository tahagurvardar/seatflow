import type { NotificationProviderName } from "@/generated/prisma/enums";

/**
 * The notification boundary.
 *
 * A message crossing it carries only what the recipient needs to act. It never
 * carries a QR credential, a ticket credential hash, a permanent ticket-bearing
 * URL, a payment credential, a provider identifier, or a provider secret; the
 * retrieval URL is always a short-lived, single-use grant.
 */

export interface NotificationMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Stable per delivery attempt, so a retry cannot duplicate a real send. */
  idempotencyKey: string;
}

export type NotificationSendResult =
  | { status: "SUCCEEDED"; providerMessageId: string; duplicate: boolean }
  | {
      status: "RETRYABLE_FAILURE" | "PERMANENT_FAILURE" | "TIMEOUT";
      safeErrorCode: string;
    };

/** What a notification adapter can do in this deployment, reported not assumed. */
export interface NotificationCapabilityReport {
  provider: NotificationProviderName;
  simulated: boolean;
  mode: "test" | "live" | "simulated";
  supportsIdempotencyKey: boolean;
  supportsReplyTo: boolean;
  /** True when delivery is redirected away from real customers. */
  redirectsToTestRecipient: boolean;
  /** Never an API key, sender domain secret, or endpoint. */
  safeConfigurationSummary: string;
}

export interface NotificationProvider {
  readonly name: NotificationProviderName;
  send(message: NotificationMessage): Promise<NotificationSendResult>;
  capabilityReport(): NotificationCapabilityReport;
}

/**
 * Reject anything that is not a plain single address.
 *
 * The CR/LF and tab check is the header-injection guard: a recipient carrying a
 * newline could otherwise append its own headers (a second Bcc, a replaced
 * From) to the outgoing message.
 */
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

/** Subjects are single-line and bounded, for the same header-injection reason. */
export function isSafeSubject(value: string) {
  return value.length > 0 && value.length <= 160 && !/[\r\n\t]/.test(value);
}

/**
 * Content that must never leave the platform in an email. Checked centrally so
 * a new template cannot quietly introduce a leak.
 */
const FORBIDDEN_CONTENT_PATTERNS: ReadonlyArray<{ pattern: RegExp; code: string }> = [
  { pattern: /SFT1\.[A-Za-z0-9_-]{20,}/, code: "TICKET_CREDENTIAL" },
  { pattern: /\bsk_(test|live)_[A-Za-z0-9]+/, code: "PROVIDER_SECRET_KEY" },
  { pattern: /\bwhsec_[A-Za-z0-9]+/, code: "WEBHOOK_SECRET" },
  { pattern: /\bre_[A-Za-z0-9]{16,}/, code: "NOTIFICATION_API_KEY" },
  { pattern: /\b(postgres|postgresql|redis|rediss):\/\//i, code: "CONNECTION_STRING" },
  { pattern: /\bdata:image\/[a-z+]+;base64,/i, code: "EMBEDDED_QR_IMAGE" },
];

export function findForbiddenContent(message: NotificationMessage): string | null {
  const haystack = `${message.subject}\n${message.text}\n${message.html}`;
  for (const { pattern, code } of FORBIDDEN_CONTENT_PATTERNS) {
    if (pattern.test(haystack)) return code;
  }
  return null;
}

/**
 * One validation gate every adapter runs before sending, so the local and
 * external adapters cannot drift on what they consider safe to transmit.
 *
 * The recipient check throws rather than returning, which is the contract
 * established in Phase 5B and relied on by the provider suite: an unusable
 * address is a programming or data fault, not a delivery outcome. The
 * dispatcher already maps a thrown `PERMANENT_*` code onto a permanent
 * failure, so both paths end in the same non-retried state.
 */
export function validateOutgoingMessage(
  message: NotificationMessage,
): NotificationSendResult | null {
  assertSafeEmailAddress(message.to);
  if (!isSafeSubject(message.subject)) {
    return { status: "PERMANENT_FAILURE", safeErrorCode: "PERMANENT_INVALID_HEADER" };
  }
  const forbidden = findForbiddenContent(message);
  if (forbidden) {
    return {
      status: "PERMANENT_FAILURE",
      safeErrorCode: `PERMANENT_FORBIDDEN_CONTENT_${forbidden}`,
    };
  }
  return null;
}
