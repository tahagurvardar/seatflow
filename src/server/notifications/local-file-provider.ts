import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  validateOutgoingMessage,
  type NotificationCapabilityReport,
  type NotificationMessage,
  type NotificationProvider,
  type NotificationSendResult,
} from "@/server/notifications/notification-provider";

export type LocalNotificationMode =
  | "SUCCESS"
  | "RETRYABLE_FAILURE"
  | "PERMANENT_FAILURE"
  | "TIMEOUT";

export class LocalFileNotificationProvider implements NotificationProvider {
  readonly name = "LOCAL_FILE" as const;
  private readonly rootDirectory: string;

  constructor(
    captureDirectory: string,
    private readonly mode: LocalNotificationMode = "SUCCESS",
  ) {
    const workspace = path.resolve(process.cwd());
    this.rootDirectory = path.resolve(workspace, captureDirectory);
    const relative = path.relative(workspace, this.rootDirectory);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Local email capture directory must stay inside the workspace.");
    }
  }

  capabilityReport(): NotificationCapabilityReport {
    return {
      provider: this.name,
      simulated: true,
      mode: "simulated",
      supportsIdempotencyKey: true,
      supportsReplyTo: false,
      redirectsToTestRecipient: true,
      safeConfigurationSummary: "local file capture; no external delivery",
    };
  }

  async send(message: NotificationMessage): Promise<NotificationSendResult> {
    // The same gate the external adapter runs, so the two cannot drift on what
    // is considered safe to transmit.
    const rejection = validateOutgoingMessage(message);
    if (rejection) return rejection;
    if (this.mode === "RETRYABLE_FAILURE") {
      return { status: "RETRYABLE_FAILURE", safeErrorCode: "LOCAL_SIMULATED_RETRYABLE" };
    }
    if (this.mode === "PERMANENT_FAILURE") {
      return { status: "PERMANENT_FAILURE", safeErrorCode: "LOCAL_SIMULATED_PERMANENT" };
    }
    if (this.mode === "TIMEOUT") {
      return { status: "TIMEOUT", safeErrorCode: "LOCAL_SIMULATED_TIMEOUT" };
    }

    const digest = createHash("sha256").update(message.idempotencyKey).digest("hex");
    const messageDigest = createHash("sha256")
      .update(JSON.stringify(message))
      .digest("hex");
    const providerMessageId = `local_${digest.slice(0, 32)}`;
    const filePath = path.join(this.rootDirectory, `${digest}.json`);
    await mkdir(this.rootDirectory, { recursive: true });
    try {
      await writeFile(
        filePath,
        JSON.stringify(
          {
            simulatedDelivery: true,
            providerMessageId,
            messageDigest,
            to: message.to,
            subject: message.subject,
            text: message.text,
            html: message.html,
          },
          null,
          2,
        ),
        { encoding: "utf8", flag: "wx" },
      );
      return { status: "SUCCEEDED", providerMessageId, duplicate: false };
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") throw error;
      const existing = JSON.parse(await readFile(filePath, "utf8")) as {
        providerMessageId?: unknown;
        messageDigest?: unknown;
      };
      if (
        existing.providerMessageId !== providerMessageId ||
        existing.messageDigest !== messageDigest
      ) {
        return { status: "PERMANENT_FAILURE", safeErrorCode: "LOCAL_CAPTURE_CONFLICT" };
      }
      return { status: "SUCCEEDED", providerMessageId, duplicate: true };
    }
  }
}
