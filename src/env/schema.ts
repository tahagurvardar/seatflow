import { z } from "zod";

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

const applicationEnvironmentSchema = z.object({
  DATABASE_URL: postgresUrlSchema,
  DIRECT_URL: postgresUrlSchema.optional(),
  BETTER_AUTH_SECRET: z.string().min(32, "must contain at least 32 characters"),
  BETTER_AUTH_URL: z.url("must be a valid absolute URL"),
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
});

const paymentEnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PAYMENT_PROVIDER: z.enum(["LOCAL_SIGNED", "EXTERNAL"]),
    LOCAL_PAYMENT_WEBHOOK_SECRET: z.string().min(32).max(512).optional(),
    PAYMENT_WEBHOOK_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(1_048_576)
      .default(65_536),
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
      environment.PAYMENT_PROVIDER === "LOCAL_SIGNED"
    ) {
      context.addIssue({
        code: "custom",
        path: ["PAYMENT_PROVIDER"],
        message: "LOCAL_SIGNED is forbidden in production",
      });
    }
  });

export type ApplicationEnvironment = z.infer<
  typeof applicationEnvironmentSchema
>;
export type InventoryEventEnvironment = z.infer<
  typeof inventoryEventEnvironmentSchema
>;
export type PaymentEnvironment = z.infer<typeof paymentEnvironmentSchema>;

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
  const result = paymentEnvironmentSchema.safeParse(source);
  if (!result.success) {
    throw formatEnvironmentError("SeatFlow payment provider", result.error);
  }
  return result.data;
}
