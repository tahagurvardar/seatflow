/**
 * Staging secret validation.
 *
 * Pure and side-effect free: it takes a parsed environment map and returns
 * findings. It never opens a connection, never writes anything, and — the rule
 * that matters most here — **never returns, quotes, or embeds a value**. Every
 * finding names a variable and states what is wrong with it. That property is
 * what makes it safe to print this report to a terminal, paste it into a chat,
 * or attach it to an issue.
 *
 * The checks below encode the specific ways a free-tier staging environment
 * gets misconfigured in practice: a placeholder left in place, Neon's pooled
 * and direct URLs swapped, a localhost URL copied from `.env`, or a live
 * payment credential pasted into an environment that must never hold one.
 */

import { isWeakSecret } from "./production-check";

export type EnvironmentSource = Record<string, string | undefined>;

export type StagingFindingSeverity = "error" | "warning";

export interface StagingSecretFinding {
  id: string;
  severity: StagingFindingSeverity;
  /** The variable at fault. Never accompanied by its value. */
  variable: string;
  /** Safe explanation. Must not quote the value. */
  message: string;
}

/**
 * Variables the staging deployment cannot start without.
 *
 * Kept in one list so the validator, the Vercel importer, and the documentation
 * cannot drift on what "complete" means.
 */
export const REQUIRED_STAGING_VARIABLES = [
  "DATABASE_URL",
  "DIRECT_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "NEXT_PUBLIC_APP_URL",
  "TICKET_CREDENTIAL_SECRET",
  "LOCAL_PAYMENT_WEBHOOK_SECRET",
  "PAYMENT_PROVIDER",
  "NOTIFICATION_PROVIDER",
  "RESEND_API_KEY",
  "RESEND_FROM_ADDRESS",
  "RESEND_MODE",
  "RESEND_TEST_RECIPIENT",
  "QSTASH_CURRENT_SIGNING_KEY",
  "QSTASH_NEXT_SIGNING_KEY",
  "SEATFLOW_DEPLOYMENT_PROFILE",
  "SEATFLOW_JOB_MODE",
  "REDIS_STREAM_PREFIX",
] as const;

/**
 * Optional but strongly recommended. Absent, the deployment still boots; the
 * report says what it loses.
 */
export const OPTIONAL_STAGING_VARIABLES = [
  "REDIS_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "QSTASH_TOKEN",
  "SEATFLOW_STAGING_ORIGIN",
  "SEATFLOW_INTERNAL_JOB_ORIGIN",
] as const;

/**
 * Variables that exist only for local development or the test harness. Sending
 * these to a hosted staging environment is always a mistake, sometimes a
 * dangerous one.
 */
export const LOCAL_ONLY_VARIABLES = [
  "TEST_DATABASE_URL",
  "SHADOW_DATABASE_URL",
  "LOCAL_EMAIL_CAPTURE_DIR",
  "SEATFLOW_E2E_TEST_MODE",
  "SEATFLOW_PROTECTED_DATABASE_URL",
  "LOAD_TEST_BASE_URL",
  "BACKUP_DIR",
  "BACKUP_VERIFY_DATABASE_URL",
  "PG_BIN_DIR",
] as const;

/**
 * Variables that legitimately live in `.env.staging.local` but must **never** be
 * pushed to the hosted environment.
 *
 * Unlike LOCAL_ONLY_VARIABLES, their presence in the file is not an error —
 * they are read by an explicit local CLI, not by the deployed application, so
 * importing them to Vercel would put an extra credential in the platform for no
 * reason. They are excluded from the import rather than from the file.
 *
 *  - the seed passwords are read by `npm run staging:seed`
 *  - `QSTASH_TOKEN` is the publishing token read by `npm run staging:schedule`
 *    to register cron schedules; a request path only ever needs the signing
 *    keys, never the token, so it stays out of the deployment (least privilege)
 */
export const LOCAL_TOOLING_VARIABLES = [
  "STAGING_SEED_ADMIN_PASSWORD",
  "STAGING_SEED_ORGANIZER_PASSWORD",
  "STAGING_SEED_OPERATOR_PASSWORD",
  "STAGING_SEED_CUSTOMER_PASSWORD",
  "QSTASH_TOKEN",
] as const;

/** Every variable name the Vercel import must skip, for any reason. */
export const NON_IMPORTABLE_VARIABLES = [
  ...LOCAL_ONLY_VARIABLES,
  ...LOCAL_TOOLING_VARIABLES,
] as const;

const PLACEHOLDER_FRAGMENTS = [
  "replace-with",
  "replace_with",
  "replace_with_your",
  "your-",
  "your_",
  "changeme",
  "change-me",
  "placeholder",
  "example.com",
  "xxx",
  "todo",
];

/**
 * Instructional prose left in angle brackets, e.g. `<the address on your
 * account>`.
 *
 * Angle brackets cannot be treated as a placeholder marker on their own:
 * `SeatFlow <onboarding@resend.dev>` is a perfectly valid RFC 5322 sender and
 * flagging it would reject a correct configuration. What distinguishes prose is
 * whitespace *inside* the brackets, which no address contains.
 */
const BRACKETED_PROSE = /<[^>]*\s[^>]*>/;

/** A value the operator clearly has not filled in yet. */
export function looksLikePlaceholder(value: string) {
  const lowered = value.toLowerCase();
  if (PLACEHOLDER_FRAGMENTS.some((fragment) => lowered.includes(fragment))) return true;
  return BRACKETED_PROSE.test(value);
}

function parseUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function isLoopbackHost(host: string) {
  const lowered = host.toLowerCase();
  return (
    lowered === "localhost" ||
    lowered === "127.0.0.1" ||
    lowered === "::1" ||
    lowered === "0.0.0.0" ||
    lowered.endsWith(".local") ||
    lowered.endsWith(".localhost")
  );
}

export type NeonConnectionKind = "pooled" | "direct" | "not-neon" | "invalid";

/**
 * Classify a PostgreSQL URL as Neon-pooled or Neon-direct.
 *
 * Neon distinguishes the two by hostname: the pooled endpoint carries a
 * `-pooler` suffix on its host label. This matters because Prisma migrations
 * must run against the direct endpoint — PgBouncer in transaction mode cannot
 * hold the advisory lock and session state a migration needs — while the
 * application runtime must use the pooled one or a serverless deployment will
 * exhaust Neon's connection limit.
 */
export function classifyNeonConnection(value: string | undefined): NeonConnectionKind {
  if (!value) return "invalid";
  const url = parseUrl(value);
  if (!url || (url.protocol !== "postgresql:" && url.protocol !== "postgres:")) {
    return "invalid";
  }
  const host = url.hostname.toLowerCase();
  if (!host.includes("neon.tech")) return "not-neon";
  // The pooler suffix sits on the first host label, e.g.
  // ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech
  return /-pooler(\.|$)/.test(host) ? "pooled" : "direct";
}

export interface StagingValidationOptions {
  /**
   * When true, real provider credentials are refused outright. The isolated
   * E2E harness must be unable to reach any external service.
   */
  isolatedE2E?: boolean;
  /** Treat a missing optional variable as an error rather than a warning. */
  requireOptional?: boolean;
}

export interface StagingValidationReport {
  findings: readonly StagingSecretFinding[];
  /** Names only — never values. Safe to print. */
  presentVariables: readonly string[];
  missingVariables: readonly string[];
  errorCount: number;
  warningCount: number;
  passed: boolean;
}

export function validateStagingSecrets(
  env: EnvironmentSource,
  options: StagingValidationOptions = {},
): StagingValidationReport {
  const findings: StagingSecretFinding[] = [];
  const error = (id: string, variable: string, message: string) =>
    findings.push({ id, severity: "error", variable, message });
  const warn = (id: string, variable: string, message: string) =>
    findings.push({ id, severity: "warning", variable, message });

  const has = (name: string) => {
    const value = env[name];
    return typeof value === "string" && value.trim().length > 0;
  };

  // ---- Presence ----------------------------------------------------------
  const missingVariables = REQUIRED_STAGING_VARIABLES.filter((name) => !has(name));
  for (const name of missingVariables) {
    error("missing_required", name, "is required for the staging deployment but is not set.");
  }
  for (const name of OPTIONAL_STAGING_VARIABLES) {
    if (has(name)) continue;
    const report = options.requireOptional ? error : warn;
    report("missing_optional", name, "is not set; the deployment will run without it.");
  }

  // ---- Placeholders ------------------------------------------------------
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (looksLikePlaceholder(value)) {
      error(
        "placeholder_value",
        name,
        "still holds a template placeholder rather than a real value.",
      );
    }
  }

  // ---- Local-only leakage ------------------------------------------------
  for (const name of LOCAL_ONLY_VARIABLES) {
    if (has(name)) {
      error(
        "local_only_variable",
        name,
        "exists only for local development or the test harness and must never be sent to a hosted environment.",
      );
    }
  }

  // ---- Database endpoints ------------------------------------------------
  const pooled = classifyNeonConnection(env.DATABASE_URL);
  const direct = classifyNeonConnection(env.DIRECT_URL);

  if (env.DATABASE_URL && pooled === "invalid") {
    error("database_url_invalid", "DATABASE_URL", "is not a valid postgresql:// URL.");
  }
  if (env.DIRECT_URL && direct === "invalid") {
    error("direct_url_invalid", "DIRECT_URL", "is not a valid postgresql:// URL.");
  }
  // The swap is the failure this check exists for: migrations against the
  // pooler fail confusingly, and a pooled-less runtime exhausts Neon's
  // connection limit under serverless fan-out.
  if (pooled === "direct") {
    error(
      "database_url_not_pooled",
      "DATABASE_URL",
      "points at the Neon direct endpoint. The application runtime must use the pooled endpoint or serverless functions will exhaust the connection limit.",
    );
  }
  if (direct === "pooled") {
    error(
      "direct_url_pooled",
      "DIRECT_URL",
      "points at the Neon pooled endpoint. Prisma migrations must use the direct endpoint.",
    );
  }
  if (env.DATABASE_URL && env.DIRECT_URL && env.DATABASE_URL === env.DIRECT_URL) {
    error(
      "database_urls_identical",
      "DIRECT_URL",
      "is identical to DATABASE_URL; the pooled and direct endpoints must differ on Neon.",
    );
  }

  for (const name of ["DATABASE_URL", "DIRECT_URL"] as const) {
    const value = env[name];
    if (!value) continue;
    const url = parseUrl(value);
    if (url && isLoopbackHost(url.hostname)) {
      error(
        "database_local",
        name,
        "points at a local development database, not the hosted staging database.",
      );
    }
  }

  // ---- Origins -----------------------------------------------------------
  for (const name of ["BETTER_AUTH_URL", "NEXT_PUBLIC_APP_URL", "SEATFLOW_STAGING_ORIGIN"] as const) {
    const value = env[name];
    if (!value) continue;
    const url = parseUrl(value);
    if (!url) {
      error("origin_invalid", name, "is not a valid absolute URL.");
      continue;
    }
    if (isLoopbackHost(url.hostname)) {
      error("origin_local", name, "points at a loopback host rather than the staging origin.");
    } else if (url.protocol !== "https:") {
      error("origin_insecure", name, "must use https:// for a hosted deployment.");
    }
  }

  // ---- Redis -------------------------------------------------------------
  const redisUrl = env.REDIS_URL;
  if (redisUrl) {
    const url = parseUrl(redisUrl);
    if (!url || (url.protocol !== "redis:" && url.protocol !== "rediss:")) {
      error("redis_url_invalid", "REDIS_URL", "is not a valid redis:// or rediss:// URL.");
    } else if (isLoopbackHost(url.hostname)) {
      error("redis_local", "REDIS_URL", "points at a local Redis rather than the hosted instance.");
    } else if (url.protocol !== "rediss:") {
      error(
        "redis_not_tls",
        "REDIS_URL",
        "must use rediss:// so credentials are not sent in clear text to a hosted provider.",
      );
    }
  }
  if (env.UPSTASH_REDIS_REST_URL) {
    const url = parseUrl(env.UPSTASH_REDIS_REST_URL);
    if (!url || url.protocol !== "https:") {
      error(
        "upstash_rest_invalid",
        "UPSTASH_REDIS_REST_URL",
        "must be an https:// REST endpoint.",
      );
    }
  }
  if (env.UPSTASH_REDIS_REST_URL && !env.UPSTASH_REDIS_REST_TOKEN) {
    error(
      "upstash_token_missing",
      "UPSTASH_REDIS_REST_TOKEN",
      "is required whenever UPSTASH_REDIS_REST_URL is set.",
    );
  }

  // ---- Payment provider --------------------------------------------------
  // A live payment credential in a staging environment is the single most
  // expensive mistake available here, so every marker of one is refused.
  for (const name of [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET_CURRENT",
    "STRIPE_WEBHOOK_SECRET_PREVIOUS",
  ] as const) {
    if (!has(name)) continue;
    error(
      "stripe_credentials_present",
      name,
      "must not be set: this staging environment has no Stripe account and must never reach a payment network.",
    );
  }
  if (env.STRIPE_MODE === "live") {
    error("stripe_live_mode", "STRIPE_MODE", "must never be 'live' in this environment.");
  }
  if (/^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY ?? "")) {
    error(
      "stripe_live_key",
      "STRIPE_SECRET_KEY",
      "carries a live-mode key prefix. Remove it immediately and rotate it at the provider.",
    );
  }
  if (has("PAYMENT_PROVIDER") && env.PAYMENT_PROVIDER !== "LOCAL_SIGNED") {
    error(
      "payment_provider_not_local",
      "PAYMENT_PROVIDER",
      "must be LOCAL_SIGNED; this environment demonstrates a simulated payment and cannot process a real one.",
    );
  }

  // ---- Notification provider ---------------------------------------------
  if (has("NOTIFICATION_PROVIDER") && env.NOTIFICATION_PROVIDER !== "RESEND") {
    warn(
      "notification_provider_unexpected",
      "NOTIFICATION_PROVIDER",
      "is not RESEND; staging email verification expects the Resend adapter in test mode.",
    );
  }
  if (env.RESEND_MODE === "live") {
    error(
      "resend_live_mode",
      "RESEND_MODE",
      "must be 'test' so every message is redirected to the approved test recipient.",
    );
  }
  if (env.RESEND_MODE === "test" && !has("RESEND_TEST_RECIPIENT")) {
    error(
      "resend_recipient_missing",
      "RESEND_TEST_RECIPIENT",
      "is required in test mode; without it a message could reach a real address.",
    );
  }
  if (has("RESEND_API_KEY") && !env.RESEND_API_KEY!.startsWith("re_")) {
    error("resend_key_unrecognized", "RESEND_API_KEY", "is not a recognized Resend API key.");
  }

  // ---- Isolated E2E refusal ----------------------------------------------
  // The harness must be sealed. Holding any real credential disqualifies it,
  // which is the same rule `evaluateIsolatedE2EMode` enforces at runtime.
  if (options.isolatedE2E) {
    for (const name of [
      "STRIPE_SECRET_KEY",
      "RESEND_API_KEY",
      "QSTASH_TOKEN",
      "QSTASH_CURRENT_SIGNING_KEY",
      "QSTASH_NEXT_SIGNING_KEY",
      "UPSTASH_REDIS_REST_TOKEN",
    ] as const) {
      if (has(name)) {
        error(
          "real_credential_in_e2e",
          name,
          "is a real provider credential and must not be present in isolated E2E mode.",
        );
      }
    }
  }

  // ---- Secret strength ---------------------------------------------------
  for (const name of [
    "BETTER_AUTH_SECRET",
    "TICKET_CREDENTIAL_SECRET",
    "LOCAL_PAYMENT_WEBHOOK_SECRET",
  ] as const) {
    if (!has(name)) continue;
    if (isWeakSecret(env[name])) {
      error(
        "secret_weak",
        name,
        "is too short, low-entropy, or a placeholder. Generate it with: openssl rand -base64 48",
      );
    }
  }
  if (
    has("BETTER_AUTH_SECRET") &&
    has("TICKET_CREDENTIAL_SECRET") &&
    env.BETTER_AUTH_SECRET === env.TICKET_CREDENTIAL_SECRET
  ) {
    error(
      "secret_reuse",
      "TICKET_CREDENTIAL_SECRET",
      "must not equal BETTER_AUTH_SECRET; signing keys must be independently rotatable.",
    );
  }
  if (
    has("QSTASH_CURRENT_SIGNING_KEY") &&
    has("QSTASH_NEXT_SIGNING_KEY") &&
    env.QSTASH_CURRENT_SIGNING_KEY === env.QSTASH_NEXT_SIGNING_KEY
  ) {
    error(
      "qstash_keys_identical",
      "QSTASH_NEXT_SIGNING_KEY",
      "must differ from QSTASH_CURRENT_SIGNING_KEY or key rotation cannot work.",
    );
  }

  // ---- Profile coherence -------------------------------------------------
  if (has("SEATFLOW_DEPLOYMENT_PROFILE") && env.SEATFLOW_DEPLOYMENT_PROFILE !== "staging-demo") {
    error(
      "profile_not_staging",
      "SEATFLOW_DEPLOYMENT_PROFILE",
      "must be 'staging-demo' for this environment; any other value forbids the simulated payment provider.",
    );
  }
  if (has("SEATFLOW_JOB_MODE") && env.SEATFLOW_JOB_MODE !== "serverless") {
    error(
      "job_mode_not_serverless",
      "SEATFLOW_JOB_MODE",
      "must be 'serverless'; Vercel Hobby cannot host a resident worker process.",
    );
  }
  if (env.SEATFLOW_PRODUCTION_LAUNCH === "true") {
    error(
      "production_launch_declared",
      "SEATFLOW_PRODUCTION_LAUNCH",
      "must not be set in a staging environment.",
    );
  }
  if (has("REDIS_STREAM_PREFIX") && !/staging/i.test(env.REDIS_STREAM_PREFIX!)) {
    warn(
      "redis_prefix_unscoped",
      "REDIS_STREAM_PREFIX",
      "does not name the staging environment; a shared namespace lets environments read each other's events.",
    );
  }

  const presentVariables = Object.keys(env)
    .filter((name) => has(name))
    .sort();
  const errorCount = findings.filter((finding) => finding.severity === "error").length;

  return {
    findings,
    presentVariables,
    missingVariables,
    errorCount,
    warningCount: findings.length - errorCount,
    passed: errorCount === 0,
  };
}
