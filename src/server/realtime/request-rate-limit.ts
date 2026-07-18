interface RateLimitBucket {
  count: number;
  resetsAt: number;
}

const buckets = new Map<string, RateLimitBucket>();

export function consumeRateLimit(
  key: string,
  input: { limit: number; windowMs: number; now?: number },
) {
  const now = input.now ?? Date.now();
  const existing = buckets.get(key);
  if (!existing || existing.resetsAt <= now) {
    buckets.set(key, { count: 1, resetsAt: now + input.windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (existing.count >= input.limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetsAt - now) / 1_000)),
    };
  }
  existing.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

export function clientAddressFromRequest(request: Request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  ).slice(0, 128);
}
