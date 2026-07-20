import { describe, expect, it } from "vitest";

import {
  REQUIRED_WEBHOOK_EVENT_COVERAGE,
  summarizeFindings,
  validateProductionConfiguration,
  type EnvironmentSource,
  type ProductionCheckProbes,
} from "../src/features/operations/production-check";

/**
 * Phase 5C2A production gates.
 *
 * Every assertion here is about refusing to start, not about starting cleanly.
 * A finding never quotes a secret's value, so these tests also check that the
 * messages stay safe to print in a deployment log.
 */

/** A configuration that is otherwise production-ready, so each test isolates one gate. */
function productionEnvironment(overrides: EnvironmentSource = {}): EnvironmentSource {
  return {
    NODE_ENV: "production",
    PAYMENT_PROVIDER: "STRIPE",
    STRIPE_SECRET_KEY: "sk_live_9fJ2kQx7ZmR4bTvN6yWc3HsD",
    STRIPE_WEBHOOK_SECRET_CURRENT: "whsec_Kp7wQz2NxV9bLmR4tYs6HjF8gDc3ZaXe",
    STRIPE_MODE: "live",
    STRIPE_WEBHOOK_EVENTS: REQUIRED_WEBHOOK_EVENT_COVERAGE.join(","),
    NOTIFICATION_PROVIDER: "RESEND",
    RESEND_API_KEY: "re_9fJ2kQx7ZmR4bTvN6yWc3HsD",
    RESEND_FROM_ADDRESS: "tickets@seatflow.example",
    RESEND_MODE: "live",
    TICKET_CREDENTIAL_SECRET: "Kp7wQz2NxV9bLmR4tYs6HjF8gDc3ZaXe",
    BETTER_AUTH_SECRET: "Rj4mWq8ZtY2nKx6VbL9sHcD3gFa7ZeXp",
    DATABASE_URL: "postgresql://seatflow:secret@db.internal:5432/seatflow",
    BETTER_AUTH_URL: "https://seatflow.example",
    NEXT_PUBLIC_APP_URL: "https://seatflow.example",
    REDIS_URL: "rediss://cache.internal:6379",
    REDIS_STREAM_PREFIX: "seatflow:prod",
    SEATFLOW_DECLARED_WORKERS:
      "INVENTORY_OUTBOX_DISPATCHER,HOLD_EXPIRY_WORKER,REALTIME_GATEWAY,TICKET_ISSUANCE_DISPATCHER,NOTIFICATION_DISPATCHER,PAYMENT_RECONCILIATION",
    ...overrides,
  };
}

function findingIds(env: EnvironmentSource, probes?: ProductionCheckProbes) {
  return validateProductionConfiguration({ env, probes }).map((finding) => finding.id);
}

describe("Stripe production gates", () => {
  it("passes a fully configured live Stripe deployment", () => {
    const findings = validateProductionConfiguration({ env: productionEnvironment() });
    expect(summarizeFindings(findings).passed).toBe(true);
  });

  it("blocks the development adapter and an unnamed external adapter", () => {
    expect(findingIds(productionEnvironment({ PAYMENT_PROVIDER: "LOCAL_SIGNED" }))).toContain(
      "payment_provider_local",
    );
    expect(findingIds(productionEnvironment({ PAYMENT_PROVIDER: "EXTERNAL" }))).toContain(
      "payment_provider_gate",
    );
  });

  it("blocks missing Stripe credentials", () => {
    expect(findingIds(productionEnvironment({ STRIPE_SECRET_KEY: undefined }))).toContain(
      "stripe_secret_missing",
    );
    expect(
      findingIds(productionEnvironment({ STRIPE_WEBHOOK_SECRET_CURRENT: undefined })),
    ).toContain("stripe_webhook_secret_missing");
  });

  it("blocks a mode that is not explicitly test or live", () => {
    expect(findingIds(productionEnvironment({ STRIPE_MODE: undefined }))).toContain(
      "stripe_mode_missing",
    );
    expect(findingIds(productionEnvironment({ STRIPE_MODE: "sandbox" }))).toContain(
      "stripe_mode_missing",
    );
  });

  it("blocks test mode reaching production traffic", () => {
    const ids = findingIds(
      productionEnvironment({
        STRIPE_MODE: "test",
        STRIPE_SECRET_KEY: "sk_test_9fJ2kQx7ZmR4bTvN6yWc3HsD",
      }),
    );
    expect(ids).toContain("stripe_test_mode_in_production");
  });

  it("blocks a live mode holding a test key and the reverse", () => {
    expect(
      findingIds(
        productionEnvironment({
          STRIPE_MODE: "live",
          STRIPE_SECRET_KEY: "sk_test_9fJ2kQx7ZmR4bTvN6yWc3HsD",
        }),
      ),
    ).toContain("stripe_live_mode_test_key");
    expect(
      findingIds(
        productionEnvironment({
          STRIPE_MODE: "test",
          STRIPE_SECRET_KEY: "sk_live_9fJ2kQx7ZmR4bTvN6yWc3HsD",
        }),
      ),
    ).toContain("stripe_test_mode_live_key");
  });

  it("blocks a webhook secret rotation window that never closes", () => {
    expect(
      findingIds(
        productionEnvironment({
          STRIPE_WEBHOOK_SECRET_PREVIOUS: "whsec_Rj4mWq8ZtY2nKx6VbL9sHcD3gFa7ZeXp",
        }),
      ),
    ).toContain("stripe_rotation_window_open");
    expect(
      findingIds(
        productionEnvironment({
          STRIPE_WEBHOOK_SECRET_PREVIOUS: "whsec_Kp7wQz2NxV9bLmR4tYs6HjF8gDc3ZaXe",
          STRIPE_WEBHOOK_SECRET_PREVIOUS_EXPIRES_AT: "2026-07-26T00:00:00Z",
        }),
      ),
    ).toContain("stripe_rotation_duplicate");
  });

  it("blocks missing refund or dispute webhook coverage", () => {
    // Payment events only: refunds and disputes would go unheard.
    const ids = findingIds(
      productionEnvironment({
        STRIPE_WEBHOOK_EVENTS: "payment_intent.succeeded,payment_intent.payment_failed",
      }),
    );
    expect(ids).toContain("webhook_coverage_incomplete");
    expect(findingIds(productionEnvironment({ STRIPE_WEBHOOK_EVENTS: undefined }))).toContain(
      "webhook_coverage_incomplete",
    );
  });
});

describe("Resend production gates", () => {
  it("blocks the development adapter and an unnamed external adapter", () => {
    expect(findingIds(productionEnvironment({ NOTIFICATION_PROVIDER: "LOCAL_FILE" }))).toContain(
      "notification_provider_local",
    );
    expect(findingIds(productionEnvironment({ NOTIFICATION_PROVIDER: "EXTERNAL" }))).toContain(
      "notification_provider_gate",
    );
  });

  it("blocks a missing key, sender identity, or mode", () => {
    expect(findingIds(productionEnvironment({ RESEND_API_KEY: undefined }))).toContain(
      "resend_key_missing",
    );
    expect(findingIds(productionEnvironment({ RESEND_API_KEY: "sk_live_wrong" }))).toContain(
      "resend_key_unrecognized",
    );
    expect(findingIds(productionEnvironment({ RESEND_FROM_ADDRESS: undefined }))).toContain(
      "resend_sender_missing",
    );
    expect(findingIds(productionEnvironment({ RESEND_MODE: undefined }))).toContain(
      "resend_mode_missing",
    );
  });

  it("blocks test mode reaching production traffic", () => {
    expect(findingIds(productionEnvironment({ RESEND_MODE: "test" }))).toContain(
      "resend_test_mode_in_production",
    );
  });
});

describe("financial deployment gates", () => {
  it("blocks a deployment on top of an unreconciled refund backlog", () => {
    expect(
      findingIds(productionEnvironment(), { refundReconciliationBacklog: 3 }),
    ).toContain("refund_backlog_gate");
    expect(
      findingIds(productionEnvironment({ DEPLOY_MAX_REFUND_BACKLOG: "5" }), {
        refundReconciliationBacklog: 3,
      }),
    ).not.toContain("refund_backlog_gate");
  });

  it("blocks a deployment with unresolved chargebacks", () => {
    expect(findingIds(productionEnvironment(), { unresolvedChargebacks: 1 })).toContain(
      "chargeback_gate",
    );
  });

  it("blocks any ledger divergence outright", () => {
    // Divergence is never auto-corrected: the ledger is append-only, so the
    // only safe response is to stop and investigate.
    expect(findingIds(productionEnvironment(), { financialDivergences: 1 })).toContain(
      "financial_divergence_gate",
    );
    expect(findingIds(productionEnvironment(), { financialDivergences: 0 })).not.toContain(
      "financial_divergence_gate",
    );
  });

  it("blocks refunded bookings that still hold valid admission", () => {
    expect(findingIds(productionEnvironment(), { ticketRevocationBacklog: 2 })).toContain(
      "ticket_revocation_gate",
    );
  });

  it("blocks when a financial probe could not be evaluated", () => {
    // The failure mode this guards against: a probe throws, its value is
    // undefined, every gate silently passes, and the one time the check could
    // not see the books is the one time it waves the deployment through.
    const ids = findingIds(productionEnvironment(), {
      probeFailures: ["refund_backlog", "financial_divergence"],
    });
    expect(ids).toContain("financial_probe_unavailable");
  });

  it("does not block when every probe evaluated cleanly", () => {
    const ids = findingIds(productionEnvironment(), {
      probeFailures: [],
      refundReconciliationBacklog: 0,
      unresolvedChargebacks: 0,
      financialDivergences: 0,
      ticketRevocationBacklog: 0,
    });
    expect(ids).not.toContain("financial_probe_unavailable");
    expect(summarizeFindings(validateProductionConfiguration({
      env: productionEnvironment(),
      probes: {
        probeFailures: [],
        refundReconciliationBacklog: 0,
        unresolvedChargebacks: 0,
        financialDivergences: 0,
        ticketRevocationBacklog: 0,
      },
    })).passed).toBe(true);
  });

  it("names the failed probes without leaking a driver message", () => {
    const findings = validateProductionConfiguration({
      env: productionEnvironment(),
      probes: { probeFailures: ["ticket_revocation_backlog"] },
    });
    const finding = findings.find((entry) => entry.id === "financial_probe_unavailable");
    expect(finding?.message).toContain("ticket_revocation_backlog");
    // A probe name is safe to print; a connection string or driver error is not.
    expect(finding?.message).not.toMatch(/postgres|password|ECONNREFUSED|at .*\.ts:/i);
  });

  it("never quotes a secret value in any finding", () => {
    const secrets = [
      "sk_live_9fJ2kQx7ZmR4bTvN6yWc3HsD",
      "whsec_Kp7wQz2NxV9bLmR4tYs6HjF8gDc3ZaXe",
      "re_9fJ2kQx7ZmR4bTvN6yWc3HsD",
      "Kp7wQz2NxV9bLmR4tYs6HjF8gDc3ZaXe",
      "postgresql://seatflow:secret@db.internal:5432/seatflow",
    ];
    // Deliberately broken in several ways at once so many findings are produced.
    const findings = validateProductionConfiguration({
      env: productionEnvironment({
        STRIPE_MODE: "test",
        RESEND_MODE: "test",
        STRIPE_WEBHOOK_EVENTS: "",
      }),
      probes: { refundReconciliationBacklog: 9, unresolvedChargebacks: 4 },
    });
    expect(findings.length).toBeGreaterThan(3);
    const serialized = JSON.stringify(findings);
    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
    }
  });
});
