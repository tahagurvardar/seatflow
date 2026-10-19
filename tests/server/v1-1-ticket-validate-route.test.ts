import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route contract for entry validation. The service and its PostgreSQL behaviour
 * are covered by the integration suite; this pins how the route turns a request
 * and a service result into an HTTP response.
 */

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  validate: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getCurrentSession: mocks.session }));
vi.mock("@/lib/database", () => ({ getDatabase: () => ({}) }));
vi.mock("@/server/security/route-guard", () => ({ applyRateLimit: async () => null }));
vi.mock("@/server/observability/logger", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...logger, child: () => logger }) };
});
vi.mock("@/env/schema", () => ({
  readTicketEnvironment: () => ({
    TICKET_CREDENTIAL_SECRET: "x".repeat(48),
    TICKET_ENTRY_EARLY_MINUTES: 120,
    TICKET_ENTRY_LATE_MINUTES: 240,
    TICKET_SCAN_MAX_BYTES: 2_048,
    TICKET_SCAN_RATE_LIMIT_PER_MINUTE: 300,
  }),
}));
vi.mock("@/server/tickets/validation-service", async () => {
  class TicketScanIdempotencyConflictError extends Error {}
  return { TicketScanIdempotencyConflictError, validateTicketEntry: mocks.validate };
});

const { POST } = await import("@/app/api/tickets/validate/route");
const { TicketScanIdempotencyConflictError } = await import("@/server/tickets/validation-service");

const validBody = {
  credential: `SFT1.${"A".repeat(43)}`,
  sessionId: "session_1",
  idempotencyKey: "a".repeat(32),
};

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/tickets/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.session.mockReset().mockResolvedValue({ user: { id: `scanner-${Math.random()}` } });
  mocks.validate.mockReset();
});

describe("POST /api/tickets/validate", () => {
  it("requires authentication before any evaluation", async () => {
    mocks.session.mockResolvedValue(null);
    const response = await POST(request(validBody));
    expect(response.status).toBe(401);
    expect(mocks.validate).not.toHaveBeenCalled();
  });

  it("rejects an oversized body with 413", async () => {
    const response = await POST(request({ ...validBody, credential: "A".repeat(4_000) }));
    expect(response.status).toBe(413);
    expect(mocks.validate).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["an unknown field", { ...validBody, accepted: true }],
    ["a short idempotency key", { ...validBody, idempotencyKey: "short" }],
  ])("rejects %s with 400", async (_label, body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(mocks.validate).not.toHaveBeenCalled();
  });

  it("passes the authenticated user as scanner, never a client-supplied identity", async () => {
    mocks.session.mockResolvedValue({ user: { id: "real-scanner" } });
    mocks.validate.mockResolvedValue({ outcome: "ACCEPTED", accepted: true });
    const response = await POST(request(validBody));
    expect(response.status).toBe(200);
    expect(mocks.validate.mock.calls[0]![1]).toMatchObject({
      scannerUserId: "real-scanner",
      idempotencyKey: validBody.idempotencyKey,
    });
  });

  it("maps an unauthorized scanner to 403", async () => {
    mocks.validate.mockResolvedValue({ outcome: "UNAUTHORIZED_SCANNER", accepted: false });
    expect((await POST(request(validBody))).status).toBe(403);
  });

  it("maps an idempotency conflict to 409 without an outcome", async () => {
    mocks.validate.mockRejectedValue(new TicketScanIdempotencyConflictError());
    const response = await POST(request(validBody));
    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload).not.toHaveProperty("outcome");
    expect(payload).not.toHaveProperty("accepted");
  });

  it("does not swallow unexpected service failures", async () => {
    mocks.validate.mockRejectedValue(new Error("database down"));
    await expect(POST(request(validBody))).rejects.toThrow("database down");
  });
});
