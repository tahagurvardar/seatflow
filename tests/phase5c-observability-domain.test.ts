import { describe, expect, it } from "vitest";

import {
  boundString,
  isForbiddenMetadataKey,
  MAX_LOG_METADATA_KEYS,
  redactEmailAddress,
  redactSensitiveText,
  safeText,
  sanitizeMetadata,
} from "../src/features/observability/redaction";
import {
  correlationIdFromHeaders,
  createOperationCorrelationId,
  generateCorrelationId,
  isValidCorrelationId,
  MAX_CORRELATION_LENGTH,
  resolveCorrelationId,
} from "../src/features/observability/correlation";
import {
  classifyError,
  deriveErrorCode,
  serializeError,
  toClientErrorBody,
} from "../src/features/observability/error-serializer";
import { Logger, safeOperationName, type LogRecord } from "../src/server/observability/logger";

function collect() {
  const records: LogRecord[] = [];
  const logger = new Logger({
    service: "seatflow-test",
    environment: "production",
    level: "debug",
    sink: (record) => records.push(record),
    now: () => new Date("2026-07-19T00:00:00.000Z"),
  });
  return { records, logger };
}

describe("log redaction", () => {
  it("removes database and Redis connection strings", () => {
    expect(redactSensitiveText("connect postgresql://user:pw@host:5432/db failed")).toContain(
      "[database endpoint redacted]",
    );
    expect(redactSensitiveText("redis://:auth@127.0.0.1:6379")).toContain(
      "[redis endpoint redacted]",
    );
    expect(redactSensitiveText("rediss://cache.example:6380")).toContain(
      "[redis endpoint redacted]",
    );
  });

  it("removes ticket credentials, webhook signatures, bearer tokens, and JWTs", () => {
    expect(redactSensitiveText("scan SFT1.abcdefghijklmnopqrstuvwxyz0123456789_ABCDE")).toBe(
      "scan [ticket credential redacted]",
    );
    expect(redactSensitiveText("sig t=1750000000,v1=deadbeefcafe")).toContain(
      "[webhook signature redacted]",
    );
    expect(redactSensitiveText("Authorization Bearer abcdef1234567890")).toContain("Bearer [redacted]");
    expect(
      redactSensitiveText("eyJhbGciOi.eyJzdWIiOjEyMw.SflKxwRJSMeKKF2QT4"),
    ).toContain("[jwt redacted]");
  });

  it("removes stored hashes and long bearer-shaped tokens but keeps ticket references", () => {
    const hash = "a".repeat(64);
    expect(redactSensitiveText(`hash ${hash}`)).toBe("hash [hash redacted]");

    const grantToken = "g".repeat(43);
    expect(redactSensitiveText(`token ${grantToken}`)).toBe("token [token redacted]");

    // A 192-bit ticket public reference is 32 base64url characters and is
    // deliberately loggable per the Phase 5B operations contract.
    const ticketReference = "T".repeat(32);
    expect(redactSensitiveText(`ticket ${ticketReference}`)).toBe(`ticket ${ticketReference}`);
  });

  it("removes an email address embedded in free text", () => {
    expect(redactSensitiveText("failure for customer@example.com on session abc")).toBe(
      "failure for [email redacted] on session abc",
    );
    expect(redactSensitiveText("cc: a.b+tag@mail.co.uk")).toBe("cc: [email redacted]");
    // A bare word containing @ that is not an address is left alone.
    expect(redactSensitiveText("rate 5@second")).toBe("rate 5@second");
  });

  it("collapses newlines so a log record cannot be forged", () => {
    expect(redactSensitiveText("a\nb\tc\rd")).toBe("a b c d");
  });

  it("bounds long strings", () => {
    expect(boundString("x".repeat(400), 32)).toHaveLength(32);
    expect(safeText("y".repeat(1000)).length).toBeLessThanOrEqual(256);
  });

  it("redacts the local part of an email but keeps the domain", () => {
    expect(redactEmailAddress("customer@example.com")).toBe("***@example.com");
    expect(redactEmailAddress("not-an-email")).toBe("[redacted]");
    expect(redactEmailAddress("@example.com")).toBe("[redacted]");
  });

  it("rejects sensitive metadata keys regardless of casing or separators", () => {
    for (const key of [
      "secret",
      "apiKey",
      "api_key",
      "AUTHORIZATION",
      "sessionCookie",
      "credentialHash",
      "webhookSignature",
      "customerEmail",
      "rawBody",
      "stackTrace",
      "databaseUrl",
      "redisUrl",
    ]) {
      expect(isForbiddenMetadataKey(key), key).toBe(true);
    }
    for (const key of ["outcome", "batchSize", "attemptCount", "sessionCount"]) {
      expect(isForbiddenMetadataKey(key), key).toBe(false);
    }
  });

  it("keeps only bounded primitives and drops nested structures", () => {
    const metadata = sanitizeMetadata({
      batchSize: 10,
      ok: true,
      note: null,
      label: "postgresql://user:pw@host/db",
      nested: { a: 1 },
      list: [1, 2, 3],
      fn: () => undefined,
      broken: Number.NaN,
      secret: "leak",
    });
    expect(metadata).toEqual({
      batchSize: 10,
      ok: true,
      note: null,
      label: "[database endpoint redacted]",
    });
  });

  it("bounds the number of metadata keys", () => {
    const oversized: Record<string, unknown> = {};
    for (let index = 0; index < MAX_LOG_METADATA_KEYS + 20; index += 1) {
      oversized[`key${index}`] = index;
    }
    expect(Object.keys(sanitizeMetadata(oversized) ?? {})).toHaveLength(MAX_LOG_METADATA_KEYS);
  });
});

describe("correlation identifiers", () => {
  it("generates 128 bits of hex entropy that satisfies its own grammar", () => {
    const id = generateCorrelationId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(isValidCorrelationId(id)).toBe(true);
    expect(generateCorrelationId()).not.toBe(id);
  });

  it("accepts a well-formed inbound value and replaces anything else", () => {
    expect(resolveCorrelationId("abc12345")).toBe("abc12345");
    expect(resolveCorrelationId("short")).toMatch(/^[0-9a-f]{32}$/);
    expect(resolveCorrelationId("x".repeat(MAX_CORRELATION_LENGTH + 1))).toMatch(/^[0-9a-f]{32}$/);
    expect(resolveCorrelationId(null)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("rejects header-injection and separator characters", () => {
    for (const candidate of [
      "abc\r\nSet-Cookie: a=b",
      "abc def",
      "abc;def",
      "abc/def",
      "../etc",
      "<script>",
    ]) {
      expect(isValidCorrelationId(candidate), candidate).toBe(false);
    }
  });

  it("prefers the canonical header and falls back to x-request-id", () => {
    const canonical = new Headers({ "x-correlation-id": "canonical-1234" });
    expect(correlationIdFromHeaders(canonical)).toBe("canonical-1234");

    const fallback = new Headers({ "x-request-id": "fallback-1234" });
    expect(correlationIdFromHeaders(fallback)).toBe("fallback-1234");

    const malformed = new Headers({ "x-correlation-id": "!!", "x-request-id": "good-abcdef" });
    expect(correlationIdFromHeaders(malformed)).toBe("good-abcdef");
  });

  it("builds bounded operation correlation identifiers", () => {
    const id = createOperationCorrelationId("outbox dispatch!!");
    expect(id.length).toBeLessThanOrEqual(MAX_CORRELATION_LENGTH);
    expect(isValidCorrelationId(id)).toBe(true);
  });
});

describe("safe error serialization", () => {
  class HoldConflictError extends Error {
    constructor() {
      super("Those seats are no longer available.");
      this.name = "HoldConflictError";
    }
  }
  class PaymentProviderError extends Error {
    constructor() {
      super("provider unreachable at postgresql://u:p@db/x");
      this.name = "PaymentProviderError";
    }
  }

  it("classifies domain rejections separately from internal faults", () => {
    expect(classifyError(new HoldConflictError())).toBe("expected_rejection");
    expect(classifyError(new PaymentProviderError())).toBe("internal_failure");
    expect(classifyError(new Error("boom"))).toBe("internal_failure");
    expect(classifyError(Object.assign(new Error("dup"), { code: "P2002" }))).toBe(
      "expected_rejection",
    );
    expect(classifyError(Object.assign(new Error("conn"), { code: "P1001" }))).toBe(
      "internal_failure",
    );
    expect(classifyError(Object.assign(new Error("bad"), { name: "ZodError" }))).toBe(
      "expected_rejection",
    );
  });

  it("derives stable bounded codes", () => {
    expect(deriveErrorCode("HoldConflictError")).toBe("HOLD_CONFLICT");
    expect(deriveErrorCode("PaymentWebhookSignatureError")).toBe("PAYMENT_WEBHOOK_SIGNATURE");
    expect(deriveErrorCode("X".repeat(200)).length).toBeLessThanOrEqual(64);
  });

  it("scrubs connection strings out of the serialized message", () => {
    const record = serializeError(new PaymentProviderError(), { correlationId: "abcd1234" });
    expect(record.classification).toBe("internal_failure");
    expect(record.code).toBe("PAYMENT_PROVIDER");
    expect(record.message).toContain("[database endpoint redacted]");
    expect(record.message).not.toContain("postgresql://");
    expect(record.correlationId).toBe("abcd1234");
  });

  it("uses only the Prisma code, never its query text", () => {
    const prismaError = Object.assign(
      new Error('Invalid `prisma.user.create()` invocation on postgresql://u:p@h/db'),
      { code: "P2002", name: "PrismaClientKnownRequestError" },
    );
    const record = serializeError(prismaError);
    expect(record.code).toBe("PRISMA_P2002");
    expect(record.message).not.toContain("postgresql://");
  });

  it("withholds internal detail from the client body but keeps rejections readable", () => {
    const rejection = serializeError(new HoldConflictError(), { correlationId: "abcd1234" });
    expect(toClientErrorBody(rejection)).toEqual({
      error: "Those seats are no longer available.",
      correlationId: "abcd1234",
    });

    const failure = serializeError(new PaymentProviderError(), { correlationId: "abcd1234" });
    expect(toClientErrorBody(failure)).toEqual({
      error: "An unexpected error occurred.",
      correlationId: "abcd1234",
    });
  });
});

describe("structured logger", () => {
  it("emits a JSON-serializable envelope with the required fields", () => {
    const { records, logger } = collect();
    logger.info("checkout created", {
      correlationId: "abcd1234",
      operation: "checkout.create",
      outcome: "ok",
      durationMs: 12.6,
      metadata: { seatCount: 2 },
    });

    const record = records[0]!;
    expect(record).toMatchObject({
      timestamp: "2026-07-19T00:00:00.000Z",
      level: "info",
      service: "seatflow-test",
      environment: "production",
      message: "checkout created",
      correlationId: "abcd1234",
      operation: "checkout.create",
      outcome: "ok",
      durationMs: 13,
      metadata: { seatCount: 2 },
    });
    expect(() => JSON.parse(JSON.stringify(record))).not.toThrow();
  });

  it("honours the level threshold", () => {
    const records: LogRecord[] = [];
    const logger = new Logger({ level: "warn", sink: (record) => records.push(record) });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(records.map((record) => record.level)).toEqual(["warn", "error"]);
  });

  it("redacts the message, metadata, and attached error", () => {
    const { records, logger } = collect();
    logger.error("failed for redis://:pw@cache:6379", {
      metadata: { detail: "SFT1.abcdefghijklmnopqrstuvwxyz012345678901234", secret: "nope" },
      error: new Error("connect postgresql://u:p@h/db"),
    });

    const record = records[0]!;
    expect(record.message).toContain("[redis endpoint redacted]");
    expect(record.metadata).toEqual({ detail: "[ticket credential redacted]" });
    expect(record.error?.message).toContain("[database endpoint redacted]");
    expect(JSON.stringify(record)).not.toContain("postgresql://");
  });

  it("bounds unrecognized operation and outcome labels", () => {
    expect(safeOperationName("checkout.create")).toBe("checkout.create");
    expect(safeOperationName("/events/summer-fest-2026/seats")).toBe("unclassified");
    expect(safeOperationName(undefined)).toBeUndefined();

    const { records, logger } = collect();
    logger.info("m", { outcome: "Not A Label" });
    expect(records[0]!.outcome).toBe("unclassified");
  });

  it("merges child context without losing parent fields", () => {
    const { records, logger } = collect();
    logger
      .child({ operation: "outbox.dispatch", metadata: { worker: "primary" } })
      .withCorrelation("abcd1234")
      .info("batch complete", { metadata: { claimed: 3 } });

    expect(records[0]).toMatchObject({
      operation: "outbox.dispatch",
      correlationId: "abcd1234",
      metadata: { worker: "primary", claimed: 3 },
    });
  });
});
