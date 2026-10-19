import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client";
import {
  deriveTicketCredential,
  hashDownloadGrantToken,
  hashTicketCredential,
} from "../../src/features/tickets/credential";
import { createDatabaseClient } from "../../src/lib/database";
import { cancelEventSession } from "../../src/server/events/event-session-service";
import { acquireSeatHold } from "../../src/server/holds/hold-service";
import { dispatchNotificationBatch } from "../../src/server/notifications/dispatcher-service";
import { LocalFileNotificationProvider } from "../../src/server/notifications/local-file-provider";
import { createCheckoutAndPayment } from "../../src/server/payments/checkout-service";
import { LocalSignedPaymentProvider } from "../../src/server/payments/local-signed-provider";
import { processPaymentWebhook } from "../../src/server/payments/webhook-service";
import { consumeBookingPdfGrant, createBookingPdfGrant } from "../../src/server/tickets/download-grant-service";
import {
  getTicketIssuanceBacklog,
  processTicketIssuanceBatch,
  processTicketIssuanceForBooking,
  retryTicketIssuanceRequest,
} from "../../src/server/tickets/issuance-service";
import { revokeTicket, rotateTicketCredential } from "../../src/server/tickets/management-service";
import { getCustomerTicketByReference } from "../../src/server/tickets/ticket-queries";
import {
  TicketScanIdempotencyConflictError,
  validateTicketEntry,
} from "../../src/server/tickets/validation-service";
import {
  createRedisInventoryFixture,
  createRedisTestCustomer,
} from "../redis/inventory-fixture";
import { resetIntegrationDatabase } from "./reset-database";

let database: PrismaClient;
const paymentSecret = "phase-5b-payment-provider-secret-000000000000000000";
const credentialSecret = "phase-5b-ticket-credential-secret-00000000000000000";
const captureDirectories: string[] = [];

async function setupConfirmedBooking(prefix: string, seatCount = 2, issueImmediately = true) {
  const fixture = await createRedisInventoryFixture(database, prefix);
  const customer = await createRedisTestCustomer(database, `${prefix}-customer`);
  const hold = await acquireSeatHold(database, { userId: customer.id }, {
    sessionId: fixture.session.id,
    seatIds: fixture.seatIds.slice(0, seatCount),
    idempotencyKey: `hold-${prefix}-${randomUUID()}`,
  });
  const provider = new LocalSignedPaymentProvider(paymentSecret, "test");
  const checkout = await createCheckoutAndPayment(
    database,
    provider,
    { userId: customer.id },
    { holdToken: hold.hold.publicToken, idempotencyKey: `checkout-${prefix}-${randomUUID()}` },
  );
  const attempt = await database.paymentAttempt.findFirstOrThrow({ where: { orderId: checkout.order.orderId } });
  const delivery = provider.createSignedWebhook({
    providerIntentId: attempt.providerIntentId!,
    outcome: "success",
    amountMinor: attempt.amountMinor,
    currency: attempt.currency,
  });
  await processPaymentWebhook(database, provider, delivery, {
    ticketCredentialSecret: issueImmediately ? credentialSecret : undefined,
  });
  const booking = await database.booking.findUniqueOrThrow({
    where: { orderId: checkout.order.orderId },
    include: { seats: true, tickets: { include: { credentials: true } } },
  });
  if (issueImmediately) {
    // Immediate issuance is best-effort by design and swallows its own errors,
    // so a failure would otherwise surface later as an unrelated-looking
    // assertion. Fail here, with the recorded cause, instead.
    const issuedWithActiveCredential = booking.tickets.filter((ticket) =>
      ticket.credentials.some((credential) => credential.status === "ACTIVE"),
    ).length;
    if (issuedWithActiveCredential !== seatCount) {
      const request = await database.ticketIssuanceRequest.findUnique({
        where: { bookingId: booking.id },
        select: { status: true, attemptCount: true, lastError: true },
      });
      throw new Error(
        `Fixture expected ${seatCount} issued tickets, found ${issuedWithActiveCredential}; issuance request: ${JSON.stringify(request)}`,
      );
    }
  }
  return { fixture, customer, booking };
}

function activeCredential(context: Awaited<ReturnType<typeof setupConfirmedBooking>>, index = 0) {
  const ticket = context.booking.tickets[index]!;
  const stored = ticket.credentials.find((credential) => credential.status === "ACTIVE")!;
  return {
    ticket,
    stored,
    plaintext: deriveTicketCredential({
      ticketReference: ticket.publicReference,
      version: stored.version,
      secret: credentialSecret,
    }),
  };
}

function scan(
  context: Awaited<ReturnType<typeof setupConfirmedBooking>>,
  plaintext: string,
  overrides: Partial<Parameters<typeof validateTicketEntry>[1]> = {},
) {
  return validateTicketEntry(database, {
    scannerUserId: context.fixture.organizerScope.userId,
    sessionId: context.fixture.session.id,
    credential: plaintext,
    credentialSecret,
    earlyMinutes: 60 * 24 * 31,
    lateMinutes: 60,
    idempotencyKey: randomUUID().replaceAll("-", ""),
    ...overrides,
  });
}

function notificationConfiguration() {
  return {
    batchSize: 10,
    maximumAttempts: 3,
    backoffBaseMs: 100,
    backoffMaximumMs: 1_000,
    downloadGrantTtlMinutes: 10,
    applicationBaseUrl: "http://localhost:3000",
    credentialSecret,
  };
}

function localProvider(mode: "SUCCESS" | "RETRYABLE_FAILURE" | "PERMANENT_FAILURE" = "SUCCESS") {
  const relative = `tmp/phase5b-mail-${randomUUID()}`;
  captureDirectories.push(path.resolve(process.cwd(), relative));
  return new LocalFileNotificationProvider(relative, mode);
}

beforeEach(async () => {
  database = createDatabaseClient();
  await resetIntegrationDatabase(database);
});

afterEach(async () => {
  await database.$disconnect();
  await Promise.all(captureDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Phase 5B issuance and credential history", () => {
  it("creates exactly one ticket and active hash-only credential per confirmed booking seat", async () => {
    const context = await setupConfirmedBooking("ticketissue");
    expect(context.booking.tickets).toHaveLength(2);
    expect(new Set(context.booking.tickets.map((ticket) => ticket.bookingSeatId)).size).toBe(2);
    const { plaintext } = activeCredential(context);
    const persisted = JSON.stringify(await database.ticketCredential.findMany());
    expect(persisted).not.toContain(plaintext);
    expect(await database.notificationOutbox.count({ where: { notificationType: "BOOKING_TICKETS_READY" } })).toBe(1);
  });

  it("keeps booking success independent from issuance failure and retries idempotently", async () => {
    const context = await setupConfirmedBooking("issuanceretry", 2, false);
    expect(context.booking.status).toBe("CONFIRMED");
    expect(await database.ticket.count()).toBe(0);
    const failed = await processTicketIssuanceBatch(database, {
      credentialSecret: "too-short",
      configuration: { batchSize: 1, maximumAttempts: 3, backoffBaseMs: 100, backoffMaximumMs: 1_000 },
    });
    expect(failed.failed).toBe(1);
    expect(await database.booking.count({ where: { status: "CONFIRMED" } })).toBe(1);
    await database.ticketIssuanceRequest.updateMany({ where: { status: "PENDING" }, data: { availableAt: new Date(0) } });
    const issued = await processTicketIssuanceBatch(database, {
      credentialSecret,
      configuration: { batchSize: 10, maximumAttempts: 3, backoffBaseMs: 100, backoffMaximumMs: 1_000 },
    });
    expect(issued.completed).toBe(1);
    await processTicketIssuanceForBooking(database, { bookingId: context.booking.id, credentialSecret });
    expect(await database.ticket.count({ where: { bookingId: context.booking.id } })).toBe(2);
    expect((await getTicketIssuanceBacklog(database)).missingCredentials).toBe(0);
  });

  it("requeues one explicitly selected dead-lettered issuance request", async () => {
    const context = await setupConfirmedBooking("issuancedeadletter", 1, false);
    const failed = await processTicketIssuanceBatch(database, {
      credentialSecret: "too-short",
      configuration: { batchSize: 1, maximumAttempts: 1, backoffBaseMs: 100, backoffMaximumMs: 1_000 },
    });
    expect(failed).toMatchObject({ failed: 1, deadLettered: 1 });
    const request = await database.ticketIssuanceRequest.findUniqueOrThrow({ where: { bookingId: context.booking.id } });
    expect(request.status).toBe("DEAD_LETTER");
    expect(await retryTicketIssuanceRequest(database, { requestId: request.id })).toBe(1);
    expect(await retryTicketIssuanceRequest(database, { requestId: request.id })).toBe(0);
    const issued = await processTicketIssuanceBatch(database, {
      credentialSecret,
      configuration: { batchSize: 1, maximumAttempts: 3, backoffBaseMs: 100, backoffMaximumMs: 1_000 },
    });
    expect(issued.completed).toBe(1);
    expect(await database.ticket.count({ where: { bookingId: context.booking.id } })).toBe(1);
  });

  it("enforces one active credential and immutable ticket ancestry at the database boundary", async () => {
    const context = await setupConfirmedBooking("credentialunique", 1);
    const { ticket } = activeCredential(context);
    const second = deriveTicketCredential({ ticketReference: ticket.publicReference, version: 2, secret: credentialSecret });
    await expect(database.ticketCredential.create({ data: {
      ticketId: ticket.id,
      version: 2,
      credentialHash: hashTicketCredential(second, credentialSecret),
      status: "ACTIVE",
      issuedAt: new Date(),
    } })).rejects.toThrow();
    await expect(database.ticket.update({ where: { id: ticket.id }, data: { userId: context.fixture.organizerScope.userId } })).rejects.toThrow(/immutable/i);
  });

  it("rotates credentials without creating a second ticket and rejects the old credential", async () => {
    const context = await setupConfirmedBooking("rotate", 1);
    const old = activeCredential(context);
    const result = await rotateTicketCredential(database, {
      actorUserId: context.fixture.organizerScope.userId,
      ticketReference: old.ticket.publicReference,
      credentialSecret,
    });
    expect(result.credentialVersion).toBe(2);
    expect(await database.ticket.count()).toBe(1);
    expect((await scan(context, old.plaintext)).outcome).toBe("REVOKED");
    const current = deriveTicketCredential({ ticketReference: old.ticket.publicReference, version: 2, secret: credentialSecret });
    expect((await scan(context, current)).outcome).toBe("ACCEPTED");
    expect(await database.ticketCredential.count({ where: { ticketId: old.ticket.id } })).toBe(2);
  });

  it("makes revocation terminal and rejects both the ticket and credential", async () => {
    const context = await setupConfirmedBooking("revoke", 1);
    const current = activeCredential(context);
    await revokeTicket(database, {
      actorUserId: context.fixture.organizerScope.userId,
      ticketReference: current.ticket.publicReference,
      reason: "COMPROMISED",
    });
    expect((await scan(context, current.plaintext)).outcome).toBe("REVOKED");
    expect(await database.ticket.findUniqueOrThrow({ where: { id: current.ticket.id } })).toMatchObject({ status: "REVOKED", revocationReason: "COMPROMISED" });
    await expect(rotateTicketCredential(database, { actorUserId: context.fixture.organizerScope.userId, ticketReference: current.ticket.publicReference, credentialSecret })).rejects.toThrow(/forbidden/i);
  });
});

describe("Phase 5B authoritative entry validation", () => {
  it("accepts one valid scan and returns ALREADY_USED on the next scan", async () => {
    const context = await setupConfirmedBooking("validscan", 1);
    const current = activeCredential(context);
    expect(await scan(context, current.plaintext)).toMatchObject({ outcome: "ACCEPTED", accepted: true });
    expect(await scan(context, current.plaintext)).toMatchObject({ outcome: "ALREADY_USED", accepted: false });
    expect(await database.ticketRedemptionEvent.count({ where: { ticketId: current.ticket.id } })).toBe(2);
  });

  it("allows exactly one of two simultaneous valid scans", async () => {
    const context = await setupConfirmedBooking("concurrentscan", 1);
    const current = activeCredential(context);
    const results = await Promise.all([scan(context, current.plaintext), scan(context, current.plaintext)]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["ACCEPTED", "ALREADY_USED"]);
    expect(await database.ticketRedemptionEvent.count({ where: { ticketId: current.ticket.id, outcome: "ACCEPTED" } })).toBe(1);
  });

  it("denies a cross-organization scanner before credential lookup", async () => {
    const context = await setupConfirmedBooking("crossorgscan", 1);
    const unrelated = await createRedisTestCustomer(database, "unrelated-scanner");
    const current = activeCredential(context);
    const result = await scan(context, current.plaintext, { scannerUserId: unrelated.id });
    expect(result.outcome).toBe("UNAUTHORIZED_SCANNER");
    expect(result.ticket).toBeUndefined();
  });

  it("rejects wrong-session and cancelled-session scans", async () => {
    const first = await setupConfirmedBooking("wrongsession", 1);
    const current = activeCredential(first);
    const second = await createRedisInventoryFixture(database, "targetsession");
    const wrong = await scan(first, current.plaintext, {
      scannerUserId: second.organizerScope.userId,
      sessionId: second.session.id,
    });
    expect(wrong).toMatchObject({ outcome: "WRONG_SESSION", accepted: false });
    expect(wrong.ticket).toBeUndefined();
    await cancelEventSession(database, { ...first.fixture.organizerScope, sessionId: first.fixture.session.id });
    expect((await scan(first, current.plaintext)).outcome).toBe("SESSION_CANCELLED");
  });

  it("does not revive a used ticket through rotation and keeps redemption history append-only", async () => {
    const context = await setupConfirmedBooking("usedterminal", 1);
    const current = activeCredential(context);
    await scan(context, current.plaintext);
    await expect(rotateTicketCredential(database, { actorUserId: context.fixture.organizerScope.userId, ticketReference: current.ticket.publicReference, credentialSecret })).rejects.toThrow(/forbidden/i);
    const redemption = await database.ticketRedemptionEvent.findFirstOrThrow({ where: { ticketId: current.ticket.id } });
    await expect(database.ticketRedemptionEvent.update({ where: { id: redemption.id }, data: { outcome: "INVALID" } })).rejects.toThrow(/append-only/i);
    await expect(database.ticketRedemptionEvent.delete({ where: { id: redemption.id } })).rejects.toThrow(/append-only/i);
  });
});

async function minutesUntilSessionStart(sessionId: string) {
  // Measured against PostgreSQL's clock, the same clock the scan decision uses.
  const [row] = await database.$queryRaw<Array<{ minutes: number }>>`
    SELECT EXTRACT(EPOCH FROM ("startAt" - CURRENT_TIMESTAMP)) / 60 AS minutes
    FROM "EventSession" WHERE "id" = ${sessionId}
  `;
  return Number(row!.minutes);
}

describe("v1.1 scanner entry window and authorization", () => {
  it("rejects entry before the early window and admits once it has opened", async () => {
    const context = await setupConfirmedBooking("entrywindow", 1);
    const current = activeCredential(context);
    const minutes = await minutesUntilSessionStart(context.fixture.session.id);
    // Window opens two minutes from now: too early.
    const early = await scan(context, current.plaintext, { earlyMinutes: Math.floor(minutes) - 2 });
    expect(early).toEqual({ outcome: "TOO_EARLY", accepted: false });
    expect((await database.ticket.findUniqueOrThrow({ where: { id: current.ticket.id } })).status).toBe("ACTIVE");
    // Window opened two minutes ago: admitted, exactly once.
    const admitted = await scan(context, current.plaintext, { earlyMinutes: Math.ceil(minutes) + 2 });
    expect(admitted).toMatchObject({ outcome: "ACCEPTED", accepted: true });
    const outcomes = await database.ticketRedemptionEvent.findMany({
      where: { ticketId: current.ticket.id },
      orderBy: { createdAt: "asc" },
      select: { outcome: true, rejectionReason: true },
    });
    expect(outcomes).toEqual([
      { outcome: "TOO_EARLY", rejectionReason: "TOO_EARLY" },
      { outcome: "ACCEPTED", rejectionReason: null },
    ]);
  });

  it("denies a MEMBER of the organizer organization", async () => {
    const context = await setupConfirmedBooking("memberscan", 1);
    const current = activeCredential(context);
    const eventSession = await database.eventSession.findUniqueOrThrow({
      where: { id: context.fixture.session.id },
      select: { event: { select: { organizerOrganizationId: true } } },
    });
    const member = await createRedisTestCustomer(database, "memberscanner");
    await database.membership.create({
      data: { userId: member.id, organizationId: eventSession.event.organizerOrganizationId, role: "MEMBER" },
    });
    expect(await scan(context, current.plaintext, { scannerUserId: member.id })).toEqual({
      outcome: "UNAUTHORIZED_SCANNER",
      accepted: false,
    });
    expect((await database.ticket.findUniqueOrThrow({ where: { id: current.ticket.id } })).status).toBe("ACTIVE");
  });

  it("allows an ADMIN of the hosting venue organization to scan", async () => {
    const context = await setupConfirmedBooking("venuescan", 1);
    const current = activeCredential(context);
    const eventSession = await database.eventSession.findUniqueOrThrow({
      where: { id: context.fixture.session.id },
      select: { venue: { select: { organizationId: true } } },
    });
    const venueAdmin = await createRedisTestCustomer(database, "venueadmin");
    await database.membership.create({
      data: { userId: venueAdmin.id, organizationId: eventSession.venue.organizationId, role: "ADMIN" },
    });
    expect(await scan(context, current.plaintext, { scannerUserId: venueAdmin.id })).toMatchObject({
      outcome: "ACCEPTED",
      accepted: true,
    });
  });

  it("does not let a venue admin scan a session at another venue", async () => {
    const context = await setupConfirmedBooking("venueother", 1);
    const current = activeCredential(context);
    const otherVenue = await createRedisInventoryFixture(database, "venueotherhost");
    const otherSession = await database.eventSession.findUniqueOrThrow({
      where: { id: otherVenue.session.id },
      select: { venue: { select: { organizationId: true } } },
    });
    const foreignAdmin = await createRedisTestCustomer(database, "foreignadmin");
    await database.membership.create({
      data: { userId: foreignAdmin.id, organizationId: otherSession.venue.organizationId, role: "ADMIN" },
    });
    expect((await scan(context, current.plaintext, { scannerUserId: foreignAdmin.id })).outcome).toBe(
      "UNAUTHORIZED_SCANNER",
    );
  });
});

describe("v1.1 scanner idempotency", () => {
  it("replays an accepted scan for a retry under the same key without a second redemption", async () => {
    const context = await setupConfirmedBooking("replayaccepted", 1);
    const current = activeCredential(context);
    const idempotencyKey = randomUUID().replaceAll("-", "");
    const first = await scan(context, current.plaintext, { idempotencyKey });
    const retry = await scan(context, current.plaintext, { idempotencyKey });
    expect(first).toMatchObject({ outcome: "ACCEPTED", accepted: true });
    expect(retry).toEqual(first);
    expect(retry.ticket?.reference).toBe(current.ticket.publicReference);
    expect(await database.ticketRedemptionEvent.count({ where: { ticketId: current.ticket.id } })).toBe(1);
    expect((await database.ticket.findUniqueOrThrow({ where: { id: current.ticket.id } })).status).toBe("USED");
  });

  it("answers simultaneous same-key requests with one decision and no unique violation", async () => {
    const context = await setupConfirmedBooking("replayconcurrent", 1);
    const current = activeCredential(context);
    const idempotencyKey = randomUUID().replaceAll("-", "");
    const results = await Promise.all(
      Array.from({ length: 4 }, () => scan(context, current.plaintext, { idempotencyKey })),
    );
    expect(results.map((result) => result.outcome)).toEqual(["ACCEPTED", "ACCEPTED", "ACCEPTED", "ACCEPTED"]);
    expect(await database.ticketRedemptionEvent.count({ where: { idempotencyKey } })).toBe(1);
    expect(await database.ticketRedemptionEvent.count({ where: { ticketId: current.ticket.id, outcome: "ACCEPTED" } })).toBe(1);
  });

  it("still lets distinct keys race to exactly one acceptance", async () => {
    const context = await setupConfirmedBooking("replaydistinct", 1);
    const current = activeCredential(context);
    const results = await Promise.all([scan(context, current.plaintext), scan(context, current.plaintext)]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["ACCEPTED", "ALREADY_USED"]);
  });

  it("refuses a key reused for a different credential and leaves that ticket untouched", async () => {
    const context = await setupConfirmedBooking("replayconflict", 2);
    const first = activeCredential(context, 0);
    const second = activeCredential(context, 1);
    const idempotencyKey = randomUUID().replaceAll("-", "");
    expect((await scan(context, first.plaintext, { idempotencyKey })).outcome).toBe("ACCEPTED");
    await expect(scan(context, second.plaintext, { idempotencyKey })).rejects.toBeInstanceOf(
      TicketScanIdempotencyConflictError,
    );
    expect((await database.ticket.findUniqueOrThrow({ where: { id: second.ticket.id } })).status).toBe("ACTIVE");
    expect(await database.ticketRedemptionEvent.count({ where: { ticketId: second.ticket.id } })).toBe(0);
    expect((await scan(context, second.plaintext)).outcome).toBe("ACCEPTED");
  });

  it("refuses to turn a recorded invalid scan into an evaluation of a real credential", async () => {
    const context = await setupConfirmedBooking("replayinvalid", 1);
    const current = activeCredential(context);
    const idempotencyKey = randomUUID().replaceAll("-", "");
    const forged = `SFT1.${"Z".repeat(43)}`;
    expect((await scan(context, forged, { idempotencyKey })).outcome).toBe("INVALID");
    expect(await scan(context, forged, { idempotencyKey })).toEqual({ outcome: "INVALID", accepted: false });
    await expect(scan(context, current.plaintext, { idempotencyKey })).rejects.toBeInstanceOf(
      TicketScanIdempotencyConflictError,
    );
    expect((await database.ticket.findUniqueOrThrow({ where: { id: current.ticket.id } })).status).toBe("ACTIVE");
  });

  it("gives a different invalid credential under a spent key the same decision a fresh scan would", async () => {
    const context = await setupConfirmedBooking("replaytwoinvalid", 1);
    const current = activeCredential(context);
    const idempotencyKey = randomUUID().replaceAll("-", "");
    const forgedA = `SFT1.${"X".repeat(43)}`;
    const forgedB = `SFT1.${"Y".repeat(43)}`;
    expect(await scan(context, forgedA, { idempotencyKey })).toEqual({ outcome: "INVALID", accepted: false });
    // A fresh evaluation of either forgery can only be INVALID, so the replay
    // is the correct decision for B as well; it can never accept anything.
    expect(await scan(context, forgedB, { idempotencyKey })).toEqual({ outcome: "INVALID", accepted: false });
    expect(await scan(context, "not-a-credential", { idempotencyKey })).toEqual({ outcome: "INVALID", accepted: false });
    expect(await scan(context, forgedB)).toEqual({ outcome: "INVALID", accepted: false });
    // Only a credential that resolves is a different scan, and it is refused.
    await expect(scan(context, current.plaintext, { idempotencyKey })).rejects.toBeInstanceOf(
      TicketScanIdempotencyConflictError,
    );
    expect(await database.ticketRedemptionEvent.count({ where: { idempotencyKey } })).toBe(1);
    expect(await database.ticketRedemptionEvent.count({ where: { outcome: "ACCEPTED" } })).toBe(0);
    expect((await database.ticket.findUniqueOrThrow({ where: { id: current.ticket.id } })).status).toBe("ACTIVE");
  });

  it("replays a wrong-session rejection without disclosing ticket details", async () => {
    const first = await setupConfirmedBooking("replaywrong", 1);
    const current = activeCredential(first);
    const second = await createRedisInventoryFixture(database, "replaywrongtarget");
    const idempotencyKey = randomUUID().replaceAll("-", "");
    const overrides = { scannerUserId: second.organizerScope.userId, sessionId: second.session.id, idempotencyKey };
    const original = await scan(first, current.plaintext, overrides);
    const retry = await scan(first, current.plaintext, overrides);
    expect(original).toEqual({ outcome: "WRONG_SESSION", accepted: false });
    expect(retry).toEqual(original);
  });

  it("scopes keys to the scanner, so another user's key never replays someone else's result", async () => {
    const context = await setupConfirmedBooking("replayscope", 1);
    const current = activeCredential(context);
    const outsider = await createRedisTestCustomer(database, "replayoutsider");
    const idempotencyKey = randomUUID().replaceAll("-", "");
    expect((await scan(context, current.plaintext, { idempotencyKey })).outcome).toBe("ACCEPTED");
    const replayAttempt = await scan(context, current.plaintext, { idempotencyKey, scannerUserId: outsider.id });
    expect(replayAttempt).toEqual({ outcome: "UNAUTHORIZED_SCANNER", accepted: false });
  });
});

describe("Phase 5B authenticated PDF grants", () => {
  it("binds a short-lived grant to its owner, consumes it once, and rejects replay", async () => {
    const context = await setupConfirmedBooking("grantowner", 1);
    const attacker = await createRedisTestCustomer(database, "grantattacker");
    const grant = await createBookingPdfGrant(database, {
      userId: context.customer.id,
      bookingId: context.booking.id,
      credentialSecret,
      ttlMinutes: 10,
    });
    expect(grant).not.toBeNull();
    expect(await consumeBookingPdfGrant(database, { userId: attacker.id, token: grant!.token, credentialSecret })).toBeNull();
    const untouchedGrant = await database.ticketDownloadGrant.findUniqueOrThrow({ where: { id: grant!.id } });
    expect(untouchedGrant.userId).toBe(context.customer.id);
    expect(untouchedGrant.tokenHash).toBe(hashDownloadGrantToken(grant!.token, credentialSecret));
    expect(untouchedGrant.usedAt).toBeNull();
    expect(untouchedGrant.revokedAt).toBeNull();
    expect(untouchedGrant.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await database.booking.count({ where: { id: context.booking.id, userId: context.customer.id, status: "CONFIRMED" } })).toBe(1);
    const consumed = await consumeBookingPdfGrant(database, { userId: context.customer.id, token: grant!.token, credentialSecret });
    expect(Buffer.from(consumed!.bytes).subarray(0, 5).toString()).toBe("%PDF-");
    expect(await consumeBookingPdfGrant(database, { userId: context.customer.id, token: grant!.token, credentialSecret })).toBeNull();
  });

  it("rejects expired grants and stores only their hashes", async () => {
    const context = await setupConfirmedBooking("grantexpired", 1);
    const grant = await createBookingPdfGrant(database, {
      userId: context.customer.id,
      bookingId: context.booking.id,
      credentialSecret,
      ttlMinutes: 1,
      now: new Date(Date.now() - 120_000),
    });
    expect(JSON.stringify(await database.ticketDownloadGrant.findMany())).not.toContain(grant!.token);
    expect(await consumeBookingPdfGrant(database, { userId: context.customer.id, token: grant!.token, credentialSecret })).toBeNull();
  });
});

describe("Phase 5B notification delivery and ownership", () => {
  it("keeps tickets usable when the provider fails and dead-letters permanent failure", async () => {
    const context = await setupConfirmedBooking("mailfailure", 1);
    const before = await database.ticket.count({ where: { status: "ACTIVE" } });
    const result = await dispatchNotificationBatch(database, localProvider("PERMANENT_FAILURE"), notificationConfiguration());
    expect(result).toMatchObject({ failed: 1, deadLettered: 1 });
    expect(await database.ticket.count({ where: { status: "ACTIVE" } })).toBe(before);
    expect(await database.notificationOutbox.count({ where: { status: "DEAD_LETTER" } })).toBe(1);
    expect(activeCredential(context).plaintext).toMatch(/^SFT1\./);
  });

  it("retries transient delivery, records attempts, and delivers once", async () => {
    await setupConfirmedBooking("mailretry", 1);
    const relative = `tmp/phase5b-mail-${randomUUID()}`;
    captureDirectories.push(path.resolve(process.cwd(), relative));
    const configuration = notificationConfiguration();
    const first = await dispatchNotificationBatch(database, new LocalFileNotificationProvider(relative, "RETRYABLE_FAILURE"), configuration);
    expect(first.failed).toBe(1);
    const retryAt = new Date(Date.now() + 2_000);
    const second = await dispatchNotificationBatch(database, new LocalFileNotificationProvider(relative, "SUCCESS"), configuration, retryAt);
    expect(second.processed).toBe(1);
    expect(await database.notificationDeliveryAttempt.count()).toBe(2);
    expect(await database.notificationOutbox.count({ where: { status: "PROCESSED" } })).toBe(1);
  });

  it("prevents concurrent dispatchers from double-sending", async () => {
    await setupConfirmedBooking("mailconcurrent", 1);
    const relative = `tmp/phase5b-mail-${randomUUID()}`;
    captureDirectories.push(path.resolve(process.cwd(), relative));
    const results = await Promise.all([
      dispatchNotificationBatch(database, new LocalFileNotificationProvider(relative), { ...notificationConfiguration(), batchSize: 1 }),
      dispatchNotificationBatch(database, new LocalFileNotificationProvider(relative), { ...notificationConfiguration(), batchSize: 1 }),
    ]);
    expect(results.reduce((sum, result) => sum + result.processed, 0)).toBe(1);
    expect(await database.notificationDeliveryAttempt.count({ where: { status: "SUCCEEDED" } })).toBe(1);
  });

  it("prevents customers from reading another customer's ticket", async () => {
    const context = await setupConfirmedBooking("ticketowner", 1);
    const attacker = await createRedisTestCustomer(database, "ticketreader");
    const current = activeCredential(context);
    expect(await getCustomerTicketByReference(database, { userId: attacker.id, publicReference: current.ticket.publicReference })).toBeNull();
    expect(await getCustomerTicketByReference(database, { userId: context.customer.id, publicReference: current.ticket.publicReference })).not.toBeNull();
  });
});
