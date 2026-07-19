import { correlationIdFromHeaders } from "@/features/observability/correlation";
import { CORRELATION_HEADER } from "@/features/observability/correlation";
import type { RateLimitPolicyName } from "@/features/security/rate-limit-policy";
import { getLogger } from "@/server/observability/logger";
import { getMetricsRegistry } from "@/server/observability/metrics-registry";
import { enforceRateLimit } from "@/server/security/rate-limit";

/**
 * Route-level abuse guard.
 *
 * Returns a bounded 429 when a policy rejects the request, or null to continue.
 * A rejection body carries no detail about the limit, the subject, or the
 * remaining budget beyond a `Retry-After` hint, so it cannot be used to probe
 * whether a given account or address exists.
 *
 * A limiter failure never blocks the request: the policy's declared failure mode
 * has already decided that, and an exception here is treated as fail-open so an
 * observability fault cannot take an endpoint down.
 */
export async function applyRateLimit(input: {
  policyName: RateLimitPolicyName;
  request: Request;
  subjectId?: string | null;
  operation?: string;
}): Promise<Response | null> {
  const correlationId = correlationIdFromHeaders(input.request.headers);

  let result;
  try {
    result = await enforceRateLimit({
      policyName: input.policyName,
      headers: input.request.headers,
      subjectId: input.subjectId,
    });
  } catch (error) {
    getLogger().warn("rate limit evaluation failed", {
      correlationId,
      operation: input.operation,
      outcome: "limiter_error",
      error,
      metadata: { policy: input.policyName },
    });
    return null;
  }

  if (result.allowed) return null;

  getMetricsRegistry().recordRateLimitRejection(result.policyName);
  getLogger().warn("request rejected by rate limit", {
    correlationId,
    operation: input.operation,
    outcome: "rate_limited",
    metadata: {
      policy: result.policyName,
      source: result.source,
      // Coarsened /24 or /48 label, never a full address.
      network: result.addressLabel,
    },
  });

  return Response.json(
    { error: "Too many requests. Please retry shortly.", correlationId },
    {
      status: 429,
      headers: {
        "Retry-After": String(Math.max(1, result.retryAfterSeconds)),
        "Cache-Control": "private, no-store, max-age=0",
        [CORRELATION_HEADER]: correlationId,
      },
    },
  );
}
