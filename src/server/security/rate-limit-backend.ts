/**
 * The distributed rate-limit counter, over whichever transport is available.
 *
 * Deliberately **no** `server-only` marker, matching its sibling
 * `rate-limit.ts`. Both are reached from CLI processes — the chaos harness
 * imports `evaluateReadiness`, which probes limiter availability — and a
 * `server-only` import throws outside a server component resolution, breaking
 * those scripts. Neither module holds a secret that a client bundle could leak:
 * the Upstash token arrives as a constructor argument from validated
 * environment, never as a module-level constant.
 *
 * Phase 5C1 spoke to Redis over TCP, which is right for a resident process that
 * opens one connection and keeps it. A serverless deployment is different: many
 * short-lived isolates, each with its own module scope, and a free-tier Redis
 * with a connection ceiling that a traffic spike can exhaust. Upstash's REST
 * endpoint has no socket lifecycle at all, so it fits that shape far better.
 *
 * Both transports run the *same* Lua script, so the limiting policy is
 * identical either way and only the transport differs. The script itself is the
 * important part: INCR and PEXPIRE together, atomically, so a crash between
 * them cannot leave a key without a TTL and lock a subject out permanently.
 *
 * Neither transport is ever consulted for correctness. A failure here degrades
 * how fast abuse is throttled and nothing else.
 */

export const WINDOW_INCREMENT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return current
`;

export interface RateLimitBackend {
  readonly transport: "rest" | "tcp";
  /** Returns the subject's count within the current window. */
  increment(key: string, windowMs: number, timeoutMs: number): Promise<number>;
  available(timeoutMs: number): Promise<boolean>;
}

export interface UpstashRestConfiguration {
  restUrl: string;
  restToken: string;
}

/**
 * Stateless REST backend.
 *
 * Nothing is retained between calls, so concurrent invocations cannot exhaust a
 * connection pool. The bearer token appears only in the Authorization header
 * and is never logged or included in an error.
 */
export class UpstashRestRateLimitBackend implements RateLimitBackend {
  readonly transport = "rest" as const;

  constructor(
    private readonly configuration: UpstashRestConfiguration,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async command(payload: unknown[], timeoutMs: number) {
    const response = await this.fetchImpl(this.configuration.restUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.configuration.restToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // Status only. An error body can quote the command, and the command
      // carries the hashed rate-limit subject.
      throw new Error(`UPSTASH_REST_STATUS_${response.status}`);
    }
    return (await response.json()) as { result?: unknown };
  }

  async increment(key: string, windowMs: number, timeoutMs: number) {
    const body = await this.command(
      ["EVAL", WINDOW_INCREMENT_SCRIPT, "1", key, String(windowMs)],
      timeoutMs,
    );
    const count = Number(body.result);
    if (!Number.isFinite(count)) throw new Error("UPSTASH_REST_UNPARSEABLE_COUNT");
    return count;
  }

  async available(timeoutMs: number) {
    try {
      const body = await this.command(["PING"], timeoutMs);
      return body.result === "PONG";
    } catch {
      return false;
    }
  }
}

export function createUpstashRestConfiguration(environment: {
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
}): UpstashRestConfiguration | null {
  if (!environment.UPSTASH_REDIS_REST_URL || !environment.UPSTASH_REDIS_REST_TOKEN) {
    return null;
  }
  return {
    restUrl: environment.UPSTASH_REDIS_REST_URL,
    restToken: environment.UPSTASH_REDIS_REST_TOKEN,
  };
}
