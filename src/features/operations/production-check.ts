/**
 * Production configuration validation.
 *
 * Pure and side-effect free: it reads a supplied environment map plus optional
 * probe results and returns findings. It never opens a connection, never writes
 * anything, and never returns a secret value — only the name of the variable at
 * fault and why.
 *
 * This is the gate that stops a deployment configured for local development
 * from reaching production traffic.
 */

export type FindingSeverity = "error" | "warning";

export interface ProductionCheckFinding {
  id: string;
  severity: FindingSeverity;
  /** Safe message. Must name the variable, never quote its value. */
  message: string;
}

export interface ProductionCheckProbes {
  /** Null when the probe was not run. */
  redisAvailable?: boolean | null;
  migrationsBehind?: boolean | null;
  outboxDeadLetters?: number | null;
  notificationDeadLetters?: number | null;
  paidUnfulfilled?: number | null;
  /** Phase 5C2A financial gates. */
  refundReconciliationBacklog?: number | null;
  unresolvedChargebacks?: number | null;
  financialDivergences?: number | null;
  ticketRevocationBacklog?: number | null;
  /**
   * Names of probes that could not be evaluated. A probe that fails must never
   * be read as "no backlog": an unevaluated financial gate is treated as a
   * blocking unknown, not as a pass.
   */
  probeFailures?: readonly string[] | null;
}

/**
 * Provider webhook event types that must be subscribed before production
 * traffic. Missing refund or dispute coverage means money could move at the
 * provider with the platform never hearing about it.
 */
export const REQUIRED_WEBHOOK_EVENT_COVERAGE = [
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "refund.updated",
  "charge.dispute.created",
  "charge.dispute.closed",
] as const;

export type EnvironmentSource = Record<string, string | undefined>;

/** Worker processes that must be declared before production traffic is enabled. */
export const REQUIRED_WORKER_DECLARATIONS = [
  "INVENTORY_OUTBOX_DISPATCHER",
  "HOLD_EXPIRY_WORKER",
  "REALTIME_GATEWAY",
  "TICKET_ISSUANCE_DISPATCHER",
  "NOTIFICATION_DISPATCHER",
  "PAYMENT_RECONCILIATION",
] as const;

const PLACEHOLDER_FRAGMENTS = [
  "changeme",
  "change-me",
  "placeholder",
  "example",
  "insecure",
  "development",
  "localtest",
  "test-secret",
  "secret-value",
  "your-secret",
  "replace",
];

/**
 * Reject a secret that is short, low-entropy, or an obvious placeholder. The
 * value itself is never returned or logged — only the verdict.
 */
export function isWeakSecret(value: string | undefined, minimumLength = 32) {
  if (!value || value.length < minimumLength) return true;
  const lowered = value.toLowerCase();
  if (PLACEHOLDER_FRAGMENTS.some((fragment) => lowered.includes(fragment))) return true;
  // A value built from very few distinct characters carries little entropy
  // regardless of length, e.g. "aaaa...".
  return new Set(value).size < 12;
}

function isHttpsUrl(value: string | undefined) {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isLoopbackUrl(value: string | undefined) {
  if (!value) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
  } catch {
    return false;
  }
}

function isValidPostgresUrl(value: string | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "postgresql:" || url.protocol === "postgres:";
  } catch {
    return false;
  }
}

type ErrorReporter = (id: string, message: string) => void;

/**
 * Stripe production gates.
 *
 * Two failure modes matter most and both are checked without ever reading a
 * secret's value beyond its prefix: running live traffic against a test key,
 * and running test mode in production at all. A webhook secret rotation window
 * that never closes is also refused.
 */
function validateStripeConfiguration(env: EnvironmentSource, error: ErrorReporter) {
  if (!env.STRIPE_SECRET_KEY) {
    error("stripe_secret_missing", "STRIPE_SECRET_KEY is required when PAYMENT_PROVIDER=STRIPE.");
  }
  if (!env.STRIPE_WEBHOOK_SECRET_CURRENT) {
    error(
      "stripe_webhook_secret_missing",
      "STRIPE_WEBHOOK_SECRET_CURRENT is required; without it no refund or dispute event can be verified.",
    );
  }
  if (env.STRIPE_MODE !== "test" && env.STRIPE_MODE !== "live") {
    error("stripe_mode_missing", "STRIPE_MODE must be explicitly 'test' or 'live'.");
  }
  if (env.STRIPE_MODE === "test") {
    error(
      "stripe_test_mode_in_production",
      "STRIPE_MODE=test cannot serve production traffic; real customers would not be charged.",
    );
  }
  const key = env.STRIPE_SECRET_KEY ?? "";
  if (env.STRIPE_MODE === "live" && /^(sk|rk)_test_/.test(key)) {
    error(
      "stripe_live_mode_test_key",
      "STRIPE_MODE=live but STRIPE_SECRET_KEY is a test key.",
    );
  }
  if (env.STRIPE_MODE === "test" && /^(sk|rk)_live_/.test(key)) {
    error(
      "stripe_test_mode_live_key",
      "STRIPE_MODE=test but STRIPE_SECRET_KEY is a live key.",
    );
  }
  if (key && !/^(sk|rk)_(test|live)_/.test(key)) {
    error("stripe_key_unrecognized", "STRIPE_SECRET_KEY is not a recognized Stripe secret key.");
  }

  if (env.STRIPE_WEBHOOK_SECRET_PREVIOUS) {
    if (!env.STRIPE_WEBHOOK_SECRET_PREVIOUS_EXPIRES_AT) {
      error(
        "stripe_rotation_window_open",
        "STRIPE_WEBHOOK_SECRET_PREVIOUS is set without STRIPE_WEBHOOK_SECRET_PREVIOUS_EXPIRES_AT, so the old secret would verify forever.",
      );
    }
    if (env.STRIPE_WEBHOOK_SECRET_PREVIOUS === env.STRIPE_WEBHOOK_SECRET_CURRENT) {
      error(
        "stripe_rotation_duplicate",
        "STRIPE_WEBHOOK_SECRET_PREVIOUS must differ from STRIPE_WEBHOOK_SECRET_CURRENT.",
      );
    }
  }

  // Refund and dispute coverage must be declared, or money can move at the
  // provider without the platform ever hearing about it.
  const declared = (env.STRIPE_WEBHOOK_EVENTS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const missing = REQUIRED_WEBHOOK_EVENT_COVERAGE.filter((event) => !declared.includes(event));
  if (missing.length > 0) {
    error(
      "webhook_coverage_incomplete",
      `STRIPE_WEBHOOK_EVENTS is missing required event coverage: ${missing.join(", ")}.`,
    );
  }
}

/** Resend production gates, including the sender identity the domain requires. */
function validateResendConfiguration(env: EnvironmentSource, error: ErrorReporter) {
  if (!env.RESEND_API_KEY) {
    error("resend_key_missing", "RESEND_API_KEY is required when NOTIFICATION_PROVIDER=RESEND.");
  } else if (!env.RESEND_API_KEY.startsWith("re_")) {
    error("resend_key_unrecognized", "RESEND_API_KEY is not a recognized Resend API key.");
  }
  if (!env.RESEND_FROM_ADDRESS) {
    error(
      "resend_sender_missing",
      "RESEND_FROM_ADDRESS is required; a verified sender identity is mandatory for delivery.",
    );
  }
  if (env.RESEND_MODE !== "test" && env.RESEND_MODE !== "live") {
    error("resend_mode_missing", "RESEND_MODE must be explicitly 'test' or 'live'.");
  }
  if (env.RESEND_MODE === "test") {
    error(
      "resend_test_mode_in_production",
      "RESEND_MODE=test redirects all mail to a test recipient; real customers would receive nothing.",
    );
  }
}

export function validateProductionConfiguration(input: {
  env: EnvironmentSource;
  probes?: ProductionCheckProbes;
}): ProductionCheckFinding[] {
  const { env } = input;
  const probes = input.probes ?? {};
  const findings: ProductionCheckFinding[] = [];

  const error = (id: string, message: string) =>
    findings.push({ id, severity: "error", message });
  const warn = (id: string, message: string) =>
    findings.push({ id, severity: "warning", message });

  // ---- Runtime mode -------------------------------------------------------
  if (env.NODE_ENV !== "production") {
    error(
      "node_env",
      "NODE_ENV must be 'production' for a production deployment.",
    );
  }

  // The isolated-E2E override exists so browser verification can run against a
  // production build. It has no place in a deployment serving real traffic, so
  // its mere presence is a hard stop here regardless of whether the other
  // isolation conditions happen to hold.
  if (env.SEATFLOW_E2E_TEST_MODE) {
    error(
      "e2e_test_mode_enabled",
      "SEATFLOW_E2E_TEST_MODE is set. That flag exists only for the isolated browser-test harness and must never be present in a production deployment.",
    );
  }

  // ---- Payment provider ---------------------------------------------------
  if (env.PAYMENT_PROVIDER === "LOCAL_SIGNED") {
    error(
      "payment_provider_local",
      "PAYMENT_PROVIDER is the development-only LOCAL_SIGNED adapter, which is forbidden in production.",
    );
  } else if (env.PAYMENT_PROVIDER === "STRIPE") {
    validateStripeConfiguration(env, error);
  } else if (env.PAYMENT_PROVIDER !== "EXTERNAL") {
    error("payment_provider_missing", "PAYMENT_PROVIDER must be set to STRIPE.");
  } else {
    // EXTERNAL remains a hard stop: it names no reviewed adapter.
    error(
      "payment_provider_gate",
      "PAYMENT_PROVIDER=EXTERNAL names no reviewed adapter. Select STRIPE and supply its credentials, or checkout must stay disabled.",
    );
  }
  if (env.LOCAL_PAYMENT_WEBHOOK_SECRET) {
    error(
      "local_payment_secret_present",
      "LOCAL_PAYMENT_WEBHOOK_SECRET must not be set in production.",
    );
  }

  // ---- Notification provider ---------------------------------------------
  if (env.NOTIFICATION_PROVIDER === "LOCAL_FILE") {
    error(
      "notification_provider_local",
      "NOTIFICATION_PROVIDER is the development-only LOCAL_FILE adapter, which is forbidden in production.",
    );
  } else if (env.NOTIFICATION_PROVIDER === "RESEND") {
    validateResendConfiguration(env, error);
  } else if (env.NOTIFICATION_PROVIDER !== "EXTERNAL") {
    error("notification_provider_missing", "NOTIFICATION_PROVIDER must be set to RESEND.");
  } else {
    error(
      "notification_provider_gate",
      "NOTIFICATION_PROVIDER=EXTERNAL names no reviewed adapter. Select RESEND and supply its credentials.",
    );
  }
  if (env.LOCAL_EMAIL_CAPTURE_DIR) {
    error(
      "local_capture_enabled",
      "LOCAL_EMAIL_CAPTURE_DIR must not be set in production; captured email would write customer content to disk.",
    );
  }

  // ---- Secrets ------------------------------------------------------------
  if (isWeakSecret(env.TICKET_CREDENTIAL_SECRET)) {
    error(
      "ticket_secret_weak",
      "TICKET_CREDENTIAL_SECRET is missing, too short, low-entropy, or a placeholder.",
    );
  }
  if (isWeakSecret(env.BETTER_AUTH_SECRET)) {
    error(
      "auth_secret_weak",
      "BETTER_AUTH_SECRET is missing, too short, low-entropy, or a placeholder.",
    );
  }
  if (
    env.TICKET_CREDENTIAL_SECRET &&
    env.BETTER_AUTH_SECRET &&
    env.TICKET_CREDENTIAL_SECRET === env.BETTER_AUTH_SECRET
  ) {
    error(
      "secret_reuse",
      "TICKET_CREDENTIAL_SECRET must not equal BETTER_AUTH_SECRET; signing keys must be independently rotatable.",
    );
  }

  // ---- Database -----------------------------------------------------------
  if (!isValidPostgresUrl(env.DATABASE_URL)) {
    error("database_url_invalid", "DATABASE_URL is missing or not a postgresql:// URL.");
  }
  if (env.DIRECT_URL && !isValidPostgresUrl(env.DIRECT_URL)) {
    error("direct_url_invalid", "DIRECT_URL is set but is not a postgresql:// URL.");
  }
  if (env.TEST_DATABASE_URL && env.TEST_DATABASE_URL === env.DATABASE_URL) {
    error(
      "test_database_alias",
      "TEST_DATABASE_URL must never equal DATABASE_URL; the guarded test runner resets its target.",
    );
  }

  // ---- Origins ------------------------------------------------------------
  for (const name of ["BETTER_AUTH_URL", "NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_REALTIME_URL"]) {
    const value = env[name];
    if (!value) {
      if (name !== "NEXT_PUBLIC_REALTIME_URL") {
        error(`${name.toLowerCase()}_missing`, `${name} must be set.`);
      }
      continue;
    }
    if (!isHttpsUrl(value)) {
      error(`${name.toLowerCase()}_insecure`, `${name} must use https:// in production.`);
    }
    if (isLoopbackUrl(value)) {
      error(`${name.toLowerCase()}_loopback`, `${name} points at a loopback or .local host.`);
    }
  }

  // ---- Redis --------------------------------------------------------------
  if (!env.REDIS_URL) {
    error(
      "redis_missing",
      "REDIS_URL is required in production for realtime transport, scheduling, and distributed rate limiting.",
    );
  } else if (probes.redisAvailable === false) {
    error("redis_unavailable", "REDIS_URL is configured but the endpoint did not respond.");
  }
  const streamPrefix = env.REDIS_STREAM_PREFIX;
  if (!streamPrefix) {
    error("redis_prefix_missing", "REDIS_STREAM_PREFIX must be set to an environment-scoped namespace.");
  } else if (/test|development|dev|local/i.test(streamPrefix)) {
    error(
      "redis_prefix_unsafe",
      "REDIS_STREAM_PREFIX looks like a development or test namespace.",
    );
  }

  // ---- Trusted proxy ------------------------------------------------------
  const proxyMode = env.TRUSTED_PROXY_MODE ?? "none";
  if (!["none", "trusted-hop", "platform-header"].includes(proxyMode)) {
    error("trusted_proxy_mode_invalid", "TRUSTED_PROXY_MODE is not a recognized mode.");
  }
  if (proxyMode === "platform-header" && !env.TRUSTED_PROXY_HEADER) {
    error(
      "trusted_proxy_header_missing",
      "TRUSTED_PROXY_MODE=platform-header requires TRUSTED_PROXY_HEADER.",
    );
  }
  if (proxyMode !== "platform-header" && env.TRUSTED_PROXY_HEADER) {
    error(
      "trusted_proxy_ambiguous",
      "TRUSTED_PROXY_HEADER is set but TRUSTED_PROXY_MODE is not platform-header; the trust boundary is ambiguous.",
    );
  }
  if (proxyMode === "none") {
    warn(
      "trusted_proxy_none",
      "TRUSTED_PROXY_MODE=none ignores forwarding headers. Correct only if this process is reached directly; otherwise abuse controls will see the proxy rather than the client.",
    );
  }
  if (proxyMode === "trusted-hop") {
    const hops = Number(env.TRUSTED_PROXY_HOP_COUNT ?? "1");
    if (!Number.isInteger(hops) || hops < 1) {
      error(
        "trusted_proxy_hops_invalid",
        "TRUSTED_PROXY_HOP_COUNT must be a positive integer naming how many proxies append to X-Forwarded-For.",
      );
    }
  }

  // ---- Debug and abuse controls ------------------------------------------
  if (env.LOG_LEVEL === "debug") {
    error("debug_logging", "LOG_LEVEL=debug is not permitted in production.");
  }
  if (env.RATE_LIMIT_ENABLED === "false") {
    error("rate_limit_disabled", "RATE_LIMIT_ENABLED=false disables abuse controls.");
  }
  if (env.SECURITY_HEADERS_ENABLED === "false") {
    error("security_headers_disabled", "SECURITY_HEADERS_ENABLED=false disables the header policy.");
  }
  if (env.NEXT_PUBLIC_DEBUG === "true" || env.DEBUG) {
    error("debug_mode", "A debug flag (NEXT_PUBLIC_DEBUG or DEBUG) is enabled.");
  }

  // ---- Declared worker processes -----------------------------------------
  const declared = (env.SEATFLOW_DECLARED_WORKERS ?? "")
    .split(",")
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);
  const missingWorkers = REQUIRED_WORKER_DECLARATIONS.filter(
    (worker) => !declared.includes(worker),
  );
  if (missingWorkers.length > 0) {
    error(
      "workers_undeclared",
      `SEATFLOW_DECLARED_WORKERS is missing required worker processes: ${missingWorkers.join(", ")}.`,
    );
  }

  // ---- Deployment gates from live probes ---------------------------------
  if (probes.migrationsBehind === true) {
    error("migrations_behind", "The database is behind the migrations this build expects.");
  }
  const maxDeadLetters = Number(env.DEPLOY_MAX_DEAD_LETTERS ?? "0");
  const maxPaidUnfulfilled = Number(env.DEPLOY_MAX_PAID_UNFULFILLED ?? "0");

  if (
    typeof probes.outboxDeadLetters === "number" &&
    probes.outboxDeadLetters > maxDeadLetters
  ) {
    error(
      "outbox_dead_letters_gate",
      `Inventory outbox dead letters (${probes.outboxDeadLetters}) exceed DEPLOY_MAX_DEAD_LETTERS (${maxDeadLetters}).`,
    );
  }
  if (
    typeof probes.notificationDeadLetters === "number" &&
    probes.notificationDeadLetters > maxDeadLetters
  ) {
    error(
      "notification_dead_letters_gate",
      `Notification dead letters (${probes.notificationDeadLetters}) exceed DEPLOY_MAX_DEAD_LETTERS (${maxDeadLetters}).`,
    );
  }
  if (
    typeof probes.paidUnfulfilled === "number" &&
    probes.paidUnfulfilled > maxPaidUnfulfilled
  ) {
    error(
      "paid_unfulfilled_gate",
      `Paid-but-unfulfilled orders (${probes.paidUnfulfilled}) exceed DEPLOY_MAX_PAID_UNFULFILLED (${maxPaidUnfulfilled}).`,
    );
  }

  // ---- Phase 5C2A financial gates ----------------------------------------
  // Deploying on top of unreconciled money is how a small discrepancy becomes
  // an unauditable one, so these are errors rather than warnings.
  const maxRefundBacklog = Number(env.DEPLOY_MAX_REFUND_BACKLOG ?? "0");
  const maxChargebacks = Number(env.DEPLOY_MAX_UNRESOLVED_CHARGEBACKS ?? "0");

  // An unevaluated financial gate blocks. Treating a failed probe as a pass
  // would mean the one time the check could not see the books is the one time
  // it waves the deployment through.
  if (probes.probeFailures && probes.probeFailures.length > 0) {
    error(
      "financial_probe_unavailable",
      `Financial probes could not be evaluated (${probes.probeFailures.join(", ")}), so their gates cannot be trusted. Resolve the probe failure before deploying.`,
    );
  }

  if (
    typeof probes.refundReconciliationBacklog === "number" &&
    probes.refundReconciliationBacklog > maxRefundBacklog
  ) {
    error(
      "refund_backlog_gate",
      `Refund reconciliation backlog (${probes.refundReconciliationBacklog}) exceeds DEPLOY_MAX_REFUND_BACKLOG (${maxRefundBacklog}).`,
    );
  }
  if (
    typeof probes.unresolvedChargebacks === "number" &&
    probes.unresolvedChargebacks > maxChargebacks
  ) {
    error(
      "chargeback_gate",
      `Unresolved chargebacks and lost disputes (${probes.unresolvedChargebacks}) exceed DEPLOY_MAX_UNRESOLVED_CHARGEBACKS (${maxChargebacks}).`,
    );
  }
  if (typeof probes.financialDivergences === "number" && probes.financialDivergences > 0) {
    error(
      "financial_divergence_gate",
      `The append-only ledger disagrees with stored payment aggregates on ${probes.financialDivergences} payment(s). This must be investigated, never auto-corrected.`,
    );
  }
  if (typeof probes.ticketRevocationBacklog === "number" && probes.ticketRevocationBacklog > 0) {
    error(
      "ticket_revocation_gate",
      `${probes.ticketRevocationBacklog} refunded booking(s) still hold an active ticket, so refunded admission is still valid.`,
    );
  }

  return findings;
}

export function summarizeFindings(findings: readonly ProductionCheckFinding[]) {
  const errors = findings.filter((finding) => finding.severity === "error");
  const warnings = findings.filter((finding) => finding.severity === "warning");
  return { errorCount: errors.length, warningCount: warnings.length, passed: errors.length === 0 };
}
