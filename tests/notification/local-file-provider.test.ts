import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSafeTicketEmail } from "@/server/notifications/email-view";
import {
  LocalFileNotificationProvider,
  type LocalNotificationMode,
} from "@/server/notifications/local-file-provider";

const directories: string[] = [];

function provider(mode: LocalNotificationMode = "SUCCESS") {
  const relative = `tmp/notification-contract-${randomUUID()}`;
  directories.push(path.resolve(process.cwd(), relative));
  return new LocalFileNotificationProvider(relative, mode);
}

function message(idempotencyKey: string = randomUUID()) {
  return createSafeTicketEmail({
    type: "BOOKING_TICKETS_READY",
    recipientEmail: "customer@example.com",
    eventTitle: "Aurora Room",
    sessionLabel: "Saturday, 18 July 2026 at 20:00",
    venueName: "Harbor Hall",
    seats: [{ sectionName: "Main", rowLabel: "A", seatLabel: "1" }],
    retrievalUrl: "http://localhost:3000/api/tickets/download/opaque-short-lived-grant",
    idempotencyKey,
  });
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("local notification provider contract", () => {
  it("captures a simulated successful delivery without a QR credential", async () => {
    const result = await provider().send(message());
    expect(result).toMatchObject({ status: "SUCCEEDED", duplicate: false });
    expect(message().text).not.toContain("SFT1.");
  });

  it("deduplicates the same provider idempotency key", async () => {
    const relative = `tmp/notification-contract-${randomUUID()}`;
    directories.push(path.resolve(process.cwd(), relative));
    const local = new LocalFileNotificationProvider(relative);
    const email = message("same-delivery-key");
    expect(await local.send(email)).toMatchObject({ status: "SUCCEEDED", duplicate: false });
    expect(await local.send(email)).toMatchObject({ status: "SUCCEEDED", duplicate: true });
  });

  it("rejects changed content under the same provider idempotency key", async () => {
    const relative = `tmp/notification-contract-${randomUUID()}`;
    directories.push(path.resolve(process.cwd(), relative));
    const local = new LocalFileNotificationProvider(relative);
    const email = message("stable-delivery-key");
    expect(await local.send(email)).toMatchObject({ status: "SUCCEEDED" });
    expect(await local.send({ ...email, subject: "Changed subject" })).toMatchObject({
      status: "PERMANENT_FAILURE",
      safeErrorCode: "LOCAL_CAPTURE_CONFLICT",
    });
  });

  it.each([
    ["RETRYABLE_FAILURE", "RETRYABLE_FAILURE"],
    ["PERMANENT_FAILURE", "PERMANENT_FAILURE"],
    ["TIMEOUT", "TIMEOUT"],
  ] as const)("returns the %s contract outcome", async (mode, expected) => {
    expect(await provider(mode).send(message())).toMatchObject({ status: expected });
  });

  it("recovers after a transient failure", async () => {
    const relative = `tmp/notification-contract-${randomUUID()}`;
    directories.push(path.resolve(process.cwd(), relative));
    expect(await new LocalFileNotificationProvider(relative, "RETRYABLE_FAILURE").send(message("recovery"))).toMatchObject({ status: "RETRYABLE_FAILURE" });
    expect(await new LocalFileNotificationProvider(relative, "SUCCESS").send(message("recovery"))).toMatchObject({ status: "SUCCEEDED" });
  });

  it("rejects recipient and subject header injection", async () => {
    await expect(provider().send({ ...message(), to: "victim@example.com\r\nBcc:evil@example.com" })).rejects.toThrow(/recipient/i);
    expect(await provider().send({ ...message(), subject: "Tickets\r\nBcc:evil@example.com" })).toMatchObject({ status: "PERMANENT_FAILURE" });
  });
});
