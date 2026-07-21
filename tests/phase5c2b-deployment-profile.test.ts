import { describe, expect, it } from "vitest";

import {
  evaluateStagingDemoMode,
  isRealProductionDeployment,
  isStagingDemoMode,
  isStagingOrigin,
  permitsSimulatedPaymentProvider,
  profileCapabilities,
  resolveDeploymentProfile,
  type EnvironmentSource,
} from "../src/features/operations/deployment-profile";
import { LocalSignedPaymentProvider } from "../src/server/payments/local-signed-provider";
import { readPaymentEnvironment } from "../src/env/schema";
import {
  describePaymentCapability,
  validateProductionConfiguration,
  validateStagingDemoConfiguration,
} from "../src/features/operations/production-check";

/**
 * The staging-demo override.
 *
 * Same shape as the isolated-E2E suite, and for the same reason: the exception
 * permits a simulated payment provider on a production build, so the tests that
 * matter are the refusals. Any single satisfied condition must never be enough,
 * and a claimed-but-invalid staging demo must fall back to production rules
 * rather than to something permissive.
 */

/** A configuration that genuinely is an isolated staging demo. */
function stagingDemo(overrides: EnvironmentSource = {}): EnvironmentSource {
  return {
    NODE_ENV: "production",
    SEATFLOW_DEPLOYMENT_PROFILE: "staging-demo",
    BETTER_AUTH_URL: "https://seatflow-staging.vercel.app",
    NEXT_PUBLIC_APP_URL: "https://seatflow-staging.vercel.app",
    PAYMENT_PROVIDER: "LOCAL_SIGNED",
    LOCAL_PAYMENT_WEBHOOK_SECRET: "staging-demo-simulated-secret-9f3a2c7b81de44",
    NOTIFICATION_PROVIDER: "RESEND",
    RESEND_MODE: "test",
    RESEND_TEST_RECIPIENT: "operator@example.com",
    ...overrides,
  };
}

describe("staging origin recognition", () => {
  it("accepts an https vercel.app subdomain", () => {
    expect(isStagingOrigin("https://seatflow-staging.vercel.app")).toBe(true);
    expect(isStagingOrigin("https://vercel.app")).toBe(true);
  });

  it("refuses plaintext even on vercel.app", () => {
    expect(isStagingOrigin("http://seatflow-staging.vercel.app")).toBe(false);
  });

  it("refuses a lookalike host", () => {
    // The suffix check must be on a label boundary, not a substring.
    for (const origin of [
      "https://vercel.app.evil.example",
      "https://notvercel.app.example.com",
      "https://seatflow.com",
    ]) {
      expect(isStagingOrigin(origin)).toBe(false);
    }
  });

  it("accepts a declared staging origin only when it matches exactly", () => {
    const declared = "https://staging.example.com";
    expect(isStagingOrigin("https://staging.example.com", declared)).toBe(true);
    expect(isStagingOrigin("https://other.example.com", declared)).toBe(false);
    expect(isStagingOrigin("https://staging.example.com")).toBe(false);
  });

  it("refuses an unparseable value", () => {
    expect(isStagingOrigin("not-a-url")).toBe(false);
    expect(isStagingOrigin(undefined)).toBe(false);
  });
});

describe("staging demo mode", () => {
  it("recognizes a genuine staging demo", () => {
    expect(evaluateStagingDemoMode(stagingDemo())).toEqual({ enabled: true });
    expect(isStagingDemoMode(stagingDemo())).toBe(true);
  });

  it("refuses when the profile flag alone is set", () => {
    expect(
      evaluateStagingDemoMode({ SEATFLOW_DEPLOYMENT_PROFILE: "staging-demo" }),
    ).toMatchObject({ enabled: false, reason: "NOT_PRODUCTION_BUILD" });
  });

  it("refuses without the profile flag even when everything else holds", () => {
    expect(
      evaluateStagingDemoMode(stagingDemo({ SEATFLOW_DEPLOYMENT_PROFILE: undefined })),
    ).toMatchObject({ enabled: false, reason: "PROFILE_NOT_STAGING_DEMO" });
  });

  it("refuses a non-staging origin", () => {
    for (const origin of ["https://seatflow.com", "http://localhost:3000", undefined]) {
      expect(
        evaluateStagingDemoMode(stagingDemo({ NEXT_PUBLIC_APP_URL: origin })),
      ).toMatchObject({ enabled: false, reason: "ORIGIN_NOT_STAGING" });
    }
  });

  it("requires BOTH origins to be staging hosts", () => {
    // Checking only one would let a deployment serve a real domain while
    // claiming demo status through the other.
    expect(
      evaluateStagingDemoMode(stagingDemo({ BETTER_AUTH_URL: "https://seatflow.com" })),
    ).toMatchObject({ enabled: false, reason: "ORIGIN_NOT_STAGING" });
  });

  it("refuses any payment provider other than the simulated one", () => {
    for (const provider of ["STRIPE", "EXTERNAL", undefined]) {
      expect(
        evaluateStagingDemoMode(stagingDemo({ PAYMENT_PROVIDER: provider })),
      ).toMatchObject({ enabled: false, reason: "PAYMENT_PROVIDER_NOT_LOCAL_SIGNED" });
    }
  });

  it("refuses a missing or short local webhook secret", () => {
    for (const secret of [undefined, "too-short"]) {
      expect(
        evaluateStagingDemoMode(stagingDemo({ LOCAL_PAYMENT_WEBHOOK_SECRET: secret })),
      ).toMatchObject({ enabled: false, reason: "LOCAL_SECRET_MISSING" });
    }
  });

  it("refuses outright when a Stripe credential is present", () => {
    // A process that can reach a payment network is not a simulated demo,
    // whatever else it claims about itself.
    expect(
      evaluateStagingDemoMode(stagingDemo({ STRIPE_SECRET_KEY: "sk_test_abc123" })),
    ).toMatchObject({ enabled: false, reason: "STRIPE_CREDENTIALS_PRESENT" });
    expect(
      evaluateStagingDemoMode(stagingDemo({ STRIPE_WEBHOOK_SECRET_CURRENT: "whsec_abc" })),
    ).toMatchObject({ enabled: false, reason: "STRIPE_CREDENTIALS_PRESENT" });
  });

  it("refuses a live provider mode", () => {
    expect(
      evaluateStagingDemoMode(stagingDemo({ RESEND_MODE: "live" })),
    ).toMatchObject({ enabled: false, reason: "LIVE_PROVIDER_MODE" });
    expect(
      evaluateStagingDemoMode(stagingDemo({ STRIPE_MODE: "live" })),
    ).toMatchObject({ enabled: false, reason: "LIVE_PROVIDER_MODE" });
  });

  it("refuses when the production-launch marker is present", () => {
    expect(
      evaluateStagingDemoMode(stagingDemo({ SEATFLOW_PRODUCTION_LAUNCH: "true" })),
    ).toMatchObject({ enabled: false, reason: "PRODUCTION_LAUNCH_DECLARED" });
  });

  it("refuses a development build", () => {
    expect(
      evaluateStagingDemoMode(stagingDemo({ NODE_ENV: "development" })),
    ).toMatchObject({ enabled: false, reason: "NOT_PRODUCTION_BUILD" });
  });
});

describe("deployment profile resolution", () => {
  it("classifies a genuine staging demo", () => {
    expect(resolveDeploymentProfile(stagingDemo())).toBe("staging-demo");
    expect(isRealProductionDeployment(stagingDemo())).toBe(false);
  });

  it("treats a claimed-but-invalid staging demo as production", () => {
    // The dangerous failure would be downgrading to something permissive.
    const invalid = stagingDemo({ NEXT_PUBLIC_APP_URL: "https://seatflow.com" });
    expect(resolveDeploymentProfile(invalid)).toBe("production");
    expect(isRealProductionDeployment(invalid)).toBe(true);
  });

  it("defaults an undeclared production build to production", () => {
    // Forgetting to declare a profile must fail closed into the strictest
    // world, never into the most permissive one.
    expect(resolveDeploymentProfile({ NODE_ENV: "production" })).toBe("production");
  });

  it("defaults an undeclared non-production build to local", () => {
    expect(resolveDeploymentProfile({})).toBe("local");
    expect(resolveDeploymentProfile({ NODE_ENV: "development" })).toBe("local");
  });

  it("refuses to grant isolated-e2e by declaration alone", () => {
    expect(
      resolveDeploymentProfile({
        NODE_ENV: "production",
        SEATFLOW_DEPLOYMENT_PROFILE: "isolated-e2e",
      }),
    ).toBe("production");
  });

  it("recognizes a genuine isolated E2E harness ahead of any declaration", () => {
    expect(
      resolveDeploymentProfile({
        SEATFLOW_E2E_TEST_MODE: "true",
        DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/seatflow_test",
        BETTER_AUTH_URL: "http://127.0.0.1:3000",
        NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
        LOCAL_PAYMENT_WEBHOOK_SECRET: "browser-e2e-synthetic-secret-0000000000000",
        SEATFLOW_DEPLOYMENT_PROFILE: "production",
      }),
    ).toBe("isolated-e2e");
  });
});

describe("profile capabilities", () => {
  it("grants production nothing", () => {
    expect(profileCapabilities("production")).toEqual({
      allowsSimulatedPayments: false,
      allowsRedirectedEmail: false,
      allowsServerlessJobs: false,
      allowsPollingFallback: false,
      requiresDemoDisclosure: false,
    });
  });

  it("requires the staging demo to disclose itself", () => {
    expect(profileCapabilities("staging-demo").requiresDemoDisclosure).toBe(true);
    expect(profileCapabilities("staging-demo").allowsSimulatedPayments).toBe(true);
  });
});

describe("payment environment under each profile", () => {
  const base = {
    NODE_ENV: "production",
    PAYMENT_PROVIDER: "LOCAL_SIGNED",
    LOCAL_PAYMENT_WEBHOOK_SECRET: "staging-demo-simulated-secret-9f3a2c7b81de44",
  };

  it("permits LOCAL_SIGNED in a genuine staging demo", () => {
    expect(() => readPaymentEnvironment(stagingDemo())).not.toThrow();
  });

  it("still forbids LOCAL_SIGNED in real production", () => {
    // This is the rule Phase 5C2B must not weaken.
    expect(() => readPaymentEnvironment(base)).toThrow(/LOCAL_SIGNED is forbidden in production/);
  });

  it("forbids LOCAL_SIGNED when the demo claim fails one condition", () => {
    expect(() =>
      readPaymentEnvironment(stagingDemo({ STRIPE_SECRET_KEY: "sk_test_abc123" })),
    ).toThrow(/LOCAL_SIGNED is forbidden in production/);
    expect(() =>
      readPaymentEnvironment(stagingDemo({ NEXT_PUBLIC_APP_URL: "https://seatflow.com" })),
    ).toThrow(/LOCAL_SIGNED is forbidden in production/);
  });
});

describe("real-production configuration check", () => {
  it("still rejects every staging relaxation", () => {
    const findings = validateProductionConfiguration({ env: stagingDemo() });
    const ids = findings.map((finding) => finding.id);
    expect(ids).toContain("payment_provider_local");
    expect(ids).toContain("local_payment_secret_present");
    expect(ids).toContain("resend_test_mode_in_production");
  });
});

describe("staging-demo configuration check", () => {
  function stagingEnvironment(overrides: EnvironmentSource = {}) {
    return stagingDemo({
      SEATFLOW_JOB_MODE: "serverless",
      QSTASH_CURRENT_SIGNING_KEY: "sig_current_key_value_that_is_long_enough",
      QSTASH_NEXT_SIGNING_KEY: "sig_next_key_value_that_is_long_enough_xx",
      DATABASE_URL: "postgresql://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/neondb",
      DIRECT_URL: "postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/neondb",
      BETTER_AUTH_SECRET: "staging-auth-secret-4f8b2e91c7a60d35be18",
      TICKET_CREDENTIAL_SECRET: "staging-ticket-secret-77c1a4de930fb268a5",
      REDIS_STREAM_PREFIX: "seatflow:staging",
      REDIS_URL: "rediss://default:token@endpoint.upstash.io:6379",
      ...overrides,
    });
  }

  it("passes a correctly configured staging demo", () => {
    const findings = validateStagingDemoConfiguration({ env: stagingEnvironment() });
    expect(findings.filter((finding) => finding.severity === "error")).toEqual([]);
  });

  it("rejects a real payment provider", () => {
    const findings = validateStagingDemoConfiguration({
      env: stagingEnvironment({ PAYMENT_PROVIDER: "STRIPE", STRIPE_SECRET_KEY: "sk_test_x" }),
    });
    const ids = findings.map((finding) => finding.id);
    expect(ids).toContain("payment_provider_not_simulated");
    expect(ids).toContain("stripe_credentials_present");
  });

  it("rejects live email mode", () => {
    const findings = validateStagingDemoConfiguration({
      env: stagingEnvironment({ RESEND_MODE: "live" }),
    });
    expect(findings.map((finding) => finding.id)).toContain("resend_mode_not_test");
  });

  it("rejects missing QStash signing keys", () => {
    // Without them every delivery is rejected and scheduled work silently
    // never runs, which is worse than a loud failure.
    const findings = validateStagingDemoConfiguration({
      env: stagingEnvironment({ QSTASH_CURRENT_SIGNING_KEY: undefined }),
    });
    expect(findings.map((finding) => finding.id)).toContain("qstash_signing_key_missing");
  });

  it("rejects identical signing keys", () => {
    const findings = validateStagingDemoConfiguration({
      env: stagingEnvironment({ QSTASH_NEXT_SIGNING_KEY: "sig_current_key_value_that_is_long_enough" }),
    });
    expect(findings.map((finding) => finding.id)).toContain("qstash_keys_identical");
  });

  it("warns rather than fails when Redis is absent", () => {
    const findings = validateStagingDemoConfiguration({
      env: stagingEnvironment({ REDIS_URL: undefined, UPSTASH_REDIS_REST_URL: undefined }),
    });
    const redis = findings.find((finding) => finding.id === "redis_absent");
    expect(redis?.severity).toBe("warning");
  });

  it("never quotes a value in any finding", () => {
    const secret = "staging-demo-simulated-secret-9f3a2c7b81de44";
    const findings = validateStagingDemoConfiguration({
      env: stagingEnvironment({ PAYMENT_PROVIDER: "STRIPE" }),
    });
    for (const finding of findings) {
      expect(finding.message).not.toContain(secret);
    }
  });
});

describe("payment capability disclosure", () => {
  it("states plainly that simulated payments are not real", () => {
    const capability = describePaymentCapability({ PAYMENT_PROVIDER: "LOCAL_SIGNED" });
    expect(capability.realPaymentsAvailable).toBe(false);
    expect(capability.summary).toMatch(/simulated/i);
    expect(capability.summary).toMatch(/no money moves/i);
  });

  it("reports live Stripe honestly", () => {
    expect(
      describePaymentCapability({ PAYMENT_PROVIDER: "STRIPE", STRIPE_MODE: "live" }),
    ).toMatchObject({ realPaymentsAvailable: true });
  });

  it("does not claim capability without a configured adapter", () => {
    expect(describePaymentCapability({}).realPaymentsAvailable).toBe(false);
  });
});

describe("simulated provider construction under a production build", () => {
  /**
   * The Phase 5C2B deployed failure.
   *
   * Vercel builds the staging demo with NODE_ENV=production, so the provider's
   * own guard refused to construct and the hourly `refund-reconciliation` job
   * failed with "disabled in production" on a deployment that is, by every
   * declared condition, a staging demo. The guard consulted only the
   * isolated-E2E exception and never asked the profile policy.
   *
   * The refusals below matter more than the permission: each removes exactly
   * one condition from an otherwise-valid demo, and each must still throw.
   */
  const SECRET = "staging-demo-simulated-secret-9f3a2c7b81de44";

  it("permits a genuine staging demo on a production build", () => {
    // The exact deployed case that used to throw.
    expect(
      () => new LocalSignedPaymentProvider({ current: SECRET }, "production", stagingDemo()),
    ).not.toThrow();
    expect(permitsSimulatedPaymentProvider(stagingDemo())).toBe(true);
  });

  it("still refuses a real production deployment", () => {
    // The rule Phase 5C2B must not weaken.
    expect(
      () =>
        new LocalSignedPaymentProvider({ current: SECRET }, "production", {
          NODE_ENV: "production",
          PAYMENT_PROVIDER: "LOCAL_SIGNED",
          LOCAL_PAYMENT_WEBHOOK_SECRET: SECRET,
        }),
    ).toThrow(/disabled in production/i);
  });

  it("refuses every single-condition failure of the demo claim", () => {
    const refusals: Record<string, EnvironmentSource> = {
      "missing staging authorization": { SEATFLOW_DEPLOYMENT_PROFILE: undefined },
      "profile claims real production": { SEATFLOW_DEPLOYMENT_PROFILE: "production" },
      "invalid canonical origin (app)": { NEXT_PUBLIC_APP_URL: "https://seatflow.com" },
      "invalid canonical origin (auth)": { BETTER_AUTH_URL: "https://seatflow.com" },
      "plaintext origin": { NEXT_PUBLIC_APP_URL: "http://seatflow-staging.vercel.app" },
      "lookalike origin": { NEXT_PUBLIC_APP_URL: "https://vercel.app.evil.example" },
      "missing webhook secret": { LOCAL_PAYMENT_WEBHOOK_SECRET: undefined },
      "webhook secret too short": { LOCAL_PAYMENT_WEBHOOK_SECRET: "too-short" },
      "ambiguous provider selection": { PAYMENT_PROVIDER: "STRIPE" },
      "reachable payment network": { STRIPE_SECRET_KEY: "sk_test_abc123" },
      "reachable webhook credential": { STRIPE_WEBHOOK_SECRET_CURRENT: "whsec_abc123" },
      "live provider mode": { STRIPE_MODE: "live" },
      "live email mode": { RESEND_MODE: "live" },
      "production launch declared": { SEATFLOW_PRODUCTION_LAUNCH: "true" },
    };

    for (const [reason, override] of Object.entries(refusals)) {
      const environment = stagingDemo(override);
      expect(permitsSimulatedPaymentProvider(environment), reason).toBe(false);
      expect(
        () => new LocalSignedPaymentProvider({ current: SECRET }, "production", environment),
        reason,
      ).toThrow(/disabled in production/i);
    }
  });

  it("keeps the explicit runtime environment authoritative over the source", () => {
    // A caller that says "production" must be judged as production even if the
    // supplied map claims otherwise, so the two can never disagree.
    expect(
      () =>
        new LocalSignedPaymentProvider({ current: SECRET }, "production", {
          ...stagingDemo(),
          NODE_ENV: "development",
        }),
    ).not.toThrow();
  });

  it("does not weaken the short-secret rule", () => {
    expect(
      () => new LocalSignedPaymentProvider({ current: "short" }, "production", stagingDemo()),
    ).toThrow(/secret is too short/i);
  });
});
