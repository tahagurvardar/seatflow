import { describe, expect, it } from "vitest";

import {
  classifyNeonConnection,
  isLoopbackHost,
  looksLikePlaceholder,
  LOCAL_ONLY_VARIABLES,
  REQUIRED_STAGING_VARIABLES,
  validateStagingSecrets,
  type EnvironmentSource,
} from "../src/features/operations/staging-secrets";
import {
  isBareEmailAddress,
  parseSenderAddress,
  senderEmailAddress,
} from "../src/features/notifications/sender-address";
import {
  DEFAULT_POLL_INTERVAL_MS,
  MAXIMUM_POLL_INTERVAL_MS,
  MINIMUM_POLL_INTERVAL_MS,
  realtimeUrlForClient,
  resolvePollIntervalMs,
  resolveRealtimeEndpoint,
} from "../src/features/inventory-events/realtime-endpoint";

/**
 * Staging secret validation, sender addresses, and the realtime fallback.
 *
 * The single property the validator must never lose is that a finding names a
 * variable and never quotes its value, so its output stays safe to print, paste
 * into an issue, or attach to a report. Several tests below assert exactly that.
 */

const POOLED = "postgresql://u:p@ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech/neondb";
const DIRECT = "postgresql://u:p@ep-cool-name-123456.eu-central-1.aws.neon.tech/neondb";

function stagingSecrets(overrides: EnvironmentSource = {}): EnvironmentSource {
  return {
    DATABASE_URL: POOLED,
    DIRECT_URL: DIRECT,
    BETTER_AUTH_SECRET: "staging-auth-secret-4f8b2e91c7a60d35be18",
    BETTER_AUTH_URL: "https://seatflow-staging.vercel.app",
    NEXT_PUBLIC_APP_URL: "https://seatflow-staging.vercel.app",
    TICKET_CREDENTIAL_SECRET: "staging-ticket-secret-77c1a4de930fb268a5",
    LOCAL_PAYMENT_WEBHOOK_SECRET: "staging-local-payment-6b2d94af10ce7385",
    PAYMENT_PROVIDER: "LOCAL_SIGNED",
    NOTIFICATION_PROVIDER: "RESEND",
    RESEND_API_KEY: "re_abcdefghijklmnopqrstuvwxyz",
    RESEND_FROM_ADDRESS: "SeatFlow <onboarding@resend.dev>",
    RESEND_MODE: "test",
    RESEND_TEST_RECIPIENT: "operator@personal-domain.test",
    QSTASH_CURRENT_SIGNING_KEY: "sig_current_signing_key_value_00000",
    QSTASH_NEXT_SIGNING_KEY: "sig_next_signing_key_value_1111111",
    SEATFLOW_DEPLOYMENT_PROFILE: "staging-demo",
    SEATFLOW_JOB_MODE: "serverless",
    REDIS_STREAM_PREFIX: "seatflow:staging",
    REDIS_URL: "rediss://default:token@endpoint.upstash.io:6379",
    UPSTASH_REDIS_REST_URL: "https://endpoint.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "upstash-rest-token-value",
    QSTASH_TOKEN: "qstash-publishing-token-value",
    SEATFLOW_STAGING_ORIGIN: "https://seatflow-staging.vercel.app",
    SEATFLOW_INTERNAL_JOB_ORIGIN: "https://seatflow-staging.vercel.app",
    ...overrides,
  };
}

describe("Neon connection classification", () => {
  it("recognizes the pooled endpoint by its -pooler host label", () => {
    expect(classifyNeonConnection(POOLED)).toBe("pooled");
  });

  it("recognizes the direct endpoint", () => {
    expect(classifyNeonConnection(DIRECT)).toBe("direct");
  });

  it("does not classify a non-Neon database", () => {
    expect(classifyNeonConnection("postgresql://u:p@localhost:5432/seatflow")).toBe("not-neon");
  });

  it("reports an unusable value as invalid rather than guessing", () => {
    expect(classifyNeonConnection(undefined)).toBe("invalid");
    expect(classifyNeonConnection("not-a-url")).toBe("invalid");
    expect(classifyNeonConnection("redis://endpoint:6379")).toBe("invalid");
  });

  it("does not mistake a -pooler substring elsewhere in the host", () => {
    expect(
      classifyNeonConnection("postgresql://u:p@ep-poolerish.eu-central-1.aws.neon.tech/db"),
    ).toBe("direct");
  });
});

describe("staging secret validation", () => {
  it("passes a correctly configured environment", () => {
    const report = validateStagingSecrets(stagingSecrets());
    expect(report.errorCount).toBe(0);
    expect(report.passed).toBe(true);
    expect(report.missingVariables).toEqual([]);
  });

  it("names every missing required variable", () => {
    const report = validateStagingSecrets({});
    expect(report.missingVariables).toEqual([...REQUIRED_STAGING_VARIABLES]);
    expect(report.passed).toBe(false);
  });

  it("detects the pooled/direct swap", () => {
    // Migrations against the pooler fail confusingly, and a runtime without
    // the pooler exhausts Neon's connection limit under serverless fan-out.
    const report = validateStagingSecrets(
      stagingSecrets({ DATABASE_URL: DIRECT, DIRECT_URL: POOLED }),
    );
    const ids = report.findings.map((finding) => finding.id);
    expect(ids).toContain("database_url_not_pooled");
    expect(ids).toContain("direct_url_pooled");
  });

  it("rejects identical pooled and direct URLs", () => {
    const report = validateStagingSecrets(
      stagingSecrets({ DATABASE_URL: DIRECT, DIRECT_URL: DIRECT }),
    );
    expect(report.findings.map((finding) => finding.id)).toContain("database_urls_identical");
  });

  it("detects a local development database", () => {
    const report = validateStagingSecrets(
      stagingSecrets({ DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/seatflow" }),
    );
    expect(report.findings.map((finding) => finding.id)).toContain("database_local");
  });

  it("detects placeholders left in the template", () => {
    for (const value of [
      "replace-with-at-least-32-random-characters",
      "your-secret-here",
      "re_replace_with_your_own_key",
      "qa-inbox@example.com",
      "<the address on your resend account>",
    ]) {
      expect(looksLikePlaceholder(value)).toBe(true);
    }
    const report = validateStagingSecrets(
      stagingSecrets({ BETTER_AUTH_SECRET: "replace-with-at-least-32-random-characters" }),
    );
    expect(report.findings.map((finding) => finding.id)).toContain("placeholder_value");
  });

  it("does not mistake a display-name sender for a placeholder", () => {
    // `SeatFlow <onboarding@resend.dev>` is a valid RFC 5322 mailbox. Treating
    // its angle brackets as a template marker would reject a correct value.
    expect(looksLikePlaceholder("SeatFlow <onboarding@resend.dev>")).toBe(false);
    const report = validateStagingSecrets(stagingSecrets());
    expect(
      report.findings.filter((finding) => finding.variable === "RESEND_FROM_ADDRESS"),
    ).toEqual([]);
  });

  it("refuses live Stripe values outright", () => {
    const report = validateStagingSecrets(
      stagingSecrets({ STRIPE_SECRET_KEY: "sk_live_realkeymaterial", STRIPE_MODE: "live" }),
    );
    const ids = report.findings.map((finding) => finding.id);
    expect(ids).toContain("stripe_credentials_present");
    expect(ids).toContain("stripe_live_key");
    expect(ids).toContain("stripe_live_mode");
  });

  it("refuses any Stripe credential, test or live", () => {
    // There is no Stripe account for this project at all.
    const report = validateStagingSecrets(
      stagingSecrets({ STRIPE_SECRET_KEY: "sk_test_abc123" }),
    );
    expect(report.findings.map((finding) => finding.id)).toContain("stripe_credentials_present");
  });

  it("refuses local-only variables in a hosted environment", () => {
    for (const name of LOCAL_ONLY_VARIABLES) {
      const report = validateStagingSecrets(stagingSecrets({ [name]: "some-value" }));
      const finding = report.findings.find((entry) => entry.variable === name);
      expect(finding?.id).toBe("local_only_variable");
    }
  });

  it("rejects real provider credentials in isolated E2E mode", () => {
    const report = validateStagingSecrets(stagingSecrets(), { isolatedE2E: true });
    const credentialFindings = report.findings.filter(
      (finding) => finding.id === "real_credential_in_e2e",
    );
    expect(credentialFindings.map((finding) => finding.variable)).toEqual(
      expect.arrayContaining([
        "RESEND_API_KEY",
        "QSTASH_TOKEN",
        "QSTASH_CURRENT_SIGNING_KEY",
        "UPSTASH_REDIS_REST_TOKEN",
      ]),
    );
  });

  it("requires TLS for a hosted Redis", () => {
    const report = validateStagingSecrets(
      stagingSecrets({ REDIS_URL: "redis://default:token@endpoint.upstash.io:6379" }),
    );
    expect(report.findings.map((finding) => finding.id)).toContain("redis_not_tls");
  });

  it("requires a REST token whenever a REST URL is present", () => {
    const report = validateStagingSecrets(
      stagingSecrets({ UPSTASH_REDIS_REST_TOKEN: undefined }),
    );
    expect(report.findings.map((finding) => finding.id)).toContain("upstash_token_missing");
  });

  it("rejects a weak or reused secret", () => {
    const shared = "shared-secret-value-9f2c8a17b30de645cc";
    const report = validateStagingSecrets(
      stagingSecrets({ BETTER_AUTH_SECRET: shared, TICKET_CREDENTIAL_SECRET: shared }),
    );
    expect(report.findings.map((finding) => finding.id)).toContain("secret_reuse");

    const weak = validateStagingSecrets(stagingSecrets({ BETTER_AUTH_SECRET: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }));
    expect(weak.findings.map((finding) => finding.id)).toContain("secret_weak");
  });

  it("rejects identical QStash signing keys", () => {
    const key = "sig_current_signing_key_value_00000";
    const report = validateStagingSecrets(
      stagingSecrets({ QSTASH_CURRENT_SIGNING_KEY: key, QSTASH_NEXT_SIGNING_KEY: key }),
    );
    expect(report.findings.map((finding) => finding.id)).toContain("qstash_keys_identical");
  });

  it("rejects a loopback or plaintext origin", () => {
    expect(
      validateStagingSecrets(stagingSecrets({ NEXT_PUBLIC_APP_URL: "http://localhost:3000" }))
        .findings.map((finding) => finding.id),
    ).toContain("origin_local");
    expect(
      validateStagingSecrets(stagingSecrets({ NEXT_PUBLIC_APP_URL: "http://seatflow.vercel.app" }))
        .findings.map((finding) => finding.id),
    ).toContain("origin_insecure");
  });

  it("never includes a value in any finding or in the present-variable list", () => {
    // This is the property that makes the report safe to print.
    const secrets = stagingSecrets({
      BETTER_AUTH_SECRET: "replace-with-at-least-32-random-characters",
      STRIPE_SECRET_KEY: "sk_live_supersecretkeymaterial",
      DATABASE_URL: DIRECT,
    });
    const report = validateStagingSecrets(secrets);
    const serialized = JSON.stringify({
      findings: report.findings,
      present: report.presentVariables,
      missing: report.missingVariables,
    });

    for (const value of Object.values(secrets)) {
      if (!value || value.length < 12) continue;
      expect(serialized).not.toContain(value);
    }
  });

  it("reports present variables by name only", () => {
    const report = validateStagingSecrets(stagingSecrets());
    expect(report.presentVariables).toContain("RESEND_API_KEY");
    expect(report.presentVariables).not.toContain("re_abcdefghijklmnopqrstuvwxyz");
  });
});

describe("loopback host detection", () => {
  it("recognizes every loopback form", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "0.0.0.0", "dev.local", "app.localhost"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it("does not flag a hosted endpoint", () => {
    expect(isLoopbackHost("seatflow-staging.vercel.app")).toBe(false);
    expect(isLoopbackHost("ep-x.eu-central-1.aws.neon.tech")).toBe(false);
  });
});

describe("sender addresses", () => {
  it("accepts a display-name mailbox, which every provider expects", () => {
    // The Phase 5C2A validator rejected this form, so a correctly configured
    // `From` could not boot.
    expect(parseSenderAddress("SeatFlow <onboarding@resend.dev>")).toEqual({
      displayName: "SeatFlow",
      address: "onboarding@resend.dev",
    });
  });

  it("accepts a bare address", () => {
    expect(parseSenderAddress("tickets@example.com")).toEqual({
      displayName: null,
      address: "tickets@example.com",
    });
  });

  it("accepts a quoted display name", () => {
    expect(parseSenderAddress('"SeatFlow Tickets" <tickets@example.com>')).toEqual({
      displayName: "SeatFlow Tickets",
      address: "tickets@example.com",
    });
  });

  it("accepts angle brackets with no display name", () => {
    expect(parseSenderAddress("<tickets@example.com>")).toEqual({
      displayName: null,
      address: "tickets@example.com",
    });
  });

  it("refuses anything that could restructure a header", () => {
    for (const value of [
      "SeatFlow <tickets@example.com>\r\nBcc: victim@example.com",
      "Seat\nFlow <tickets@example.com>",
      "Seat,Flow <tickets@example.com>",
      "Seat;Flow <tickets@example.com>",
      'Seat"Flow <tickets@example.com>',
    ]) {
      expect(parseSenderAddress(value)).toBeNull();
    }
  });

  it("refuses a malformed or multi-address value", () => {
    for (const value of [
      "not-an-address",
      "SeatFlow <not-an-address>",
      "a@b.com, c@d.com",
      "SeatFlow <a@b.com> <c@d.com>",
      "",
    ]) {
      expect(parseSenderAddress(value)).toBeNull();
    }
  });

  it("bounds the overall length and the display name", () => {
    expect(parseSenderAddress(`${"n".repeat(400)} <a@b.com>`)).toBeNull();
    expect(parseSenderAddress(`${"n".repeat(65)} <a@b.com>`)).toBeNull();
  });

  it("keeps recipient validation strictly bare", () => {
    // Only senders may carry a display name.
    expect(isBareEmailAddress("SeatFlow <onboarding@resend.dev>")).toBe(false);
    expect(isBareEmailAddress("onboarding@resend.dev")).toBe(true);
  });

  it("extracts the bare address for comparison", () => {
    expect(senderEmailAddress("SeatFlow <onboarding@resend.dev>")).toBe("onboarding@resend.dev");
    expect(senderEmailAddress("nonsense")).toBeNull();
  });
});

describe("realtime endpoint resolution and polling fallback", () => {
  it("polls when no gateway is configured", () => {
    // The normal case on a serverless deployment: there is no gateway at all.
    expect(resolveRealtimeEndpoint({})).toEqual({ mode: "poll", reason: "NOT_CONFIGURED" });
    expect(resolveRealtimeEndpoint({ NEXT_PUBLIC_REALTIME_URL: "  " })).toEqual({
      mode: "poll",
      reason: "NOT_CONFIGURED",
    });
  });

  it("never points a hosted deployment at loopback", () => {
    // The old default sent every visitor's browser to their own machine.
    for (const url of ["http://localhost:3001", "http://127.0.0.1:3001", "http://dev.local:3001"]) {
      expect(
        resolveRealtimeEndpoint({ NEXT_PUBLIC_REALTIME_URL: url }, { hosted: true }),
      ).toEqual({ mode: "poll", reason: "LOOPBACK_ON_HOSTED_DEPLOYMENT" });
    }
  });

  it("still allows a loopback gateway in local development", () => {
    expect(
      resolveRealtimeEndpoint({ NEXT_PUBLIC_REALTIME_URL: "http://localhost:3001" }),
    ).toEqual({ mode: "socket", url: "http://localhost:3001" });
  });

  it("uses a configured hosted gateway", () => {
    expect(
      resolveRealtimeEndpoint(
        { NEXT_PUBLIC_REALTIME_URL: "https://realtime.example.com" },
        { hosted: true },
      ),
    ).toEqual({ mode: "socket", url: "https://realtime.example.com" });
  });

  it("polls rather than throwing on an unusable URL", () => {
    for (const url of ["not-a-url", "ws://realtime.example.com", "file:///etc/passwd"]) {
      expect(resolveRealtimeEndpoint({ NEXT_PUBLIC_REALTIME_URL: url })).toMatchObject({
        mode: "poll",
        reason: "INVALID_URL",
      });
    }
  });

  it("gives the client an empty string when polling", () => {
    // Empty is the hook's existing signal for "no socket", so the polling path
    // needs no new client contract.
    expect(realtimeUrlForClient({}, { hosted: true })).toBe("");
    expect(
      realtimeUrlForClient({ NEXT_PUBLIC_REALTIME_URL: "http://localhost:3001" }, { hosted: true }),
    ).toBe("");
  });

  it("bounds the poll interval", () => {
    expect(resolvePollIntervalMs(undefined)).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(resolvePollIntervalMs("not-a-number")).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(resolvePollIntervalMs("100")).toBe(MINIMUM_POLL_INTERVAL_MS);
    expect(resolvePollIntervalMs("99999999")).toBe(MAXIMUM_POLL_INTERVAL_MS);
    expect(resolvePollIntervalMs("60000")).toBe(60_000);
  });
});
