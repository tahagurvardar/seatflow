import { z } from "zod";

type EnvironmentSource = Record<string, string | undefined>;

const postgresUrlSchema = z
  .url("must be a valid URL")
  .refine(
    (value) => value.startsWith("postgresql://") || value.startsWith("postgres://"),
    "must use the postgresql:// or postgres:// protocol",
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

export type ApplicationEnvironment = z.infer<
  typeof applicationEnvironmentSchema
>;

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
