import "server-only";

import { createHash } from "node:crypto";

import { Resend } from "resend";

import {
  assertSafeEmailAddress,
  validateOutgoingMessage,
  type NotificationCapabilityReport,
  type NotificationMessage,
  type NotificationProvider,
  type NotificationSendResult,
} from "@/server/notifications/notification-provider";

/**
 * Resend notification adapter.
 *
 * Two safety properties matter more than delivery here:
 *
 *  - In test mode every message is redirected to one approved test recipient,
 *    so a misconfigured non-production deployment cannot email a real customer.
 *    The intended recipient is preserved only as a non-identifying digest in
 *    the subject-adjacent body, never as a live address.
 *  - Failures are classified as retryable or permanent. Retrying a permanent
 *    failure (an invalid recipient) forever would keep a broken message in the
 *    outbox and hide it behind a growing attempt count.
 */

export interface ResendProviderConfiguration {
  apiKey: string;
  fromAddress: string;
  replyToAddress?: string | null;
  mode: "test" | "live";
  /** Required in test mode; every message is redirected here. */
  testRecipient?: string | null;
  requestTimeoutMs: number;
}

/** Resend HTTP statuses that a later identical retry may still succeed on. */
const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const PERMANENT_ERROR_NAMES = new Set([
  "validation_error",
  "invalid_parameter",
  "missing_required_field",
  "invalid_from_address",
  "invalid_to_address",
  "restricted_api_key",
  "not_found",
]);

function safeErrorCode(value: string) {
  return (
    value.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase().slice(0, 60) || "RESEND_ERROR"
  );
}

export class ResendNotificationProvider implements NotificationProvider {
  readonly name = "RESEND" as const;

  private readonly client: Resend;

  constructor(
    private readonly configuration: ResendProviderConfiguration,
    client?: Resend,
  ) {
    assertSafeEmailAddress(configuration.fromAddress);
    if (configuration.replyToAddress) assertSafeEmailAddress(configuration.replyToAddress);
    if (configuration.mode === "test") {
      if (!configuration.testRecipient) {
        throw new Error("Resend test mode requires an approved test recipient.");
      }
      assertSafeEmailAddress(configuration.testRecipient);
    }
    this.client = client ?? new Resend(configuration.apiKey);
  }

  capabilityReport(): NotificationCapabilityReport {
    return {
      provider: this.name,
      simulated: false,
      mode: this.configuration.mode,
      supportsIdempotencyKey: true,
      supportsReplyTo: Boolean(this.configuration.replyToAddress),
      redirectsToTestRecipient: this.configuration.mode === "test",
      // Names a mode and behaviour, never a key, domain secret, or endpoint.
      safeConfigurationSummary: `resend adapter in ${this.configuration.mode} mode`,
    };
  }

  async send(message: NotificationMessage): Promise<NotificationSendResult> {
    const rejection = validateOutgoingMessage(message);
    if (rejection) return rejection;

    // In test mode the real recipient never appears in an outbound envelope.
    const recipient =
      this.configuration.mode === "test"
        ? this.configuration.testRecipient!
        : message.to;
    const subject =
      this.configuration.mode === "test"
        ? `[test ${this.recipientDigest(message.to)}] ${message.subject}`.slice(0, 160)
        : message.subject;

    try {
      const response = await this.client.emails.send(
        {
          from: this.configuration.fromAddress,
          to: [recipient],
          subject,
          text: message.text,
          html: message.html,
          ...(this.configuration.replyToAddress
            ? { replyTo: this.configuration.replyToAddress }
            : {}),
        },
        // Resend deduplicates on this key, so a dispatcher retry after an
        // ambiguous timeout cannot produce a second real email.
        { idempotencyKey: message.idempotencyKey },
      );

      if (response.error) return this.classifyError(response.error);
      if (!response.data?.id) {
        return { status: "RETRYABLE_FAILURE", safeErrorCode: "RESEND_NO_MESSAGE_ID" };
      }
      return {
        status: "SUCCEEDED",
        providerMessageId: String(response.data.id).slice(0, 191),
        // Resend does not distinguish a replayed idempotent send in its
        // response, so this is reported honestly rather than guessed.
        duplicate: false,
      };
    } catch (error) {
      return this.classifyThrown(error);
    }
  }

  /** A short non-reversible tag so test mail can be traced without an address. */
  private recipientDigest(recipient: string) {
    return createHash("sha256").update(recipient).digest("hex").slice(0, 8);
  }

  private classifyError(error: { name?: string; message?: string }): NotificationSendResult {
    const name = String(error.name ?? "resend_error").toLowerCase();
    if (PERMANENT_ERROR_NAMES.has(name)) {
      return { status: "PERMANENT_FAILURE", safeErrorCode: `PERMANENT_${safeErrorCode(name)}` };
    }
    if (name.includes("rate_limit")) {
      return { status: "RETRYABLE_FAILURE", safeErrorCode: "RESEND_RATE_LIMITED" };
    }
    // The provider message is deliberately dropped: it can quote the recipient
    // address and the message body back at us.
    return { status: "RETRYABLE_FAILURE", safeErrorCode: safeErrorCode(name) };
  }

  private classifyThrown(error: unknown): NotificationSendResult {
    if (typeof error === "object" && error !== null) {
      const candidate = error as { name?: unknown; statusCode?: unknown; message?: unknown };
      const statusCode = Number(candidate.statusCode);
      if (Number.isFinite(statusCode)) {
        if (RETRYABLE_STATUS_CODES.has(statusCode)) {
          return { status: "RETRYABLE_FAILURE", safeErrorCode: `RESEND_HTTP_${statusCode}` };
        }
        if (statusCode >= 400 && statusCode < 500) {
          return {
            status: "PERMANENT_FAILURE",
            safeErrorCode: `PERMANENT_RESEND_HTTP_${statusCode}`,
          };
        }
      }
      const name = String(candidate.name ?? "");
      if (/abort|timeout/i.test(name) || /timeout/i.test(String(candidate.message ?? ""))) {
        return { status: "TIMEOUT", safeErrorCode: "RESEND_TIMEOUT" };
      }
    }
    return { status: "RETRYABLE_FAILURE", safeErrorCode: "RESEND_REQUEST_FAILED" };
  }
}
