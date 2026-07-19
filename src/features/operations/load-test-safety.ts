/**
 * Load-test target guards.
 *
 * A load generator pointed at production is an outage. These guards are pure,
 * exhaustively tested, and must be called before any scenario runs.
 *
 * The default posture is refusal: a target is rejected unless it is provably
 * local or provably disposable.
 */

export class LoadTestSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoadTestSafetyError";
  }
}

const DISPOSABLE_DATABASE_PATTERN = /(^|[_-])(test|local|scratch|loadtest)($|[_-])/i;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "[::1]"]);

export function isLoopbackHost(hostname: string) {
  const normalized = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(normalized) || normalized.endsWith(".localhost");
}

export function isDisposableLoadTestDatabase(url: string) {
  try {
    const parsed = new URL(url);
    const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    return DISPOSABLE_DATABASE_PATTERN.test(name);
  } catch {
    return false;
  }
}

export interface LoadTestTargetInput {
  databaseUrl: string | undefined;
  /** HTTP base URL, when a scenario drives the web tier. */
  baseUrl?: string | undefined;
  nodeEnv: string | undefined;
  /** Set only by an operator who has accepted the risk in writing. */
  allowNonLocalTarget?: boolean;
}

/**
 * Throw unless every supplied target is safe to hammer.
 *
 * `allowNonLocalTarget` deliberately does not bypass the production check or
 * the disposable-database check. It only permits a non-loopback *HTTP* host,
 * such as a dedicated staging deployment.
 */
export function assertSafeLoadTestTarget(input: LoadTestTargetInput) {
  if (input.nodeEnv === "production") {
    throw new LoadTestSafetyError(
      "Refusing to run load tests with NODE_ENV=production.",
    );
  }

  if (!input.databaseUrl) {
    throw new LoadTestSafetyError("A load-test database URL is required.");
  }
  if (!isDisposableLoadTestDatabase(input.databaseUrl)) {
    throw new LoadTestSafetyError(
      "Refusing to run load tests: the database name is not marked disposable. " +
        "Point TEST_DATABASE_URL at a database whose name contains 'test', 'local', 'scratch', or 'loadtest'.",
    );
  }

  if (input.baseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(input.baseUrl);
    } catch {
      throw new LoadTestSafetyError("Load-test base URL is not a valid URL.");
    }
    if (!isLoopbackHost(parsed.hostname) && !input.allowNonLocalTarget) {
      throw new LoadTestSafetyError(
        `Refusing to generate load against non-loopback host "${parsed.hostname}". ` +
          "Pass --allow-non-local only for a dedicated disposable environment.",
      );
    }
  }

  return true;
}

export interface LoadTestBounds {
  concurrency: number;
  durationSeconds: number;
  iterations: number;
}

export const LOAD_TEST_DEFAULTS: LoadTestBounds = {
  concurrency: 8,
  durationSeconds: 5,
  iterations: 50,
};

export const LOAD_TEST_MAXIMUMS: LoadTestBounds = {
  concurrency: 64,
  durationSeconds: 120,
  iterations: 5_000,
};

/** Clamp operator input so a typo cannot launch an unbounded run. */
export function boundLoadTestParameters(
  input: Partial<LoadTestBounds>,
): LoadTestBounds {
  const clamp = (value: number | undefined, fallback: number, maximum: number) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback;
    return Math.min(Math.floor(value), maximum);
  };
  return {
    concurrency: clamp(input.concurrency, LOAD_TEST_DEFAULTS.concurrency, LOAD_TEST_MAXIMUMS.concurrency),
    durationSeconds: clamp(
      input.durationSeconds,
      LOAD_TEST_DEFAULTS.durationSeconds,
      LOAD_TEST_MAXIMUMS.durationSeconds,
    ),
    iterations: clamp(input.iterations, LOAD_TEST_DEFAULTS.iterations, LOAD_TEST_MAXIMUMS.iterations),
  };
}

export interface LatencySummary {
  count: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

/** Exact percentiles from recorded samples. Load runs are small enough to sort. */
export function summarizeLatencies(samplesMs: readonly number[]): LatencySummary {
  if (samplesMs.length === 0) {
    return { count: 0, averageMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  }
  const sorted = [...samplesMs].sort((left, right) => left - right);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]!;
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    averageMs: Math.round((total / sorted.length) * 100) / 100,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
    maxMs: sorted[sorted.length - 1]!,
  };
}

export interface ScenarioThresholds {
  maximumErrorRate: number;
  maximumP95Ms: number;
}

export interface ScenarioOutcome {
  name: string;
  operations: number;
  errors: number;
  latency: LatencySummary;
  /** Correctness assertions. A failure here fails the run regardless of speed. */
  invariants: Array<{ description: string; passed: boolean; detail?: string }>;
}

/**
 * A scenario passes only when its correctness invariants hold *and* its
 * performance stays inside thresholds. Throughput never excuses a broken
 * invariant.
 */
export function evaluateScenario(
  outcome: ScenarioOutcome,
  thresholds: ScenarioThresholds,
) {
  const errorRate = outcome.operations > 0 ? outcome.errors / outcome.operations : 0;
  const failedInvariants = outcome.invariants.filter((entry) => !entry.passed);
  return {
    passed:
      failedInvariants.length === 0 &&
      errorRate <= thresholds.maximumErrorRate &&
      outcome.latency.p95Ms <= thresholds.maximumP95Ms,
    errorRate,
    failedInvariants,
  };
}
