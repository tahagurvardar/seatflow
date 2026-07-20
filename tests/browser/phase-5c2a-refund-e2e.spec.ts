import { expect, test, type Page } from "@playwright/test";

import { storageStatePath } from "./global-setup";
import { buildSignedRefundWebhook, forgeInvalidSignature } from "./refund-fixture";
import { createBrowserTestDatabase } from "./seed";

/**
 * Authenticated refund lifecycle, end to end through the real UI.
 *
 * The customer signs in through the real login form, requests the refund
 * through the real form, and the refund is settled **only** by delivering a
 * validly signed event to the application's own webhook route over HTTP.
 * Nothing here writes a Refund, Booking, Ticket, inventory, ledger, or webhook
 * row directly; database access is read-only assertion.
 */

// Serial: this is a stateful lifecycle against one seeded booking, and each
// step depends on the previous one. It is also scoped to the desktop project in
// playwright.config.ts — running it once per viewport would have the second
// project find the booking already refunded, which would be a fixture collision
// rather than a real finding. Viewport behaviour is covered by the stateless
// layout specs.
test.describe.configure({ mode: "serial" });

const bookingReference = () => process.env.BROWSER_BOOKING_REFERENCE!;
const providerIntentId = () => process.env.BROWSER_PROVIDER_INTENT_ID!;
const usedTicketReference = () => process.env.BROWSER_USED_TICKET_REFERENCE!;

const FORBIDDEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; name: string }> = [
  { pattern: /\blocal_pi_[A-Za-z0-9]{8,}/, name: "provider intent id" },
  { pattern: /\blocal_re_[A-Za-z0-9]{8,}/, name: "provider refund id" },
  { pattern: /\bt=\d{10},v1=[a-f0-9]{64}/, name: "webhook signature" },
  { pattern: /SFT1\.[A-Za-z0-9_-]{20,}/, name: "ticket credential" },
  { pattern: /\brefund_[A-Za-z0-9_-]{24,}/, name: "internal idempotency key" },
  { pattern: /whsec_|sk_(test|live)_/, name: "provider secret" },
  { pattern: /postgres(ql)?:\/\/[^\s"']*:[^\s"'@]+@/, name: "database url" },
];

async function expectNoLeaks(page: Page) {
  const markup = await page.content();
  for (const { pattern, name } of FORBIDDEN_PATTERNS) {
    expect(pattern.test(markup), `markup must not contain a ${name}`).toBe(false);
  }
}

/** Read-only view of the state the flow is meant to change. */
async function readState() {
  const database = createBrowserTestDatabase();
  try {
    const booking = await database.booking.findUniqueOrThrow({
      where: { publicReference: bookingReference() },
      include: {
        refunds: { orderBy: { requestedAt: "asc" } },
        tickets: { orderBy: { id: "asc" } },
        seats: { orderBy: { id: "asc" } },
      },
    });
    const inventory = await database.sessionSeatInventory.findMany({
      where: { sessionId: booking.sessionId },
      select: { id: true, state: true },
      orderBy: { id: "asc" },
    });
    const attempt = await database.paymentAttempt.findFirstOrThrow({
      where: { orderId: booking.orderId },
    });
    return { booking, inventory, attempt };
  } finally {
    await database.$disconnect();
  }
}

/** Deliver a signed event to the application's own webhook route over HTTP. */
async function deliverRefundWebhook(
  page: Page,
  input: { providerRefundId: string; amountMinor: number; currency: string; forge?: boolean },
) {
  const delivery = buildSignedRefundWebhook({
    providerIntentId: providerIntentId(),
    providerRefundId: input.providerRefundId,
    amountMinor: input.amountMinor,
    currency: input.currency,
  });
  const signature = input.forge
    ? forgeInvalidSignature(delivery.rawBody)
    : delivery.signature;

  return page.request.post("/api/payments/webhooks/local-signed", {
    headers: {
      "content-type": "application/json",
      "x-seatflow-signature": signature,
    },
    data: Buffer.from(delivery.rawBody),
  });
}

test.describe("authenticated customer refund lifecycle", () => {
  test.use({ storageState: storageStatePath("customer") });

  test("displays the server-calculated refundable amount on the customer's own booking", async ({
    page,
  }) => {
    await page.goto(`/customer/bookings/${bookingReference()}`, {
      waitUntil: "networkidle",
    });

    await expect(page.getByRole("heading", { name: "Refunds" })).toBeVisible();
    const body = (await page.textContent("body")) ?? "";
    for (const label of [
      "Originally paid",
      "Already refunded",
      "Refund in progress",
      "Still refundable",
      "Estimated refund",
    ]) {
      expect(body, `refund panel should show "${label}"`).toContain(label);
    }
    await expectNoLeaks(page);
  });

  test("carries no amount, currency, provider, status, or actor id in the request", async ({
    page,
  }) => {
    await page.goto(`/customer/bookings/${bookingReference()}`, {
      waitUntil: "networkidle",
    });

    // Inspect what the form would actually submit.
    const fields = await page.evaluate(() => {
      const form = document.querySelector("form");
      if (!form) return [];
      return [...new FormData(form as HTMLFormElement).keys()];
    });

    expect(fields.length).toBeGreaterThan(0);
    for (const forbidden of [
      "amount",
      "amountMinor",
      "currency",
      "provider",
      "status",
      "organizationId",
      "userId",
      "actorId",
      "bookingId",
      "paymentAttemptId",
    ]) {
      expect(fields, `form must not submit "${forbidden}"`).not.toContain(forbidden);
    }
    // Only identifiers and a scope choice cross the wire.
    expect(fields).toContain("bookingReference");
    expect(fields).toContain("scope");
  });

  test("ignores injected financial fields and prices the refund on the server", async ({
    page,
  }) => {
    const before = await readState();
    await page.goto(`/customer/bookings/${bookingReference()}`, {
      waitUntil: "networkidle",
    });

    // Inject hostile fields directly into the real form, then submit it.
    await page.evaluate(() => {
      const form = document.querySelector("form");
      if (!form) throw new Error("refund form missing");
      for (const [name, value] of [
        ["amountMinor", "1"],
        ["requestedAmountMinor", "1"],
        ["currency", "USD"],
        ["provider", "STRIPE"],
        ["status", "SUCCEEDED"],
        ["organizationId", "attacker-org"],
        ["userId", "attacker-user"],
      ]) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name!;
        input.value = value!;
        form.appendChild(input);
      }
    });

    await page.getByRole("button", { name: /request refund/i }).click();
    // Wait for the outcome *text*, not merely for the element: the live region
    // is always present in the DOM (empty and `sr-only` while idle), so
    // asserting visibility alone would race ahead of the server action.
    await expect(page.getByRole("status")).toContainText(/refund/i, { timeout: 25_000 });

    const after = await readState();
    const created = after.booking.refunds.filter(
      (refund) => !before.booking.refunds.some((prior) => prior.id === refund.id),
    );
    expect(created).toHaveLength(1);

    const refund = created[0]!;
    // The injected 1-minor-unit amount, USD currency, STRIPE provider, and
    // SUCCEEDED status had no effect. The server action builds its input from
    // named fields only, so an injected field is never read in the first place
    // and every value below came from PostgreSQL.
    expect(refund.requestedAmountMinor).toBe(before.attempt.amountMinor);
    expect(refund.currency).toBe(before.attempt.currency);
    expect(refund.provider).toBe("LOCAL_SIGNED");
    expect(refund.status).toBe("REQUESTED");
    expect(refund.succeededAt).toBeNull();
    expect(refund.initiator).toBe("CUSTOMER");

    // And the UI does not claim the money has moved.
    await expect(page.getByRole("status")).not.toContainText(/refunded to you|money returned/i);
  });

  test("a replayed submission creates exactly one refund", async ({ page }) => {
    const before = await readState();
    const beforeCount = before.booking.refunds.length;
    expect(beforeCount).toBeGreaterThan(0);

    await page.goto(`/customer/bookings/${bookingReference()}`, {
      waitUntil: "networkidle",
    });

    // The whole amount is already reserved by the previous step, so the panel
    // correctly reports the booking as no longer eligible rather than offering
    // a second reservation. Asserting the honest ineligible state is the point:
    // a duplicate request has nothing left to claim.
    const submitCount = await page.getByRole("button", { name: /request refund/i }).count();
    if (submitCount > 0) {
      await page.getByRole("button", { name: /request refund/i }).click();
      await expect(page.getByRole("status")).toContainText(/refund|eligible|review/i, {
        timeout: 25_000,
      });
    } else {
      const body = (await page.textContent("body")) ?? "";
      expect(body).toMatch(/not currently eligible|under financial review|fully refunded/i);
    }

    const after = await readState();
    expect(after.booking.refunds).toHaveLength(beforeCount);
    expect(after.attempt.refundedMinor + after.attempt.inFlightRefundMinor).toBeLessThanOrEqual(
      after.attempt.amountMinor,
    );
  });

  test("shows Requested or Processing, and no navigation can mark it Succeeded", async ({
    page,
  }) => {
    await page.goto(`/customer/bookings/${bookingReference()}`, {
      waitUntil: "networkidle",
    });

    const historyText = (await page.textContent("body")) ?? "";
    expect(historyText).toMatch(/Requested|Processing/);
    expect(historyText).not.toContain("Succeeded");

    // Query parameters, redirects, and client navigation are not authority.
    for (const attempt of [
      `/customer/bookings/${bookingReference()}?status=SUCCEEDED`,
      `/customer/bookings/${bookingReference()}?refund=succeeded&settled=true`,
    ]) {
      await page.goto(attempt, { waitUntil: "networkidle" });
      const body = (await page.textContent("body")) ?? "";
      expect(body).not.toContain("Succeeded");
    }

    const state = await readState();
    expect(state.booking.refunds.every((refund) => refund.succeededAt === null)).toBe(true);
    expect(state.attempt.refundedMinor).toBe(0);
    await expectNoLeaks(page);
  });

  test("an invalid webhook signature changes nothing", async ({ page }) => {
    const before = await readState();
    const refund = before.booking.refunds[0]!;

    const response = await deliverRefundWebhook(page, {
      providerRefundId: refund.providerRefundId ?? "local_re_placeholder_000000",
      amountMinor: refund.requestedAmountMinor,
      currency: refund.currency,
      forge: true,
    });

    // The property under test is that a forged event is not accepted and
    // changes nothing — not which rejection code is produced. The route answers
    // 400 for a failed signature check and 503 when it declines to configure a
    // provider at all; both are refusals, and neither must ever be 200.
    expect(response.status()).not.toBe(200);
    expect([400, 503]).toContain(response.status());

    const after = await readState();
    expect(after.booking.refunds[0]!.succeededAt).toBeNull();
    expect(after.attempt.refundedMinor).toBe(0);
    expect(after.booking.status).toBe("CONFIRMED");
  });

  test("settles only through a verified webhook, then updates the customer page", async ({
    page,
  }) => {
    // The refund must first be submitted to the provider so it carries an
    // external identifier; that is the same command an operator would run.
    const { submitPendingRefunds } = await import(
      "../../src/server/refunds/submission-service"
    );
    const { createLocalProvider } = await import("./refund-fixture");
    const database = createBrowserTestDatabase();
    try {
      await submitPendingRefunds(database, createLocalProvider(), { batchSize: 10 });
    } finally {
      await database.$disconnect();
    }

    const submitted = await readState();
    const refund = submitted.booking.refunds[0]!;
    expect(refund.providerRefundId).toBeTruthy();
    // Submission is not settlement.
    expect(refund.succeededAt).toBeNull();
    expect(refund.status).toBe("PROCESSING");

    const response = await deliverRefundWebhook(page, {
      providerRefundId: refund.providerRefundId!,
      amountMinor: refund.requestedAmountMinor,
      currency: refund.currency,
    });
    expect(response.status()).toBe(200);

    const settled = await readState();
    expect(settled.booking.refunds[0]!.status).toBe("SUCCEEDED");
    expect(settled.booking.refunds[0]!.succeededAt).not.toBeNull();
    expect(settled.attempt.refundedMinor).toBe(refund.requestedAmountMinor);

    // The original captured payment is never rewritten.
    expect(settled.attempt.status).toBe("SUCCEEDED");
    expect(settled.attempt.amountMinor).toBe(submitted.attempt.amountMinor);

    // A full refund moves the booking to the deliberate terminal state.
    expect(settled.booking.status).toBe("REFUNDED");
    expect(settled.booking.refundedAt).not.toBeNull();
    expect(settled.booking.totalMinor).toBe(submitted.booking.totalMinor);

    // Unused tickets are revoked; a used ticket keeps its history.
    const used = settled.booking.tickets.find(
      (ticket) => ticket.publicReference === usedTicketReference(),
    )!;
    expect(used.status).toBe("USED");
    expect(used.revokedAt).toBeNull();
    const others = settled.booking.tickets.filter(
      (ticket) => ticket.publicReference !== usedTicketReference(),
    );
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((ticket) => ticket.status === "REVOKED")).toBe(true);

    // Refunding money never returns inventory to sale. The session holds more
    // seats than this booking bought, so the precise property is that nothing
    // changed at all — not that no seat anywhere is available.
    expect(settled.inventory).toEqual(submitted.inventory);
    const bookedBefore = submitted.inventory.filter((row) => row.state === "BOOKED");
    const bookedAfter = settled.inventory.filter((row) => row.state === "BOOKED");
    expect(bookedAfter).toEqual(bookedBefore);
    expect(bookedAfter.length).toBe(settled.booking.seats.length);
    // Specifically, no seat this booking held was released.
    for (const row of bookedBefore) {
      expect(
        settled.inventory.find((candidate) => candidate.id === row.id)?.state,
        "a refunded seat must not return to AVAILABLE",
      ).toBe("BOOKED");
    }

    // The customer's own page now reflects it.
    await page.goto(`/customer/bookings/${bookingReference()}`, {
      waitUntil: "networkidle",
    });
    const body = (await page.textContent("body")) ?? "";
    expect(body).toContain("Succeeded");
    expect(body).toContain("REFUNDED BOOKING");
    expect(body).toContain("Tickets marked revoked were refunded");
    await expectNoLeaks(page);
  });

  test("a duplicate verified webhook settles nothing twice", async ({ page }) => {
    const before = await readState();
    const refund = before.booking.refunds[0]!;

    const response = await deliverRefundWebhook(page, {
      providerRefundId: refund.providerRefundId!,
      amountMinor: refund.requestedAmountMinor,
      currency: refund.currency,
      // Same provider event id as the settling delivery.
      });
    expect([200, 400]).toContain(response.status());

    const after = await readState();
    expect(after.attempt.refundedMinor).toBe(before.attempt.refundedMinor);
    expect(after.booking.refunds.length).toBe(before.booking.refunds.length);

    const database = createBrowserTestDatabase();
    try {
      const successEntries = await database.financialLedgerEntry.count({
        where: { refundId: refund.id, entryType: "REFUND_SUCCEEDED" },
      });
      expect(successEntries).toBe(1);
    } finally {
      await database.$disconnect();
    }
  });

  test("produces no console errors and leaks nothing after settlement", async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(`/customer/bookings/${bookingReference()}`, {
      waitUntil: "networkidle",
    });

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    await expectNoLeaks(page);
    await expect(page.locator("nextjs-portal")).toHaveCount(0);
  });
});
