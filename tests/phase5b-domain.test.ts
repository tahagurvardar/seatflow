import { describe, expect, it } from "vitest";

import {
  compareTicketCredentialHash,
  deriveDownloadGrantToken,
  deriveTicketCredential,
  generateDownloadGrantToken,
  generateTicketPublicReference,
  hashDownloadGrantToken,
  hashTicketCredential,
  parseTicketCredential,
  TICKET_CREDENTIAL_ENTROPY_BITS,
  TICKET_REFERENCE_ENTROPY_BITS,
} from "@/features/tickets/credential";
import {
  canRotateTicket,
  decideEntryWindow,
  isDownloadGrantUsable,
  ticketEntryLabel,
} from "@/features/tickets/lifecycle";
import { safeTicketPdfFilename } from "@/features/tickets/pdf";
import {
  calculateNotificationBackoffMs,
  sanitizeNotificationError,
  shouldDeadLetterNotification,
} from "@/features/notifications/delivery";

const secret = "phase-5b-ticket-secret-000000000000000000000000";

describe("Phase 5B credential rules", () => {
  it("uses a versioned opaque credential with at least the required entropy", () => {
    const reference = generateTicketPublicReference();
    const credential = deriveTicketCredential({ ticketReference: reference, version: 1, secret });
    expect(TICKET_REFERENCE_ENTROPY_BITS).toBeGreaterThanOrEqual(192);
    expect(TICKET_CREDENTIAL_ENTROPY_BITS).toBeGreaterThanOrEqual(192);
    expect(reference).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(credential).toMatch(/^SFT1\.[A-Za-z0-9_-]{43}$/);
    expect(parseTicketCredential(credential)).toEqual({ version: 1, credential });
    expect(credential).not.toContain(reference);
  });

  it("generates non-sequential references and rotates deterministically by version", () => {
    const references = new Set(Array.from({ length: 128 }, generateTicketPublicReference));
    expect(references.size).toBe(128);
    const reference = [...references][0]!;
    const first = deriveTicketCredential({ ticketReference: reference, version: 1, secret });
    const second = deriveTicketCredential({ ticketReference: reference, version: 2, secret });
    expect(first).not.toBe(second);
    expect(deriveTicketCredential({ ticketReference: reference, version: 1, secret })).toBe(first);
  });

  it("hashes with domain separation and compares fixed digests in constant time", () => {
    const credential = deriveTicketCredential({ ticketReference: generateTicketPublicReference(), version: 1, secret });
    const hash = hashTicketCredential(credential, secret);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(compareTicketCredentialHash(hash, hash)).toBe(true);
    expect(compareTicketCredentialHash(hash, "0".repeat(64))).toBe(false);
    const grant = generateDownloadGrantToken();
    expect(hashDownloadGrantToken(grant, secret)).not.toBe(hash);
  });

  it("keeps notification grant tokens stable per attempt and separated between attempts", () => {
    const first = deriveDownloadGrantToken({ idempotencySubject: "outbox_1:attempt:1", secret });
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deriveDownloadGrantToken({ idempotencySubject: "outbox_1:attempt:1", secret })).toBe(first);
    expect(deriveDownloadGrantToken({ idempotencySubject: "outbox_1:attempt:2", secret })).not.toBe(first);
  });

  it("rejects malformed and oversized QR values", () => {
    expect(parseTicketCredential("SFT1.customer@example.com")).toBeNull();
    expect(parseTicketCredential(`SFT1.${"a".repeat(59)}`)).toBeNull();
    expect(() => hashTicketCredential("not-a-ticket", secret)).toThrow(/format/i);
  });
});

describe("Phase 5B lifecycle decisions", () => {
  const startAt = new Date("2026-07-20T18:00:00.000Z");
  const endAt = new Date("2026-07-20T20:00:00.000Z");

  it("applies early, open, late, and cancellation outcomes", () => {
    const base = { sessionStatus: "ON_SALE" as const, startAt, endAt, earlyMinutes: 120, lateMinutes: 60 };
    expect(decideEntryWindow({ ...base, now: new Date("2026-07-20T15:59:59.000Z") })).toBe("TOO_EARLY");
    expect(decideEntryWindow({ ...base, now: new Date("2026-07-20T16:00:00.000Z") })).toBe("OPEN");
    expect(decideEntryWindow({ ...base, now: new Date("2026-07-20T21:00:01.000Z") })).toBe("TOO_LATE");
    expect(decideEntryWindow({ ...base, sessionStatus: "CANCELLED", now: startAt })).toBe("SESSION_CANCELLED");
  });

  it("keeps used and revoked tickets terminal", () => {
    expect(canRotateTicket("ACTIVE")).toBe(true);
    expect(canRotateTicket("USED")).toBe(false);
    expect(canRotateTicket("REVOKED")).toBe(false);
    expect(ticketEntryLabel("USED")).toBe("Entry used");
    expect(ticketEntryLabel("REVOKED")).toBe("Revoked");
  });

  it("requires unused, unrevoked, unexpired grants", () => {
    const now = new Date("2026-07-18T10:00:00.000Z");
    expect(isDownloadGrantUsable({ now, expiresAt: new Date("2026-07-18T10:01:00.000Z"), usedAt: null, revokedAt: null })).toBe(true);
    expect(isDownloadGrantUsable({ now, expiresAt: now, usedAt: null, revokedAt: null })).toBe(false);
    expect(isDownloadGrantUsable({ now, expiresAt: new Date("2026-07-18T10:01:00.000Z"), usedAt: now, revokedAt: null })).toBe(false);
  });

  it("creates a bounded injection-safe PDF filename", () => {
    const filename = safeTicketPdfFilename('../../Summer <script>alert(1)</script>', "abc_DEF-1234567890");
    expect(filename).toBe("seatflow-summer-script-alert-1-script-abc_DEF-1234.pdf");
    expect(filename).not.toContain("..");
  });
});

describe("Phase 5B notification delivery decisions", () => {
  it("uses bounded exponential backoff and dead-letter rules", () => {
    expect(calculateNotificationBackoffMs(1, 1_000, 30_000)).toBe(1_000);
    expect(calculateNotificationBackoffMs(6, 1_000, 30_000)).toBe(30_000);
    expect(shouldDeadLetterNotification({ status: "RETRYABLE_FAILURE", nextAttemptCount: 2, maximumAttempts: 3 })).toBe(false);
    expect(shouldDeadLetterNotification({ status: "PERMANENT_FAILURE", nextAttemptCount: 1, maximumAttempts: 3 })).toBe(true);
  });

  it("redacts credentials and endpoints from safe errors", () => {
    const value = sanitizeNotificationError(new Error("postgresql://u:p@host/db SFT1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nfailed"));
    expect(value).toContain("[database endpoint redacted]");
    expect(value).toContain("[ticket credential redacted]");
    expect(value).not.toContain("u:p");
  });
});
