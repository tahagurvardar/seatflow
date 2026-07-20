import { describe, expect, it } from "vitest";

import {
  decideDisputeTicketConsequence,
  decideDisputeTransition,
  detectRefundDisputeOverlap,
  isOpenDisputeStatus,
  isTerminalDisputeStatus,
  outcomeForTerminalStatus,
} from "../src/features/disputes/lifecycle";
import {
  buildLedgerEntryDraft,
  buildLedgerIdempotencyKey,
  calculateSettledBalanceMinor,
  detectLedgerDivergence,
  directionForEntryType,
  hashProviderReference,
  isSettlingEntryType,
} from "../src/features/ledger/entries";
import {
  activeSecretsForVerification,
  isRotationComplete,
  MAXIMUM_PREVIOUS_SECRET_WINDOW_MS,
  validateSecretWindow,
} from "../src/features/payments/secret-rotation";
import {
  normalizeProviderDisputeStatus,
  normalizeProviderRefundStatus,
} from "../src/features/payments/status";
import {
  authorizeRefundRequest,
  canReadOrganizationFinancials,
  decideRefundTicketConsequence,
  evaluateRefundEligibility,
} from "../src/features/refunds/authorization";
import {
  calculateFixedRefund,
  calculateFullBookingRefund,
  calculateSeatRefund,
  isFullyRefunded,
  remainingRefundableMinor,
} from "../src/features/refunds/calculation";
import {
  decideRefundTransition,
  isContradictoryRefundOutcome,
  isInFlightRefundStatus,
  isStaleProviderEvent,
  isTerminalRefundStatus,
} from "../src/features/refunds/lifecycle";

const capacity = {
  capturedMinor: 10_000,
  refundedMinor: 0,
  inFlightMinor: 0,
  currency: "EUR" as const,
};

function seat(id: string, priceMinor: number, alreadyRefunded = false) {
  return { bookingSeatId: id, priceMinor, currency: "EUR" as const, alreadyRefunded };
}

describe("refund amount calculation", () => {
  it("prices a full booking from seat snapshots", () => {
    const result = calculateFullBookingRefund({
      seats: [seat("a", 6_000), seat("b", 4_000)],
      capacity,
    });
    expect(result).toMatchObject({ outcome: "ELIGIBLE", scope: "FULL_BOOKING", amountMinor: 10_000 });
  });

  it("excludes seats already covered by a live refund", () => {
    const result = calculateFullBookingRefund({
      seats: [seat("a", 6_000, true), seat("b", 4_000)],
      capacity: { ...capacity, refundedMinor: 6_000 },
    });
    expect(result).toMatchObject({ outcome: "ELIGIBLE", amountMinor: 4_000 });
  });

  it("never exceeds remaining capacity even when snapshots total more", () => {
    // Remaining is 3_000 but the open seats total 10_000, so capacity wins and
    // the refund is no longer a whole-booking refund.
    const result = calculateFullBookingRefund({
      seats: [seat("a", 6_000), seat("b", 4_000)],
      capacity: { ...capacity, refundedMinor: 7_000 },
    });
    expect(result).toMatchObject({
      outcome: "ELIGIBLE",
      scope: "SELECTED_SEATS",
      amountMinor: 3_000,
    });
  });

  it("rejects a full refund when nothing is refundable", () => {
    expect(
      calculateFullBookingRefund({
        seats: [seat("a", 6_000)],
        capacity: { ...capacity, refundedMinor: 10_000 },
      }),
    ).toMatchObject({ outcome: "REJECTED", reason: "NOTHING_REFUNDABLE" });
  });

  it("prices selected seats and refuses unknown or already-refunded seats", () => {
    const seats = [seat("a", 6_000), seat("b", 4_000, true)];
    expect(
      calculateSeatRefund({ seats, requestedBookingSeatIds: ["a"], capacity }),
    ).toMatchObject({ outcome: "ELIGIBLE", scope: "SELECTED_SEATS", amountMinor: 6_000 });
    expect(
      calculateSeatRefund({ seats, requestedBookingSeatIds: ["zzz"], capacity }),
    ).toMatchObject({ outcome: "REJECTED", reason: "SEAT_NOT_IN_BOOKING" });
    expect(
      calculateSeatRefund({ seats, requestedBookingSeatIds: ["b"], capacity }),
    ).toMatchObject({ outcome: "REJECTED", reason: "SEAT_ALREADY_REFUNDED" });
    expect(
      calculateSeatRefund({ seats, requestedBookingSeatIds: [], capacity }),
    ).toMatchObject({ outcome: "REJECTED", reason: "NO_SEATS_SELECTED" });
  });

  it("deduplicates repeated seat identifiers rather than charging twice", () => {
    const result = calculateSeatRefund({
      seats: [seat("a", 6_000)],
      requestedBookingSeatIds: ["a", "a", "a"],
      capacity,
    });
    expect(result).toMatchObject({ outcome: "ELIGIBLE", amountMinor: 6_000 });
  });

  it("rejects a seat refund that would exceed what remains", () => {
    expect(
      calculateSeatRefund({
        seats: [seat("a", 6_000)],
        requestedBookingSeatIds: ["a"],
        capacity: { ...capacity, inFlightMinor: 9_000 },
      }),
    ).toMatchObject({ outcome: "REJECTED", reason: "EXCEEDS_REMAINING" });
  });

  it("rejects a mixed-currency booking rather than guessing", () => {
    expect(
      calculateFullBookingRefund({
        seats: [{ bookingSeatId: "a", priceMinor: 100, currency: "USD", alreadyRefunded: false }],
        capacity,
      }),
    ).toMatchObject({ outcome: "REJECTED", reason: "MIXED_CURRENCY" });
  });

  it("bounds and validates a fixed approved amount", () => {
    expect(calculateFixedRefund({ approvedAmountMinor: 2_500, capacity })).toMatchObject({
      outcome: "ELIGIBLE",
      scope: "FIXED_AMOUNT",
      amountMinor: 2_500,
    });
    for (const amount of [0, -1, 1.5, Number.NaN, 20_000]) {
      expect(calculateFixedRefund({ approvedAmountMinor: amount, capacity }).outcome).toBe(
        "REJECTED",
      );
    }
  });

  it("computes remaining capacity without going negative", () => {
    expect(remainingRefundableMinor(capacity)).toBe(10_000);
    expect(
      remainingRefundableMinor({ ...capacity, refundedMinor: 9_000, inFlightMinor: 5_000 }),
    ).toBe(0);
  });

  it("reports full refunds only when succeeded refunds cover the capture", () => {
    expect(isFullyRefunded({ capturedMinor: 100, refundedMinor: 99 })).toBe(false);
    expect(isFullyRefunded({ capturedMinor: 100, refundedMinor: 100 })).toBe(true);
  });
});

describe("refund lifecycle", () => {
  it("classifies terminal and in-flight statuses", () => {
    expect(isTerminalRefundStatus("SUCCEEDED")).toBe(true);
    expect(isTerminalRefundStatus("PROCESSING")).toBe(false);
    expect(isInFlightRefundStatus("REQUIRES_REVIEW")).toBe(true);
    expect(isInFlightRefundStatus("SUCCEEDED")).toBe(false);
  });

  it("treats differing terminal outcomes as contradictory", () => {
    expect(isContradictoryRefundOutcome("SUCCEEDED", "FAILED")).toBe(true);
    expect(isContradictoryRefundOutcome("SUCCEEDED", "SUCCEEDED")).toBe(false);
    expect(isContradictoryRefundOutcome("PROCESSING", "SUCCEEDED")).toBe(false);
  });

  it("advances, ignores, and escalates provider events deliberately", () => {
    expect(decideRefundTransition({ current: "PROCESSING", incoming: "SUCCEEDED" })).toMatchObject({
      outcome: "APPLY",
      status: "SUCCEEDED",
    });
    expect(decideRefundTransition({ current: "SUCCEEDED", incoming: "SUCCEEDED" })).toMatchObject({
      outcome: "IGNORE",
      reason: "DUPLICATE_STATUS",
    });
    expect(decideRefundTransition({ current: "SUCCEEDED", incoming: "FAILED" })).toMatchObject({
      outcome: "REVIEW",
      safeCode: "CONTRADICTORY_REFUND_OUTCOME",
    });
    // A late non-terminal event after settlement is stale, not a regression.
    expect(decideRefundTransition({ current: "SUCCEEDED", incoming: "PROCESSING" })).toMatchObject({
      outcome: "IGNORE",
      reason: "STALE_EVENT_AFTER_TERMINAL",
    });
    // Review is a one-way door.
    expect(
      decideRefundTransition({ current: "REQUIRES_REVIEW", incoming: "SUCCEEDED" }),
    ).toMatchObject({ outcome: "IGNORE", reason: "ALREADY_UNDER_REVIEW" });
    // A provider never moves a refund back to locally-requested.
    expect(decideRefundTransition({ current: "PROCESSING", incoming: "REQUESTED" })).toMatchObject({
      outcome: "IGNORE",
      reason: "NON_ADVANCING_STATUS",
    });
  });

  it("detects an out-of-order provider event by its own timestamp", () => {
    const applied = new Date("2026-07-19T12:00:00.000Z");
    expect(
      isStaleProviderEvent({
        lastAppliedAt: applied,
        incomingOccurredAt: new Date("2026-07-19T11:00:00.000Z"),
      }),
    ).toBe(true);
    expect(
      isStaleProviderEvent({
        lastAppliedAt: applied,
        incomingOccurredAt: new Date("2026-07-19T13:00:00.000Z"),
      }),
    ).toBe(false);
    // Missing information is never treated as staleness.
    expect(isStaleProviderEvent({ lastAppliedAt: null, incomingOccurredAt: applied })).toBe(false);
    expect(isStaleProviderEvent({ lastAppliedAt: applied, incomingOccurredAt: null })).toBe(false);
  });
});

describe("refund authorization and eligibility", () => {
  const eligible = {
    bookingStatus: "CONFIRMED" as const,
    orderStatus: "FULFILLED" as const,
    paymentStatus: "SUCCEEDED" as const,
    sessionStatus: "ON_SALE" as const,
    remainingRefundableMinor: 10_000,
    underFinancialReview: false,
  };

  it("accepts a confirmed, captured, unreviewed booking", () => {
    expect(evaluateRefundEligibility(eligible)).toEqual({ eligible: true });
  });

  it("still allows refunding a paid-but-unfulfilled order", () => {
    // The customer's money was taken; a fulfillment failure is not their fault.
    expect(
      evaluateRefundEligibility({ ...eligible, orderStatus: "PAID_UNFULFILLED" }),
    ).toEqual({ eligible: true });
  });

  it("refuses when the payment was never captured or is already refunded", () => {
    expect(evaluateRefundEligibility({ ...eligible, paymentStatus: "PENDING" })).toMatchObject({
      eligible: false,
      reason: "PAYMENT_NOT_CAPTURED",
    });
    expect(evaluateRefundEligibility({ ...eligible, bookingStatus: "REFUNDED" })).toMatchObject({
      eligible: false,
      reason: "ALREADY_FULLY_REFUNDED",
    });
    expect(
      evaluateRefundEligibility({ ...eligible, remainingRefundableMinor: 0 }),
    ).toMatchObject({ eligible: false, reason: "NOTHING_REFUNDABLE" });
    expect(
      evaluateRefundEligibility({ ...eligible, underFinancialReview: true }),
    ).toMatchObject({ eligible: false, reason: "UNDER_FINANCIAL_REVIEW" });
  });

  it("gives a customer a request, not refund authority", () => {
    const decision = authorizeRefundRequest({
      role: "CUSTOMER",
      actorUserId: "user-1",
      bookingOwnerUserId: "user-1",
      bookingOrganizationId: "org-1",
      actorOrganizationIds: [],
      isPlatformAdmin: false,
    });
    expect(decision).toMatchObject({
      allowed: true,
      initiator: "CUSTOMER",
      requiresApproval: true,
    });
  });

  it("refuses a customer acting on someone else's booking", () => {
    expect(
      authorizeRefundRequest({
        role: "CUSTOMER",
        actorUserId: "attacker",
        bookingOwnerUserId: "victim",
        bookingOrganizationId: "org-1",
        actorOrganizationIds: [],
        isPlatformAdmin: false,
      }),
    ).toMatchObject({ allowed: false, reason: "NOT_BOOKING_OWNER" });
  });

  it("refuses an organizer outside the organization, and provider refunds inside it", () => {
    expect(
      authorizeRefundRequest({
        role: "ORGANIZER",
        actorUserId: "org-user",
        bookingOwnerUserId: "customer",
        bookingOrganizationId: "org-1",
        actorOrganizationIds: ["org-2"],
        isPlatformAdmin: false,
      }),
    ).toMatchObject({ allowed: false, reason: "NOT_IN_ORGANIZATION" });
    // In-organization, but still no authority to move platform money.
    expect(
      authorizeRefundRequest({
        role: "ORGANIZER",
        actorUserId: "org-user",
        bookingOwnerUserId: "customer",
        bookingOrganizationId: "org-1",
        actorOrganizationIds: ["org-1"],
        isPlatformAdmin: false,
      }),
    ).toMatchObject({ allowed: false, reason: "ORGANIZER_CANNOT_INITIATE_PROVIDER_REFUND" });
  });

  it("grants a platform admin an already-approved refund", () => {
    expect(
      authorizeRefundRequest({
        role: "PLATFORM_ADMIN",
        actorUserId: "admin",
        bookingOwnerUserId: "customer",
        bookingOrganizationId: "org-1",
        actorOrganizationIds: [],
        isPlatformAdmin: true,
      }),
    ).toMatchObject({ allowed: true, initiator: "PLATFORM_ADMIN", requiresApproval: false });
    // Claiming the role without holding it is refused.
    expect(
      authorizeRefundRequest({
        role: "PLATFORM_ADMIN",
        actorUserId: "pretender",
        bookingOwnerUserId: "customer",
        bookingOrganizationId: "org-1",
        actorOrganizationIds: [],
        isPlatformAdmin: false,
      }),
    ).toMatchObject({ allowed: false, reason: "UNKNOWN_ROLE" });
  });

  it("scopes organization financial reads absolutely", () => {
    expect(
      canReadOrganizationFinancials({
        isPlatformAdmin: false,
        actorOrganizationIds: ["org-2"],
        resourceOrganizationId: "org-1",
      }),
    ).toBe(false);
    expect(
      canReadOrganizationFinancials({
        isPlatformAdmin: true,
        actorOrganizationIds: [],
        resourceOrganizationId: "org-1",
      }),
    ).toBe(true);
  });

  it("revokes a refunded ticket but never rewrites a used one", () => {
    expect(
      decideRefundTicketConsequence({ ticketStatus: "ACTIVE", seatWasRefunded: true }),
    ).toMatchObject({ action: "REVOKE", safeReason: "REFUNDED" });
    expect(
      decideRefundTicketConsequence({ ticketStatus: "USED", seatWasRefunded: true }),
    ).toMatchObject({ action: "NONE", reason: "USED_TICKETS_REMAIN_HISTORICALLY_USED" });
    expect(
      decideRefundTicketConsequence({ ticketStatus: "ACTIVE", seatWasRefunded: false }),
    ).toMatchObject({ action: "NONE", reason: "SEAT_NOT_REFUNDED" });
  });
});

describe("dispute lifecycle", () => {
  it("classifies open and terminal dispute statuses", () => {
    expect(isOpenDisputeStatus("NEEDS_RESPONSE")).toBe(true);
    expect(isTerminalDisputeStatus("LOST")).toBe(true);
    expect(isTerminalDisputeStatus("OPEN")).toBe(false);
    expect(outcomeForTerminalStatus("WON")).toBe("WON");
    expect(outcomeForTerminalStatus("UNDER_REVIEW")).toBeNull();
  });

  it("preserves the first terminal outcome and freezes contradictions", () => {
    expect(decideDisputeTransition({ current: "OPEN", incoming: "LOST" })).toMatchObject({
      outcome: "APPLY",
      status: "LOST",
      disputeOutcome: "LOST",
    });
    expect(decideDisputeTransition({ current: "WON", incoming: "LOST" })).toMatchObject({
      outcome: "REVIEW",
      safeCode: "CONTRADICTORY_DISPUTE_OUTCOME",
    });
    expect(decideDisputeTransition({ current: "LOST", incoming: "OPEN" })).toMatchObject({
      outcome: "IGNORE",
      reason: "STALE_EVENT_AFTER_TERMINAL",
    });
    expect(
      decideDisputeTransition({ current: "REQUIRES_REVIEW", incoming: "WON" }),
    ).toMatchObject({ outcome: "IGNORE", reason: "ALREADY_UNDER_REVIEW" });
  });

  it("leaves admission alone while a dispute is open and revokes only on loss", () => {
    expect(
      decideDisputeTicketConsequence({ disputeStatus: "OPEN", ticketStatus: "ACTIVE" }),
    ).toMatchObject({ action: "NONE" });
    expect(
      decideDisputeTicketConsequence({ disputeStatus: "LOST", ticketStatus: "ACTIVE" }),
    ).toMatchObject({ action: "REVOKE", safeReason: "DISPUTE_LOST" });
    // Even a lost dispute cannot erase a scan that happened.
    expect(
      decideDisputeTicketConsequence({ disputeStatus: "LOST", ticketStatus: "USED" }),
    ).toMatchObject({ action: "PRESERVE_USED" });
    // The stricter policy is available but is not the default.
    expect(
      decideDisputeTicketConsequence({
        disputeStatus: "OPEN",
        ticketStatus: "ACTIVE",
        policy: "REVOKE_ON_OPEN",
      }),
    ).toMatchObject({ action: "REVOKE", safeReason: "DISPUTE_OPENED" });
  });

  it("detects double-compensation risk between refunds and disputes", () => {
    expect(
      detectRefundDisputeOverlap({
        succeededRefundMinor: 10_000,
        disputedAmountMinor: 10_000,
        capturedMinor: 10_000,
      }),
    ).toMatchObject({ overlapping: true, exceedsCaptured: true, combinedMinor: 20_000 });
    expect(
      detectRefundDisputeOverlap({
        succeededRefundMinor: 0,
        disputedAmountMinor: 10_000,
        capturedMinor: 10_000,
      }),
    ).toMatchObject({ overlapping: false, exceedsCaptured: false });
  });
});

describe("financial ledger entries", () => {
  it("fixes direction per entry type so a refund cannot be booked as a credit", () => {
    expect(directionForEntryType("PAYMENT_CAPTURED")).toBe("CREDIT");
    expect(directionForEntryType("REFUND_SUCCEEDED")).toBe("DEBIT");
    expect(directionForEntryType("CHARGEBACK_RECORDED")).toBe("DEBIT");
    expect(directionForEntryType("DISPUTE_WON")).toBe("CREDIT");
  });

  it("counts only settling entry types towards a balance", () => {
    expect(isSettlingEntryType("REFUND_SUCCEEDED")).toBe(true);
    expect(isSettlingEntryType("REFUND_REQUESTED")).toBe(false);

    const balance = calculateSettledBalanceMinor([
      { entryType: "PAYMENT_CAPTURED", direction: "CREDIT", amountMinor: 10_000 },
      // A pending request must not look like money that already moved.
      { entryType: "REFUND_REQUESTED", direction: "DEBIT", amountMinor: 4_000 },
      { entryType: "REFUND_SUCCEEDED", direction: "DEBIT", amountMinor: 4_000 },
    ]);
    expect(balance).toBe(6_000);
  });

  it("builds a deterministic idempotency key from the entry cause", () => {
    const key = buildLedgerIdempotencyKey({ entryType: "REFUND_SUCCEEDED", causeKey: "evt_123" });
    expect(key).toBe("REFUND_SUCCEEDED:evt_123");
    expect(
      buildLedgerIdempotencyKey({ entryType: "REFUND_SUCCEEDED", causeKey: "evt/123 unsafe" }),
    ).toMatch(/^REFUND_SUCCEEDED:[A-Za-z0-9_:.-]+$/);
  });

  it("hashes a provider reference instead of storing it", () => {
    const hash = hashProviderReference("re_live_secret_reference");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain("re_live");
    expect(hashProviderReference("re_live_secret_reference")).toBe(hash);
  });

  it("rejects an invalid draft rather than writing a bad entry", () => {
    expect(
      buildLedgerEntryDraft({ entryType: "REFUND_SUCCEEDED", amountMinor: -1, causeKey: "x" }),
    ).toMatchObject({ outcome: "REJECTED", reason: "AMOUNT_INVALID" });
    expect(
      buildLedgerEntryDraft({ entryType: "REFUND_SUCCEEDED", amountMinor: 10, causeKey: "  " }),
    ).toMatchObject({ outcome: "REJECTED", reason: "CAUSE_MISSING" });
    const ok = buildLedgerEntryDraft({
      entryType: "REFUND_SUCCEEDED",
      amountMinor: 10,
      causeKey: "evt_1",
      providerReference: "re_1",
    });
    expect(ok).toMatchObject({ outcome: "OK" });
    if (ok.outcome === "OK") {
      expect(ok.draft.direction).toBe("DEBIT");
      expect(ok.draft.providerReferenceHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("flags a ledger that disagrees with the stored aggregate", () => {
    const entries = [
      { entryType: "PAYMENT_CAPTURED" as const, direction: "CREDIT" as const, amountMinor: 10_000 },
      { entryType: "REFUND_SUCCEEDED" as const, direction: "DEBIT" as const, amountMinor: 4_000 },
    ];
    expect(
      detectLedgerDivergence({ capturedMinor: 10_000, refundedMinor: 4_000, entries }),
    ).toMatchObject({ diverged: false });
    expect(
      detectLedgerDivergence({ capturedMinor: 10_000, refundedMinor: 0, entries }),
    ).toMatchObject({ diverged: true, expectedMinor: 10_000, actualMinor: 6_000 });
  });
});

describe("webhook secret rotation", () => {
  const now = new Date("2026-07-19T12:00:00.000Z");
  const current = "current-webhook-secret-000000000000000000";
  const previous = "previous-webhook-secret-00000000000000000";

  it("accepts a lone current secret", () => {
    expect(validateSecretWindow({ current }, now)).toMatchObject({
      valid: true,
      acceptsPrevious: false,
    });
    expect(activeSecretsForVerification({ current }, now)).toEqual([current]);
  });

  it("accepts both secrets inside an open window", () => {
    const window = {
      current,
      previous,
      previousExpiresAt: new Date(now.getTime() + 60_000),
    };
    expect(validateSecretWindow(window, now)).toMatchObject({ valid: true, acceptsPrevious: true });
    expect(activeSecretsForVerification(window, now)).toEqual([current, previous]);
    expect(isRotationComplete(window, now)).toBe(false);
  });

  it("stops accepting the previous secret once the window closes", () => {
    const window = {
      current,
      previous,
      previousExpiresAt: new Date(now.getTime() - 1),
    };
    // The window closes by itself rather than by someone remembering to remove
    // a variable.
    expect(activeSecretsForVerification(window, now)).toEqual([current]);
    expect(isRotationComplete(window, now)).toBe(true);
  });

  it("refuses a rotation window that would never close", () => {
    expect(
      validateSecretWindow(
        { current, previous, previousExpiresAt: null },
        now,
      ),
    ).toMatchObject({ valid: false, reason: "PREVIOUS_EXPIRY_MISSING" });
    expect(
      validateSecretWindow(
        {
          current,
          previous,
          previousExpiresAt: new Date(now.getTime() + MAXIMUM_PREVIOUS_SECRET_WINDOW_MS + 1_000),
        },
        now,
      ),
    ).toMatchObject({ valid: false, reason: "PREVIOUS_WINDOW_TOO_LONG" });
  });

  it("refuses weak, missing, or duplicated secrets", () => {
    expect(validateSecretWindow({ current: "" }, now)).toMatchObject({
      valid: false,
      reason: "CURRENT_SECRET_MISSING",
    });
    expect(validateSecretWindow({ current: "too-short" }, now)).toMatchObject({
      valid: false,
      reason: "CURRENT_SECRET_TOO_SHORT",
    });
    expect(
      validateSecretWindow(
        { current, previous: current, previousExpiresAt: new Date(now.getTime() + 1_000) },
        now,
      ),
    ).toMatchObject({ valid: false, reason: "PREVIOUS_EQUALS_CURRENT" });
    // An invalid window verifies nothing at all rather than falling back.
    expect(activeSecretsForVerification({ current: "short" }, now)).toEqual([]);
  });
});

describe("provider status normalization", () => {
  it("maps known refund vocabularies onto ours", () => {
    expect(normalizeProviderRefundStatus("succeeded")).toBe("SUCCEEDED");
    expect(normalizeProviderRefundStatus("PENDING")).toBe("PROCESSING");
    expect(normalizeProviderRefundStatus("canceled")).toBe("CANCELLED");
    expect(normalizeProviderRefundStatus("requires_review")).toBe("REQUIRES_REVIEW");
  });

  it("maps known dispute vocabularies including Stripe's warning states", () => {
    expect(normalizeProviderDisputeStatus("warning_needs_response")).toBe("NEEDS_RESPONSE");
    expect(normalizeProviderDisputeStatus("warning_under_review")).toBe("UNDER_REVIEW");
    expect(normalizeProviderDisputeStatus("lost")).toBe("LOST");
  });

  it("throws on an unknown status rather than guessing at a financial outcome", () => {
    expect(() => normalizeProviderRefundStatus("sort_of_maybe")).toThrow();
    expect(() => normalizeProviderDisputeStatus("under_appeal")).toThrow();
  });
});
