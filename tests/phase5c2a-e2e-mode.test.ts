import { describe, expect, it } from "vitest";

import {
  evaluateIsolatedE2EMode,
  isIsolatedE2EMode,
  type EnvironmentSource,
} from "../src/features/operations/e2e-test-mode";
import { readPaymentEnvironment } from "../src/env/schema";
import { LocalSignedPaymentProvider } from "../src/server/payments/local-signed-provider";
import { validateProductionConfiguration } from "../src/features/operations/production-check";

/**
 * The isolated-E2E override.
 *
 * These tests exist to prove the exception is narrow. The interesting cases are
 * the refusals: a single satisfied condition must never be enough.
 */

/** A configuration that genuinely is an isolated harness. */
function isolatedHarness(overrides: EnvironmentSource = {}): EnvironmentSource {
  return {
    SEATFLOW_E2E_TEST_MODE: "true",
    DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/seatflow_test",
    DIRECT_URL: "postgresql://postgres:postgres@127.0.0.1:5432/seatflow_test",
    BETTER_AUTH_URL: "http://127.0.0.1:3000",
    NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
    LOCAL_PAYMENT_WEBHOOK_SECRET: "browser-e2e-synthetic-secret-0000000000000",
    ...overrides,
  };
}

describe("isolated E2E mode", () => {
  it("recognizes a genuine harness", () => {
    expect(evaluateIsolatedE2EMode(isolatedHarness())).toEqual({ enabled: true });
    expect(isIsolatedE2EMode(isolatedHarness())).toBe(true);
  });

  it("refuses when the flag alone is set", () => {
    // The flag proves nothing on its own; this is the whole point.
    expect(
      evaluateIsolatedE2EMode({ SEATFLOW_E2E_TEST_MODE: "true" }),
    ).toMatchObject({ enabled: false, reason: "DATABASE_NOT_TEST_MARKED" });
  });

  it("refuses without the flag even when everything else is isolated", () => {
    expect(
      evaluateIsolatedE2EMode(isolatedHarness({ SEATFLOW_E2E_TEST_MODE: undefined })),
    ).toMatchObject({ enabled: false, reason: "FLAG_NOT_SET" });
    expect(
      evaluateIsolatedE2EMode(isolatedHarness({ SEATFLOW_E2E_TEST_MODE: "1" })),
    ).toMatchObject({ enabled: false, reason: "FLAG_NOT_SET" });
  });

  it("refuses a database that is not clearly disposable", () => {
    for (const url of [
      "postgresql://postgres:postgres@127.0.0.1:5432/seatflow",
      "postgresql://postgres:postgres@db.internal:5432/production",
      undefined,
    ]) {
      expect(
        evaluateIsolatedE2EMode(isolatedHarness({ DATABASE_URL: url })),
      ).toMatchObject({ enabled: false, reason: "DATABASE_NOT_TEST_MARKED" });
    }
  });

  it("refuses the protected database even if its name looks like a test", () => {
    const protectedUrl = "postgresql://postgres:postgres@db.internal:5432/seatflow_test";
    expect(
      evaluateIsolatedE2EMode(
        isolatedHarness({
          DATABASE_URL: protectedUrl,
          SEATFLOW_PROTECTED_DATABASE_URL: protectedUrl,
        }),
      ),
    ).toMatchObject({ enabled: false, reason: "DATABASE_IS_PROTECTED" });
  });

  it("refuses a routable origin", () => {
    expect(
      evaluateIsolatedE2EMode(isolatedHarness({ BETTER_AUTH_URL: "https://seatflow.example" })),
    ).toMatchObject({ enabled: false, reason: "ORIGIN_NOT_LOOPBACK" });
    expect(
      evaluateIsolatedE2EMode(
        isolatedHarness({ NEXT_PUBLIC_APP_URL: "https://seatflow.example" }),
      ),
    ).toMatchObject({ enabled: false, reason: "ORIGIN_NOT_LOOPBACK" });
  });

  it("refuses a missing or weak local secret", () => {
    expect(
      evaluateIsolatedE2EMode(isolatedHarness({ LOCAL_PAYMENT_WEBHOOK_SECRET: undefined })),
    ).toMatchObject({ enabled: false, reason: "LOCAL_SECRET_MISSING" });
    expect(
      evaluateIsolatedE2EMode(isolatedHarness({ LOCAL_PAYMENT_WEBHOOK_SECRET: "short" })),
    ).toMatchObject({ enabled: false, reason: "LOCAL_SECRET_MISSING" });
  });

  it("refuses outright when real provider credentials are present", () => {
    // A process that can reach a real provider is not a sealed harness.
    expect(
      evaluateIsolatedE2EMode(
        isolatedHarness({ STRIPE_SECRET_KEY: "sk_live_9fJ2kQx7ZmR4bTvN6yWc3HsD" }),
      ),
    ).toMatchObject({ enabled: false, reason: "REAL_PROVIDER_CREDENTIALS_PRESENT" });
    expect(
      evaluateIsolatedE2EMode(isolatedHarness({ RESEND_API_KEY: "re_9fJ2kQx7ZmR4bTvN6" })),
    ).toMatchObject({ enabled: false, reason: "REAL_PROVIDER_CREDENTIALS_PRESENT" });
  });
});

describe("payment environment under a production build", () => {
  const base = {
    NODE_ENV: "production",
    PAYMENT_PROVIDER: "LOCAL_SIGNED",
  } as const;

  it("still forbids LOCAL_SIGNED for a real production deployment", () => {
    expect(() =>
      readPaymentEnvironment({
        ...base,
        LOCAL_PAYMENT_WEBHOOK_SECRET: "a-real-deployments-secret-000000000000000",
        DATABASE_URL: "postgresql://app:pw@db.internal:5432/seatflow",
        BETTER_AUTH_URL: "https://seatflow.example",
        NEXT_PUBLIC_APP_URL: "https://seatflow.example",
      }),
    ).toThrow(/LOCAL_SIGNED is forbidden in production/);
  });

  it("permits LOCAL_SIGNED only inside a genuine isolated harness", () => {
    const environment = readPaymentEnvironment({ ...base, ...isolatedHarness() });
    expect(environment.PAYMENT_PROVIDER).toBe("LOCAL_SIGNED");
  });

  it("constructs the simulated provider only inside the harness", () => {
    // Without the harness environment, a production runtime refuses it.
    expect(
      () =>
        new LocalSignedPaymentProvider(
          { current: "some-secret-that-is-long-enough-0000000000" },
          "production",
        ),
    ).toThrow(/disabled in production/);
  });
});

describe("production:check rejects the override", () => {
  it("blocks any production configuration carrying the E2E flag", () => {
    const findings = validateProductionConfiguration({
      env: {
        NODE_ENV: "production",
        SEATFLOW_E2E_TEST_MODE: "true",
        PAYMENT_PROVIDER: "STRIPE",
        NOTIFICATION_PROVIDER: "RESEND",
      },
    });
    expect(findings.map((finding) => finding.id)).toContain("e2e_test_mode_enabled");
  });

  it("does not raise the finding when the flag is absent", () => {
    const findings = validateProductionConfiguration({
      env: { NODE_ENV: "production", PAYMENT_PROVIDER: "STRIPE" },
    });
    expect(findings.map((finding) => finding.id)).not.toContain("e2e_test_mode_enabled");
  });
});
