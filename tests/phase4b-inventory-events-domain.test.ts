import { describe, expect, it } from "vitest";

import {
  decideInventoryEvent,
  reconcileSelectedSeatIds,
  shouldRefreshAfterRealtimeTransition,
  toConnectionStateView,
} from "@/features/inventory-events/delivery";
import {
  createSafeInventoryEventPayload,
  inventoryEventPayloadSchema,
  parseInventoryEvent,
} from "@/features/inventory-events/event";
import {
  createRealtimeRoomTicket,
  verifyRealtimeRoomTicket,
} from "@/features/inventory-events/room-ticket";
import {
  calculateOutboxBackoffMs,
  shouldDeadLetterOutboxEvent,
  summarizeOutboxError,
} from "@/server/inventory-events/dispatcher-service";

const EVENT_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("Phase 4B safe inventory invalidations", () => {
  it("creates a bounded identity-free payload", () => {
    const event = createSafeInventoryEventPayload({
      eventId: EVENT_ID,
      sessionId: "session-safe-1",
      eventType: "HOLD_CREATED",
      now: new Date("2035-05-01T12:00:00.000Z"),
    });
    expect(event).toEqual({
      eventId: EVENT_ID,
      sessionId: "session-safe-1",
      eventType: "HOLD_CREATED",
      serverTimestamp: "2035-05-01T12:00:00.000Z",
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toMatch(/email|userId|publicToken|auth/i);
    expect(parseInventoryEvent(serialized)).toEqual(event);
  });

  it("rejects extra identity fields and oversized envelopes", () => {
    expect(
      inventoryEventPayloadSchema.safeParse({
        eventId: EVENT_ID,
        sessionId: "session-safe-1",
        eventType: "HOLD_CREATED",
        serverTimestamp: "2035-05-01T12:00:00.000Z",
        userId: "private-user",
      }).success,
    ).toBe(false);
    expect(() => parseInventoryEvent("x".repeat(2_049))).toThrow(/size/i);
  });
});

describe("Phase 4B outbox retry policy", () => {
  it("calculates bounded exponential backoff", () => {
    expect(calculateOutboxBackoffMs(1, 1_000, 30_000)).toBe(1_000);
    expect(calculateOutboxBackoffMs(4, 1_000, 30_000)).toBe(8_000);
    expect(calculateOutboxBackoffMs(10, 1_000, 30_000)).toBe(30_000);
    expect(() => calculateOutboxBackoffMs(0, 1_000, 30_000)).toThrow();
  });

  it("dead-letters exactly at the configured attempt bound", () => {
    expect(shouldDeadLetterOutboxEvent(7, 8)).toBe(false);
    expect(shouldDeadLetterOutboxEvent(8, 8)).toBe(true);
  });

  it("redacts connection strings and truncates safe errors", () => {
    const summary = summarizeOutboxError(
      new Error(`failed redis://user:secret@example.test:6379/${"x".repeat(800)}`),
    );
    expect(summary).not.toContain("secret");
    expect(summary.length).toBeLessThanOrEqual(500);
  });
});

describe("Phase 4B client ordering, reconnect, and reconciliation", () => {
  const event = createSafeInventoryEventPayload({
    eventId: EVENT_ID,
    sessionId: "session-safe-1",
    eventType: "HOLD_CREATED",
    now: new Date("2035-05-01T12:00:00.000Z"),
  });

  it("applies one event, then ignores duplicate and stale delivery", () => {
    const first = decideInventoryEvent(
      { lastServerTimestamp: null, seenEventIds: [] },
      event,
    );
    expect(first.apply).toBe(true);
    const duplicate = decideInventoryEvent(first.cursor, event);
    expect(duplicate).toMatchObject({ apply: false, reason: "duplicate" });
    const stale = decideInventoryEvent(first.cursor, {
      ...event,
      eventId: "59f6f47b-eec4-49fa-9b31-c4ea63f70a17",
      serverTimestamp: "2035-05-01T11:59:59.000Z",
    });
    expect(stale).toMatchObject({ apply: false, reason: "stale" });
  });

  it("refreshes when a connection becomes live and exposes honest labels", () => {
    expect(
      shouldRefreshAfterRealtimeTransition({ previous: "fallback", next: "live" }),
    ).toBe(true);
    expect(
      shouldRefreshAfterRealtimeTransition({ previous: "live", next: "live" }),
    ).toBe(false);
    expect(toConnectionStateView("live").label).toBe("Live");
    expect(toConnectionStateView("reconnecting").label).toBe("Reconnecting");
    expect(toConnectionStateView("fallback").label).toMatch(/refresh fallback/i);
  });

  it("removes only selections no longer available", () => {
    const result = reconcileSelectedSeatIds(["seat-1", "seat-2"], [
      {
        id: "section",
        name: "Main",
        code: "MAIN",
        rows: [
          {
            id: "row",
            label: "A",
            seats: [
              { seatId: "seat-1", label: "1", x: 0, y: 0, type: "STANDARD", state: "AVAILABLE", priceMinor: 1_000, currency: "AZN" },
              { seatId: "seat-2", label: "2", x: 40, y: 0, type: "STANDARD", state: "UNAVAILABLE", priceMinor: null, currency: null },
            ],
          },
        ],
      },
    ]);
    expect(result).toEqual({ kept: ["seat-1"], removed: ["seat-2"] });
  });
});

describe("Phase 4B realtime room tickets", () => {
  const secret = "a-secure-test-secret-with-more-than-32-characters";

  it("binds a short-lived signed ticket to one session", () => {
    const now = new Date("2035-05-01T12:00:00.000Z");
    const ticket = createRealtimeRoomTicket({
      sessionId: "session-safe-1",
      secret,
      now,
      lifetimeSeconds: 60,
    });
    expect(verifyRealtimeRoomTicket({ ticket, secret, now })).toMatchObject({
      sessionId: "session-safe-1",
      audience: "inventory",
    });
    expect(
      verifyRealtimeRoomTicket({
        ticket,
        secret,
        now: new Date("2035-05-01T12:01:01.000Z"),
      }),
    ).toBeNull();
  });

  it("rejects tampering and cross-signing", () => {
    const ticket = createRealtimeRoomTicket({
      sessionId: "session-safe-1",
      secret,
    });
    expect(verifyRealtimeRoomTicket({ ticket: `${ticket}x`, secret })).toBeNull();
    expect(
      verifyRealtimeRoomTicket({
        ticket,
        secret: "another-secure-secret-with-more-than-32-characters",
      }),
    ).toBeNull();
  });
});
