import { z } from "zod";

// Relative on purpose. This module is loaded by `prisma.config.ts` through the
// Prisma CLI, which does not resolve the `@/` tsconfig alias, so an aliased
// import here breaks every Prisma command.
import { isIsolatedE2EMode } from "../features/operations/e2e-test-mode";
import { isStagingDemoMode } from "../features/operations/deployment-profile";
import { parseSenderAddress } from "../features/notifications/sender-address";

type EnvironmentSource = Record<string, string | undefined>;

const postgresUrlSchema = z
  .url("must be a valid URL")
  .refine(
    (value) => value.startsWith("postgresql://") || value.startsWith("postgres://"),
    "must use the postgresql:// or postgres:// protocol",
  );

const redisUrlSchema = z
  .url("must be a valid URL")
  .refine(
    (value) => value.startsWith("redis://") || value.startsWith("rediss://"),
    "must use the redis:// or rediss:// protocol",
  );

/**
 * Accepts a bare address or a display-name mailbox. Only senders may carry a
 * display name; recipient validation is unchanged and remains strict.
 */
const senderAddressSchema = z
  .string()
  .max(320)
  .refine(
    (value) => parseSenderAddress(value) !== null,
    "must be an email address, optionally as: Display Name <address@example.com>",
  );

const applicationEnvironmentSchema = z.object({
  DATABASE_URL: postgresUrlSchema,
  DIRECT_URL: postgresUrlSchema.optional(),
  BETTER_AUTH_SECRET: z.string().min(32, "must contain at least 32 characters"),
  BETTER_AUTH_URL: z.url("must be a valid absolute URL"),
  /**
   * Browser-visible origin. Optional so existing single-origin setups keep
   * working, but validated whenever it is present — an unparseable value here
   * would otherwise surface as a broken absolute URL in an email.
   */
  NEXT_PUBLIC_APP_URL: z.url("must be a valid absolute URL").optional(),
});

const testDatabaseEnvironmentSchema = z.object({
  TEST_DATABASE_URL: postgresUrlSchema,
  DATABASE_URL: postgresUrlSchema.optional(),
  DIRECT_URL: postgresUrlSchema.optional(),
});

const inventoryEventEnvironmentSchema = z.object({
  REDIS_URL: redisUrlSchema,
  REDIS_STREAM_PREFIX: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9:_-]+$/i, "contains unsupported characters")
    .default("seatflow:development"),
  REDIS_WORKER_ID: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9._:-]+$/i, "contains unsupported characters")
    .default("seatflow-worker"),
  OUTBOX_DISPATCH_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  OUTBOX_DISPATCH_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(25).default(8),
  OUTBOX_DISPATCH_BACKOFF_BASE_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(1_000),
  OUTBOX_DISPATCH_BACKOFF_MAX_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(300_000),
  REDIS_STREAM_MAX_LENGTH: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(1_000_000)
    .default(100_000),
  REDIS_EVENT_DEDUP_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(3_600)
    .max(2_592_000)
    .default(604_800),
  HOLD_EXPIRY_QUEUE_NAME: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9:_-]+$/i, "contains unsupported characters")
    .default("seatflow-hold-expiry"),
  HOLD_EXPIRY_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(3_600_000)
    .default(30_000),
  HOLD_EXPIRY_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  REALTIME_GATEWAY_PORT: z.coerce.number().int().min(1_024).max(65_535).default(3_001),
  REALTIME_MAX_CONNECTIONS_PER_IP: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10),

  // ---- Phase 5C2B: Upstash REST transport ---------------------------------
  // Optional companion to REDIS_URL. A serverless request path prefers REST
  // because it needs no socket lifecycle, while BullMQ and the realtime
  // gateway continue to require the TCP URL above.
  UPSTASH_REDIS_REST_URL: z
    .url("must be a valid URL")
    .refine((value) => value.startsWith("https://"), "must use https://")
    .optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(16).max(512).optional(),
});

/**
 * A Stripe key states its own mode in its prefix. Comparing that against the
 * declared mode is what stops a deployment from believing it is in test mode
 * while holding a live key, or the reverse. The value itself is never read
 * beyond its prefix and is never reported.
 */
function stripeKeyMode(value: string | undefined): "test" | "live" | "unknown" {
  if (!value) return "unknown";
  if (/^(sk|rk)_test_/.test(value)) return "test";
  if (/^(sk|rk)_live_/.test(value)) return "live";
  return "unknown";
}

/**
 * Built per call so the isolated-E2E decision can read the *whole* environment
 * (database URL, origins, provider credentials), not just the payment fields
 * this schema declares.
 */
const createPaymentEnvironmentSchema = (source: EnvironmentSource) => z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PAYMENT_PROVIDER: z.enum(["LOCAL_SIGNED", "EXTERNAL", "STRIPE"]),
    LOCAL_PAYMENT_WEBHOOK_SECRET: z.string().min(32).max(512).optional(),
    PAYMENT_WEBHOOK_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(1_048_576)
      .default(65_536),

    // ---- External Stripe adapter (disabled unless PAYMENT_PROVIDER=STRIPE) --
    STRIPE_SECRET_KEY: z.string().min(20).max(200).optional(),
    STRIPE_WEBHOOK_SECRET_CURRENT: z.string().min(32).max(512).optional(),
    STRIPE_WEBHOOK_SECRET_PREVIOUS: z.string().min(32).max(512).optional(),
    STRIPE_WEBHOOK_SECRET_PREVIOUS_EXPIRES_AT: z.iso.datetime({ offset: true }).optional(),
    /** Deliberately has no default: the mode must be stated, never inferred. */
    STRIPE_MODE: z.enum(["test", "live"]).optional(),
    STRIPE_ALLOWED_CURRENCIES: z
      .string()
      .max(200)
      .regex(/^[A-Z]{3}(,[A-Z]{3})*$/, "must be a comma-separated list of ISO currency codes")
      .optional(),
    STRIPE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  })
  .superRefine((environment, context) => {
    if (
      environment.PAYMENT_PROVIDER === "LOCAL_SIGNED" &&
      !environment.LOCAL_PAYMENT_WEBHOOK_SECRET
    ) {
      context.addIssue({
        code: "custom",
        path: ["LOCAL_PAYMENT_WEBHOOK_SECRET"],
        message: "is required for the local signed provider",
      });
    }
    if (
      environment.NODE_ENV === "production" &&
      environment.PAYMENT_PROVIDER === "LOCAL_SIGNED" &&
      // Two audited exceptions, both of which require *every* condition in
      // their evaluator to hold — a flag alone grants neither.
      //
      //  1. A demonstrably isolated E2E harness. Browser verification must run
      //     against a production build, which sets NODE_ENV=production.
      //  2. A demonstrably isolated staging demo: a vercel.app (or declared
      //     staging) origin, no Stripe credentials, no live provider mode, and
      //     no production-launch marker.
      //
      // A real production deployment fails both sets of conditions, so this
      // rule still forbids LOCAL_SIGNED for it.
      !isIsolatedE2EMode(source) &&
      !isStagingDemoMode(source)
    ) {
      context.addIssue({
        code: "custom",
        path: ["PAYMENT_PROVIDER"],
        message: "LOCAL_SIGNED is forbidden in production",
      });
    }

    if (environment.PAYMENT_PROVIDER !== "STRIPE") {
      // The external adapter stays off unless it is explicitly selected, so a
      // stray credential in the environment cannot quietly enable it.
      return;
    }

    for (const name of [
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET_CURRENT",
      "STRIPE_MODE",
    ] as const) {
      if (!environment[name]) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: "is required when PAYMENT_PROVIDER is STRIPE",
        });
      }
    }

    const keyMode = stripeKeyMode(environment.STRIPE_SECRET_KEY);
    if (environment.STRIPE_SECRET_KEY && keyMode === "unknown") {
      context.addIssue({
        code: "custom",
        path: ["STRIPE_SECRET_KEY"],
        message: "is not a recognized Stripe secret key",
      });
    }
    if (environment.STRIPE_MODE && keyMode !== "unknown" && keyMode !== environment.STRIPE_MODE) {
      context.addIssue({
        code: "custom",
        path: ["STRIPE_SECRET_KEY"],
        message: `does not match STRIPE_MODE=${environment.STRIPE_MODE}`,
      });
    }

    if (
      environment.STRIPE_WEBHOOK_SECRET_PREVIOUS &&
      !environment.STRIPE_WEBHOOK_SECRET_PREVIOUS_EXPIRES_AT
    ) {
      context.addIssue({
        code: "custom",
        path: ["STRIPE_WEBHOOK_SECRET_PREVIOUS_EXPIRES_AT"],
        message:
          "is required whenever a previous webhook secret is set, so the rotation window closes",
      });
    }
    if (
      environment.STRIPE_WEBHOOK_SECRET_PREVIOUS &&
      environment.STRIPE_WEBHOOK_SECRET_PREVIOUS === environment.STRIPE_WEBHOOK_SECRET_CURRENT
    ) {
      context.addIssue({
        code: "custom",
        path: ["STRIPE_WEBHOOK_SECRET_PREVIOUS"],
        message: "must differ from STRIPE_WEBHOOK_SECRET_CURRENT",
      });
    }
  });

const ticketEnvironmentSchema = z.object({
  TICKET_CREDENTIAL_SECRET: z.string().min(32).max(512),
  TICKET_ENTRY_EARLY_MINUTES: z.coerce.number().int().min(0).max(1_440).default(120),
  TICKET_ENTRY_LATE_MINUTES: z.coerce.number().int().min(0).max(1_440).default(240),
  TICKET_DOWNLOAD_GRANT_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  TICKET_SCAN_MAX_BYTES: z.coerce.number().int().min(256).max(8_192).default(2_048),
  TICKET_SCAN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(300).default(120),
  TICKET_ISSUANCE_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  TICKET_ISSUANCE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(25).default(8),
  TICKET_ISSUANCE_BACKOFF_BASE_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  TICKET_ISSUANCE_BACKOFF_MAX_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(300_000),
});

const notificationEnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    NOTIFICATION_PROVIDER: z.enum(["LOCAL_FILE", "EXTERNAL", "RESEND"]),

    // ---- External Resend adapter (disabled unless NOTIFICATION_PROVIDER=RESEND)
    RESEND_API_KEY: z.string().min(20).max(200).optional(),
    /**
     * A sender is an RFC 5322 mailbox, so both `addr@example.com` and
     * `SeatFlow <addr@example.com>` are accepted. Recipients stay strictly
     * bare — see `assertSafeEmailAddress`.
     */
    RESEND_FROM_ADDRESS: senderAddressSchema.optional(),
    RESEND_REPLY_TO_ADDRESS: senderAddressSchema.optional(),
    /** Deliberately has no default: the mode must be stated, never inferred. */
    RESEND_MODE: z.enum(["test", "live"]).optional(),
    /**
     * In test mode every message is redirected here instead of the customer, so
     * a misconfigured non-production deployment cannot email a real customer.
     */
    RESEND_TEST_RECIPIENT: z.email().max(254).optional(),
    RESEND_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
    LOCAL_EMAIL_CAPTURE_DIR: z
      .string()
      .min(1)
      .max(260)
      .regex(/^[A-Za-z0-9._/-]+$/, "contains unsupported path characters")
      .refine((value) => !value.split(/[\\/]/).includes(".."), "must not traverse parent directories")
      .optional(),
    NOTIFICATION_DISPATCH_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
    NOTIFICATION_DISPATCH_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(25).default(8),
    NOTIFICATION_DISPATCH_BACKOFF_BASE_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
    NOTIFICATION_DISPATCH_BACKOFF_MAX_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(300_000),
  })
  .superRefine((environment, context) => {
    if (environment.NOTIFICATION_PROVIDER === "LOCAL_FILE" && !environment.LOCAL_EMAIL_CAPTURE_DIR) {
      context.addIssue({
        code: "custom",
        path: ["LOCAL_EMAIL_CAPTURE_DIR"],
        message: "is required for the local file notification provider",
      });
    }
    if (environment.NODE_ENV === "production" && environment.NOTIFICATION_PROVIDER === "LOCAL_FILE") {
      context.addIssue({
        code: "custom",
        path: ["NOTIFICATION_PROVIDER"],
        message: "LOCAL_FILE is forbidden in production",
      });
    }

    if (environment.NOTIFICATION_PROVIDER !== "RESEND") return;

    for (const name of ["RESEND_API_KEY", "RESEND_FROM_ADDRESS", "RESEND_MODE"] as const) {
      if (!environment[name]) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: "is required when NOTIFICATION_PROVIDER is RESEND",
        });
      }
    }
    if (environment.RESEND_API_KEY && !environment.RESEND_API_KEY.startsWith("re_")) {
      context.addIssue({
        code: "custom",
        path: ["RESEND_API_KEY"],
        message: "is not a recognized Resend API key",
      });
    }
    // Test mode without a redirect address would send to real recipients.
    if (environment.RESEND_MODE === "test" && !environment.RESEND_TEST_RECIPIENT) {
      context.addIssue({
        code: "custom",
        path: ["RESEND_TEST_RECIPIENT"],
        message: "is required in test mode so no message can reach a real customer",
      });
    }
  });

/**
 * Phase 5C2B serverless job delivery.
 *
 * `worker` is the default and preserves every Phase 4B/5B/5C process exactly as
 * it was: resident BullMQ workers, a realtime gateway, and cron-driven CLI
 * dispatchers. `serverless` is the deliberate opt-in for a platform that cannot
 * host a resident process, where the same bounded operations are triggered by
 * signed QStash deliveries instead.
 *
 * The signing keys are required in serverless mode because an unsigned internal
 * job endpoint is an unauthenticated remote trigger for inventory and financial
 * work. There is no "unsigned but enabled" configuration.
 */
const serverlessJobEnvironmentSchema = z
  .object({
    SEATFLOW_JOB_MODE: z.enum(["worker", "serverless"]).default("worker"),

    QSTASH_CURRENT_SIGNING_KEY: z.string().min(20).max(512).optional(),
    QSTASH_NEXT_SIGNING_KEY: z.string().min(20).max(512).optional(),
    /** Publishing token. Only the scheduling CLI needs it, never a request path. */
    QSTASH_TOKEN: z.string().min(20).max(512).optional(),

    /**
     * Absolute origin QStash delivers to. Defaults to the application origin;
     * set it only when the job endpoints are reachable on a different host.
     */
    SEATFLOW_INTERNAL_JOB_ORIGIN: z.url("must be a valid absolute URL").optional(),

    /** A job body names an operation and a batch size. It is never large. */
    JOB_REQUEST_MAX_BYTES: z.coerce.number().int().min(256).max(65_536).default(8_192),
    /**
     * Bounds the handler well inside the platform's function limit, so a batch
     * is cut short by this budget rather than killed mid-transaction by the
     * runtime. Vercel Hobby allows 60s; the default leaves headroom.
     */
    JOB_MAX_DURATION_SECONDS: z.coerce.number().int().min(5).max(300).default(45),
    /** Tolerance for clock skew when verifying a signature's validity window. */
    JOB_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().min(0).max(300).default(15),
    /** Deliveries older than this are refused outright as replays. */
    JOB_REPLAY_WINDOW_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3_600),
  })
  .superRefine((environment, context) => {
    if (environment.SEATFLOW_JOB_MODE !== "serverless") return;
    for (const name of ["QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY"] as const) {
      if (!environment[name]) {
        context.addIssue({
          code: "custom",
          path: [name],
          message:
            "is required when SEATFLOW_JOB_MODE is serverless; an unsigned job endpoint is an unauthenticated remote trigger",
        });
      }
    }
    if (
      environment.QSTASH_CURRENT_SIGNING_KEY &&
      environment.QSTASH_CURRENT_SIGNING_KEY === environment.QSTASH_NEXT_SIGNING_KEY
    ) {
      context.addIssue({
        code: "custom",
        path: ["QSTASH_NEXT_SIGNING_KEY"],
        message: "must differ from QSTASH_CURRENT_SIGNING_KEY or rotation cannot work",
      });
    }
  });

export type ServerlessJobEnvironment = z.infer<typeof serverlessJobEnvironmentSchema>;

export function readServerlessJobEnvironment(
  source: EnvironmentSource = process.env,
): ServerlessJobEnvironment {
  const result = serverlessJobEnvironmentSchema.safeParse(source);
  if (!result.success) {
    throw formatEnvironmentError("SeatFlow serverless jobs", result.error);
  }
  return result.data;
}

/**
 * `z.coerce.boolean` treats the string "false" as true, which is exactly the
 * wrong default for a safety flag, so environment booleans are explicit.
 */
const booleanFlagSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const operationsEnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    // ---- Phase 5C2B: which deployment this is -----------------------------
    // Unset means production for a production build. Forgetting to declare a
    // profile therefore fails closed into the strictest world, not the most
    // permissive one. `profileCapabilities` decides what each may relax.
    SEATFLOW_DEPLOYMENT_PROFILE: z
      .enum(["local", "isolated-e2e", "staging-demo", "production"])
      .optional(),
    /** A non-vercel.app host the staging demo is additionally allowed to serve. */
    SEATFLOW_STAGING_ORIGIN: z.url("must be a valid absolute URL").optional(),
    /** Explicit marker for a deployment intending to serve real customers. */
    SEATFLOW_PRODUCTION_LAUNCH: booleanFlagSchema.optional(),

    // Observability
    SEATFLOW_SERVICE_NAME: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/, "must be lowercase alphanumeric with dashes")
      .default("seatflow-web"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

    // Trusted proxy. `none` is the safe default: forwarding headers are ignored
    // entirely unless the deployment declares who is allowed to set them.
    TRUSTED_PROXY_MODE: z
      .enum(["none", "trusted-hop", "platform-header"])
      .default("none"),
    TRUSTED_PROXY_HOP_COUNT: z.coerce.number().int().min(1).max(10).default(1),
    TRUSTED_PROXY_HEADER: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/, "must be a lowercase header name")
      .optional(),

    // Abuse controls
    RATE_LIMIT_ENABLED: booleanFlagSchema.default(true),

    // Worker health
    WORKER_HEARTBEAT_STALE_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .max(3_600)
      .default(180),

    // Readiness and deployment gates
    READINESS_MAX_OUTBOX_BACKLOG: z.coerce.number().int().min(0).max(1_000_000).default(500),
    READINESS_MAX_OUTBOX_AGE_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
    DEPLOY_MAX_DEAD_LETTERS: z.coerce.number().int().min(0).max(1_000_000).default(0),
    DEPLOY_MAX_PAID_UNFULFILLED: z.coerce.number().int().min(0).max(1_000_000).default(0),

    // Phase 5C2A financial gates. A refund still moving normally is not
    // backlog; one unsettled past this window is.
    DEPLOY_MAX_REFUND_BACKLOG: z.coerce.number().int().min(0).max(1_000_000).default(0),
    DEPLOY_MAX_UNRESOLVED_CHARGEBACKS: z.coerce.number().int().min(0).max(1_000_000).default(0),
    REFUND_BACKLOG_STALE_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
    /** Caps the divergence scan so a preflight cannot itself become an outage. */
    FINANCIAL_DIVERGENCE_SCAN_LIMIT: z.coerce.number().int().min(50).max(10_000).default(500),

    // Security headers
    SECURITY_HEADERS_ENABLED: booleanFlagSchema.default(true),
    SECURITY_HSTS_MAX_AGE_SECONDS: z.coerce
      .number()
      .int()
      .min(0)
      .max(63_072_000)
      .default(31_536_000),
  })
  .superRefine((environment, context) => {
    if (
      environment.TRUSTED_PROXY_MODE === "platform-header" &&
      !environment.TRUSTED_PROXY_HEADER
    ) {
      context.addIssue({
        code: "custom",
        path: ["TRUSTED_PROXY_HEADER"],
        message: "is required when TRUSTED_PROXY_MODE is platform-header",
      });
    }
    if (
      environment.TRUSTED_PROXY_MODE !== "platform-header" &&
      environment.TRUSTED_PROXY_HEADER
    ) {
      context.addIssue({
        code: "custom",
        path: ["TRUSTED_PROXY_HEADER"],
        message: "must not be set unless TRUSTED_PROXY_MODE is platform-header",
      });
    }
  });

export type OperationsEnvironment = z.infer<typeof operationsEnvironmentSchema>;

export function readOperationsEnvironment(
  source: EnvironmentSource = process.env,
): OperationsEnvironment {
  const result = operationsEnvironmentSchema.safeParse(source);
  if (!result.success) {
    throw formatEnvironmentError("SeatFlow operations", result.error);
  }
  return result.data;
}

export type ApplicationEnvironment = z.infer<
  typeof applicationEnvironmentSchema
>;
export type InventoryEventEnvironment = z.infer<
  typeof inventoryEventEnvironmentSchema
>;
export type PaymentEnvironment = z.infer<ReturnType<typeof createPaymentEnvironmentSchema>>;
export type TicketEnvironment = z.infer<typeof ticketEnvironmentSchema>;
export type NotificationEnvironment = z.infer<typeof notificationEnvironmentSchema>;

function formatEnvironmentError(scope: string, error: z.ZodError) {
  const details = error.issues
    .map((issue) => `${issue.path.join(".") || "environment"} ${issue.message}`)
    .join("; ");

  return new Error(`Invalid ${scope} environment: ${details}. See .env.example.`);
}

export function readApplicationEnvironment(
  source: EnvironmentSource = process.env,
): ApplicationEnvironment {
  const result = applicationEnvironmentSchema.safeParse(source);

  if (!result.success) {
    throw formatEnvironmentError("SeatFlow application", result.error);
  }

  return result.data;
}

export function readMigrationDatabaseUrl(
  source: EnvironmentSource = process.env,
) {
  const result = z
    .object({
      DATABASE_URL: postgresUrlSchema,
      DIRECT_URL: postgresUrlSchema.optional(),
    })
    .safeParse(source);

  if (!result.success) {
    throw formatEnvironmentError("SeatFlow database", result.error);
  }

  return result.data.DIRECT_URL ?? result.data.DATABASE_URL;
}

export function readRuntimeDatabaseUrl(
  source: EnvironmentSource = process.env,
) {
  const result = z.object({ DATABASE_URL: postgresUrlSchema }).safeParse(source);

  if (!result.success) {
    throw formatEnvironmentError("SeatFlow runtime database", result.error);
  }

  return result.data.DATABASE_URL;
}

export function readSafeTestDatabaseUrl(
  source: EnvironmentSource = process.env,
  options: { allowRuntimeAlias?: boolean } = {},
) {
  const result = testDatabaseEnvironmentSchema.safeParse(source);

  if (!result.success) {
    throw formatEnvironmentError("SeatFlow test database", result.error);
  }

  const testUrl = new URL(result.data.TEST_DATABASE_URL);
  const databaseName = decodeURIComponent(testUrl.pathname.replace(/^\//, ""));
  const protectedUrls = [result.data.DATABASE_URL, result.data.DIRECT_URL].filter(
    (value): value is string => Boolean(value),
  );

  if (!/(^|[_-])test($|[_-])/i.test(databaseName)) {
    throw new Error(
      "Refusing to use TEST_DATABASE_URL because its database name is not clearly marked as a test database.",
    );
  }

  if (
    !options.allowRuntimeAlias &&
    protectedUrls.includes(result.data.TEST_DATABASE_URL)
  ) {
    throw new Error(
      "Refusing to use TEST_DATABASE_URL because it matches DATABASE_URL or DIRECT_URL.",
    );
  }

  return result.data.TEST_DATABASE_URL;
}

export function readInventoryEventEnvironment(
  source: EnvironmentSource = process.env,
): InventoryEventEnvironment {
  const result = inventoryEventEnvironmentSchema.safeParse(source);
  if (!result.success) {
    throw formatEnvironmentError("SeatFlow Redis/worker", result.error);
  }
  return result.data;
}

export function readOptionalInventoryEventEnvironment(
  source: EnvironmentSource = process.env,
): InventoryEventEnvironment | null {
  if (!source.REDIS_URL) return null;
  return readInventoryEventEnvironment(source);
}

export function readPaymentEnvironment(
  source: EnvironmentSource = process.env,
): PaymentEnvironment {
  const result = createPaymentEnvironmentSchema(source).safeParse(source);
  if (!result.success) {
    throw formatEnvironmentError("SeatFlow payment provider", result.error);
  }
  return result.data;
}

export function readTicketEnvironment(
  source: EnvironmentSource = process.env,
): TicketEnvironment {
  const result = ticketEnvironmentSchema.safeParse(source);
  if (!result.success) {
    throw formatEnvironmentError("SeatFlow tickets", result.error);
  }
  return result.data;
}

export function readNotificationEnvironment(
  source: EnvironmentSource = process.env,
): NotificationEnvironment {
  const result = notificationEnvironmentSchema.safeParse(source);
  if (!result.success) {
    throw formatEnvironmentError("SeatFlow notification provider", result.error);
  }
  return result.data;
}
