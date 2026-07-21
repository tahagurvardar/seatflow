import { createHash, createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  normalizeMessageId,
  normalizeRetryCount,
  verifyQStashSignature,
} from "@/server/jobs/qstash-verification";
import {
  selectTransportKind,
  UnavailableInventoryEventTransport,
  UpstashRestInventoryEventTransport,
} from "@/server/inventory-events/transport-factory";
import { UpstashRestRateLimitBackend } from "@/server/security/rate-limit-backend";
import { createDeployedNotificationProvider } from "@/server/notifications/deployed-provider-registry";

/**
 * QStash verification and the serverless Redis transports.
 *
 * These endpoints are internet-reachable triggers for inventory, ticket, and
 * financial work, so the tests concentrate on what must be refused: an unsigned
 * delivery, a signature from an unrelated key, a tampered body, an expired
 * token, and a signature replayed against a different endpoint.
 */

const CURRENT_KEY = "sig_current_signing_key_for_tests_0000000";
const NEXT_KEY = "sig_next_signing_key_for_tests_1111111111";
const JOB_URL = "https://seatflow-staging.vercel.app/api/internal/jobs/hold-expiry-sweep";

function base64Url(value: Buffer | string) {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/**
 * Build a QStash-shaped signature.
 *
 * QStash signs a JWT whose `body` claim is the base64url SHA-256 of the request
 * body, HMAC-SHA256 signed with the signing key. Reproducing that shape here
 * exercises the real verifier against genuine current-key, next-key, tampered,
 * and expired cases without reaching the network.
 */
function signDelivery(input: {
  body: string;
  key: string;
  url?: string;
  issuedAt?: number;
  expiresAt?: number;
}) {
  const now = Math.floor(Date.now() / 1_000);
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iss: "Upstash",
      sub: input.url ?? JOB_URL,
      exp: input.expiresAt ?? now + 300,
      iat: input.issuedAt ?? now,
      nbf: input.issuedAt ?? now,
      jti: `test-nonce-${Math.random().toString(36).slice(2)}`,
      body: base64Url(createHash("sha256").update(input.body).digest()),
    }),
  );
  const signature = base64Url(
    createHmac("sha256", input.key).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${signature}`;
}

const verifierOptions = {
  currentSigningKey: CURRENT_KEY,
  nextSigningKey: NEXT_KEY,
  clockToleranceSeconds: 15,
};

describe("QStash signature verification", () => {
  const body = JSON.stringify({ job: "hold-expiry-sweep" });

  it("accepts a delivery signed with the current key", async () => {
    const signature = signDelivery({ body, key: CURRENT_KEY });
    await expect(
      verifyQStashSignature({ signature, body, url: JOB_URL }, verifierOptions),
    ).resolves.toMatchObject({ verified: true, usedKey: "current" });
  });

  it("accepts a delivery signed with the next key, so rotation works", async () => {
    // During a rotation the provider may already have moved to the next key.
    // Rejecting it would mean every delivery fails for the whole window.
    const signature = signDelivery({ body, key: NEXT_KEY });
    await expect(
      verifyQStashSignature({ signature, body, url: JOB_URL }, verifierOptions),
    ).resolves.toMatchObject({ verified: true, usedKey: "next" });
  });

  it("reports a missing signature distinctly from an invalid one", async () => {
    await expect(
      verifyQStashSignature({ signature: null, body, url: JOB_URL }, verifierOptions),
    ).resolves.toEqual({ verified: false, reason: "MISSING" });
    await expect(
      verifyQStashSignature({ signature: "", body, url: JOB_URL }, verifierOptions),
    ).resolves.toEqual({ verified: false, reason: "MISSING" });
  });

  it("refuses a signature made with an unrelated key", async () => {
    const signature = signDelivery({ body, key: "sig_attacker_key_00000000000000000" });
    await expect(
      verifyQStashSignature({ signature, body, url: JOB_URL }, verifierOptions),
    ).resolves.toEqual({ verified: false, reason: "INVALID" });
  });

  it("refuses a tampered body", async () => {
    // The signature covers the exact bytes, so raising the batch size after
    // signing must invalidate it.
    const signature = signDelivery({ body, key: CURRENT_KEY });
    const tampered = JSON.stringify({ job: "hold-expiry-sweep", batchSize: 500 });
    await expect(
      verifyQStashSignature({ signature, body: tampered, url: JOB_URL }, verifierOptions),
    ).resolves.toEqual({ verified: false, reason: "INVALID" });
  });

  it("refuses an expired delivery", async () => {
    const past = Math.floor(Date.now() / 1_000) - 7_200;
    const signature = signDelivery({
      body,
      key: CURRENT_KEY,
      issuedAt: past,
      expiresAt: past + 60,
    });
    await expect(
      verifyQStashSignature({ signature, body, url: JOB_URL }, verifierOptions),
    ).resolves.toEqual({ verified: false, reason: "INVALID" });
  });

  it("refuses a signature replayed against a different endpoint", async () => {
    // A valid signature for the hold sweep must not authorize the refund job.
    const signature = signDelivery({ body, key: CURRENT_KEY });
    await expect(
      verifyQStashSignature(
        {
          signature,
          body,
          url: "https://seatflow-staging.vercel.app/api/internal/jobs/refund-reconciliation",
        },
        verifierOptions,
      ),
    ).resolves.toEqual({ verified: false, reason: "INVALID" });
  });

  it("refuses malformed signature material without throwing", async () => {
    for (const signature of ["not-a-jwt", "a.b", "...", "a.b.c", "x".repeat(5_000)]) {
      await expect(
        verifyQStashSignature({ signature, body, url: JOB_URL }, verifierOptions),
      ).resolves.toEqual({ verified: false, reason: "INVALID" });
    }
  });

  it("never surfaces the signing keys in a verdict", async () => {
    const verdict = await verifyQStashSignature(
      { signature: "a.b.c", body, url: JOB_URL },
      verifierOptions,
    );
    expect(JSON.stringify(verdict)).not.toContain(CURRENT_KEY);
    expect(JSON.stringify(verdict)).not.toContain(NEXT_KEY);
  });
});

describe("delivery header normalization", () => {
  it("reduces a message id to the stored grammar", () => {
    expect(normalizeMessageId("msg_ABC-123.xyz")).toBe("msg_ABC-123.xyz");
    // The header is untrusted and the column has a CHECK constraint, so
    // anything outside the grammar is stripped rather than trusted.
    expect(normalizeMessageId("msg/../../etc/passwd")).toBe("msg....etcpasswd");
    expect(normalizeMessageId("msg\n\rid")).toBe("msgid");
  });

  it("returns null rather than inventing an id", () => {
    expect(normalizeMessageId(null)).toBeNull();
    expect(normalizeMessageId("")).toBeNull();
    expect(normalizeMessageId("!!!")).toBeNull();
  });

  it("bounds an over-long id to the column width", () => {
    expect(normalizeMessageId("m".repeat(500))!.length).toBe(128);
  });

  it("clamps the retry counter", () => {
    expect(normalizeRetryCount("3")).toBe(3);
    expect(normalizeRetryCount(null)).toBe(0);
    expect(normalizeRetryCount("-5")).toBe(0);
    expect(normalizeRetryCount("not-a-number")).toBe(0);
    expect(normalizeRetryCount("99999999")).toBe(1_000);
  });
});

describe("Redis transport selection", () => {
  it("prefers REST when Upstash exposes it", () => {
    expect(
      selectTransportKind({
        UPSTASH_REDIS_REST_URL: "https://endpoint.upstash.io",
        UPSTASH_REDIS_REST_TOKEN: "token",
        REDIS_URL: "rediss://endpoint.upstash.io:6379",
      }),
    ).toBe("rest");
  });

  it("falls back to TCP when only REDIS_URL is set", () => {
    expect(selectTransportKind({ REDIS_URL: "redis://127.0.0.1:6379" })).toBe("tcp");
  });

  it("requires both REST values before choosing REST", () => {
    expect(
      selectTransportKind({
        UPSTASH_REDIS_REST_URL: "https://endpoint.upstash.io",
        REDIS_URL: "redis://127.0.0.1:6379",
      }),
    ).toBe("tcp");
  });

  it("reports unavailable when nothing is configured", () => {
    expect(selectTransportKind({})).toBe("unavailable");
  });
});

describe("Redis unavailable behaviour", () => {
  it("throws rather than silently discarding an event", async () => {
    // Returning quietly would let the dispatcher mark the outbox row processed
    // and lose the invalidation permanently. Throwing leaves it pending.
    const transport = new UnavailableInventoryEventTransport("no endpoint configured");
    await expect(transport.publish()).rejects.toThrow(/unavailable/i);
  });
});

describe("Upstash REST inventory transport", () => {
  const environment = {
    REDIS_STREAM_PREFIX: "seatflow:staging",
    REDIS_EVENT_DEDUP_TTL_SECONDS: 604_800,
    REDIS_STREAM_MAX_LENGTH: 100_000,
  } as never;

  const event = {
    eventId: "11111111-1111-4111-8111-111111111111",
    eventType: "HOLD_CREATED" as const,
    sessionId: "22222222-2222-4222-8222-222222222222",
    serverTimestamp: new Date().toISOString(),
  };

  it("sends the bearer token only in the Authorization header", async () => {
    let captured: RequestInit | undefined;
    const transport = new UpstashRestInventoryEventTransport(
      "https://endpoint.upstash.io",
      "secret-token-value",
      environment,
      (async (_url: string, init: RequestInit) => {
        captured = init;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    );

    await transport.publish(event);
    expect((captured?.headers as Record<string, string>).Authorization).toBe(
      "Bearer secret-token-value",
    );
    expect(String(captured?.body)).not.toContain("secret-token-value");
  });

  it("reports only the status on failure, never the provider body", async () => {
    // An Upstash error body quotes the command, and the command carries the
    // stream key and the serialized event.
    const transport = new UpstashRestInventoryEventTransport(
      "https://endpoint.upstash.io",
      "secret-token-value",
      environment,
      (async () =>
        new Response("ERR unknown command 'seatflow:staging:inventory-events'", {
          status: 500,
        })) as unknown as typeof fetch,
    );

    await expect(transport.publish(event)).rejects.toThrow(/status 500/);
    const error = await transport.publish(event).catch((thrown: Error) => thrown);
    expect((error as Error).message).not.toContain("seatflow:staging");
  });
});

describe("deployed notification provider registry", () => {
  const resendEnvironment = {
    NOTIFICATION_PROVIDER: "RESEND",
    RESEND_API_KEY: "re_abcdefghijklmnopqrstuvwxyz",
    RESEND_FROM_ADDRESS: "SeatFlow <onboarding@resend.dev>",
    RESEND_MODE: "test",
    RESEND_TEST_RECIPIENT: "operator@example.com",
    RESEND_REQUEST_TIMEOUT_MS: 15_000,
  } as never;

  it("builds the Resend adapter with a display-name sender", () => {
    // The Phase 5C2A validator rejected this sender form outright.
    const provider = createDeployedNotificationProvider(resendEnvironment);
    expect(provider.name).toBe("RESEND");
    expect(provider.capabilityReport()).toMatchObject({
      mode: "test",
      redirectsToTestRecipient: true,
    });
  });

  it("refuses the local file adapter permanently", () => {
    // A serverless filesystem is ephemeral, so captured mail would vanish with
    // the invocation. Retrying cannot help, hence the PERMANENT_ prefix.
    expect(() =>
      createDeployedNotificationProvider({
        NOTIFICATION_PROVIDER: "LOCAL_FILE",
        LOCAL_EMAIL_CAPTURE_DIR: "tmp/seatflow-mail",
      } as never),
    ).toThrow(/^PERMANENT_LOCAL_FILE_PROVIDER_UNAVAILABLE/);
  });

  it("refuses an incomplete Resend configuration permanently", () => {
    expect(() =>
      createDeployedNotificationProvider({
        NOTIFICATION_PROVIDER: "RESEND",
        RESEND_API_KEY: "re_abcdefghijklmnopqrstuvwxyz",
      } as never),
    ).toThrow(/^PERMANENT_RESEND_CONFIGURATION_INCOMPLETE/);
  });

  it("refuses an unconfigured provider permanently", () => {
    expect(() =>
      createDeployedNotificationProvider({ NOTIFICATION_PROVIDER: "EXTERNAL" } as never),
    ).toThrow(/^PERMANENT_NOTIFICATION_PROVIDER_NOT_CONFIGURED/);
  });

  it("never quotes the API key in a failure", () => {
    const key = "re_supersecretkeymaterial123456";
    const error = (() => {
      try {
        createDeployedNotificationProvider({
          NOTIFICATION_PROVIDER: "RESEND",
          RESEND_API_KEY: key,
        } as never);
        return null;
      } catch (thrown) {
        return thrown as Error;
      }
    })();
    expect(error?.message).not.toContain(key);
  });
});

describe("Upstash REST rate-limit backend", () => {
  it("returns the window count", async () => {
    const backend = new UpstashRestRateLimitBackend(
      { restUrl: "https://endpoint.upstash.io", restToken: "token" },
      (async () => new Response(JSON.stringify({ result: 4 }), { status: 200 })) as never,
    );
    await expect(backend.increment("key", 60_000, 250)).resolves.toBe(4);
  });

  it("throws on a non-2xx so the caller falls back to the local limiter", async () => {
    const backend = new UpstashRestRateLimitBackend(
      { restUrl: "https://endpoint.upstash.io", restToken: "token" },
      (async () => new Response("nope", { status: 429 })) as never,
    );
    await expect(backend.increment("key", 60_000, 250)).rejects.toThrow(/429/);
  });

  it("reports unavailable rather than throwing from the health probe", async () => {
    const backend = new UpstashRestRateLimitBackend(
      { restUrl: "https://endpoint.upstash.io", restToken: "token" },
      (async () => {
        throw new Error("network down");
      }) as never,
    );
    await expect(backend.available(250)).resolves.toBe(false);
  });

  it("never places the token in the request body", async () => {
    let captured: RequestInit | undefined;
    const backend = new UpstashRestRateLimitBackend(
      { restUrl: "https://endpoint.upstash.io", restToken: "super-secret-token" },
      (async (_url: string, init: RequestInit) => {
        captured = init;
        return new Response(JSON.stringify({ result: 1 }), { status: 200 });
      }) as never,
    );
    await backend.increment("seatflow:staging:rl:abc", 60_000, 250);
    expect(String(captured?.body)).not.toContain("super-secret-token");
  });
});
