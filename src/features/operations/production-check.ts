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
}

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

  // ---- Payment provider ---------------------------------------------------
  if (env.PAYMENT_PROVIDER === "LOCAL_SIGNED") {
    error(
      "payment_provider_local",
      "PAYMENT_PROVIDER is the development-only LOCAL_SIGNED adapter, which is forbidden in production.",
    );
  } else if (env.PAYMENT_PROVIDER !== "EXTERNAL") {
    error("payment_provider_missing", "PAYMENT_PROVIDER must be set to EXTERNAL.");
  } else {
    // EXTERNAL is a deliberate deployment gate: Phase 5C1 ships no reviewed
    // external adapter, so this must remain a hard stop.
    error(
      "payment_provider_gate",
      "PAYMENT_PROVIDER=EXTERNAL requires a reviewed external adapter and its credentials, which this build does not contain. Checkout must stay disabled.",
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
  } else if (env.NOTIFICATION_PROVIDER !== "EXTERNAL") {
    error("notification_provider_missing", "NOTIFICATION_PROVIDER must be set to EXTERNAL.");
  } else {
    error(
      "notification_provider_gate",
      "NOTIFICATION_PROVIDER=EXTERNAL requires a reviewed external adapter and its credentials, which this build does not contain.",
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

  return findings;
}

export function summarizeFindings(findings: readonly ProductionCheckFinding[]) {
  const errors = findings.filter((finding) => finding.severity === "error");
  const warnings = findings.filter((finding) => finding.severity === "warning");
  return { errorCount: errors.length, warningCount: warnings.length, passed: errors.length === 0 };
}
