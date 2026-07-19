import { RATE_LIMIT_POLICIES } from "@/features/security/rate-limit-policy";

/**
 * In-process operational counters.
 *
 * Every label in this file comes from a closed set. That is the whole point:
 * a metric labelled with a user ID, ticket ID, booking reference, event slug,
 * session ID, email, IP address, or raw path would grow without bound, make the
 * metric store unusable, and quietly turn an operational dashboard into a
 * customer-data export.
 *
 * These counters are per-process and reset on restart. They are a supplement to
 * the PostgreSQL aggregates in `metrics.ts`, which are authoritative and
 * survive deployment.
 */

/** Closed set of route groups. A path never becomes a label directly. */
export const ROUTE_GROUPS = [
  "public_events",
  "auth",
  "customer",
  "organizer",
  "venue_operator",
  "admin",
  "api_inventory",
  "api_tickets",
  "api_payments",
  "api_operations",
  "api_auth",
  "health",
  "other",
] as const;

export type RouteGroup = (typeof ROUTE_GROUPS)[number];

export type HttpOutcomeClass = "2xx" | "3xx" | "4xx" | "5xx";

/**
 * Map a pathname onto a bounded group.
 *
 * Matching is prefix-based and deliberately ignores everything after the
 * identifying segment, so `/events/summer-fest-2026/sessions/abc/seats` and
 * `/events/winter-gala/sessions/def/seats` collapse to one label.
 */
export function classifyRouteGroup(pathname: string): RouteGroup {
  if (!pathname.startsWith("/")) return "other";

  if (pathname.startsWith("/api/auth")) return "api_auth";
  if (pathname.startsWith("/api/inventory")) return "api_inventory";
  if (pathname.startsWith("/api/tickets")) return "api_tickets";
  if (pathname.startsWith("/api/payments")) return "api_payments";
  if (pathname.startsWith("/api/operations")) return "api_operations";
  if (pathname.startsWith("/api/health")) return "health";

  if (pathname === "/login" || pathname === "/register") return "auth";
  if (pathname.startsWith("/events") || pathname === "/") return "public_events";
  if (pathname.startsWith("/customer")) return "customer";
  if (pathname.startsWith("/organizer")) return "organizer";
  if (pathname.startsWith("/venue-operator")) return "venue_operator";
  if (pathname.startsWith("/admin")) return "admin";

  return "other";
}

export function outcomeClassFromStatus(status: number): HttpOutcomeClass {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

/** Fixed latency buckets in milliseconds, for approximate percentiles. */
const DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000] as const;

interface DurationHistogram {
  count: number;
  sumMs: number;
  maxMs: number;
  buckets: number[];
}

function createHistogram(): DurationHistogram {
  return { count: 0, sumMs: 0, maxMs: 0, buckets: new Array(DURATION_BUCKETS_MS.length + 1).fill(0) };
}

function observe(histogram: DurationHistogram, durationMs: number) {
  const value = Math.max(0, Math.min(durationMs, 3_600_000));
  histogram.count += 1;
  histogram.sumMs += value;
  histogram.maxMs = Math.max(histogram.maxMs, value);
  const index = DURATION_BUCKETS_MS.findIndex((bound) => value <= bound);
  histogram.buckets[index === -1 ? DURATION_BUCKETS_MS.length : index]! += 1;
}

/**
 * Approximate a percentile from bucket counts. The result is reported as the
 * bucket's upper bound, so it is an upper estimate rather than an interpolation
 * that would imply more precision than a histogram carries.
 */
function percentile(histogram: DurationHistogram, fraction: number): number | null {
  if (histogram.count === 0) return null;
  const target = Math.ceil(histogram.count * fraction);
  let cumulative = 0;
  for (let index = 0; index < histogram.buckets.length; index += 1) {
    cumulative += histogram.buckets[index]!;
    if (cumulative >= target) {
      return index < DURATION_BUCKETS_MS.length ? DURATION_BUCKETS_MS[index]! : histogram.maxMs;
    }
  }
  return histogram.maxMs;
}

export interface RouteGroupMetrics {
  group: RouteGroup;
  requestCount: number;
  outcomes: Record<HttpOutcomeClass, number>;
  durationMs: {
    averageMs: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
    maxMs: number;
  };
}

export interface MetricsSnapshot {
  since: string;
  routes: RouteGroupMetrics[];
  rateLimitRejections: Record<string, number>;
  totals: {
    requestCount: number;
    outcomes: Record<HttpOutcomeClass, number>;
    rateLimitRejections: number;
  };
}

function emptyOutcomes(): Record<HttpOutcomeClass, number> {
  return { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
}

class MetricsRegistry {
  private startedAt = new Date();
  private readonly histograms = new Map<RouteGroup, DurationHistogram>();
  private readonly outcomes = new Map<RouteGroup, Record<HttpOutcomeClass, number>>();
  private readonly rateLimitRejections = new Map<string, number>();

  recordRequest(input: {
    group: RouteGroup;
    outcomeClass: HttpOutcomeClass;
    durationMs: number;
  }) {
    const histogram = this.histograms.get(input.group) ?? createHistogram();
    observe(histogram, input.durationMs);
    this.histograms.set(input.group, histogram);

    const outcomes = this.outcomes.get(input.group) ?? emptyOutcomes();
    outcomes[input.outcomeClass] += 1;
    this.outcomes.set(input.group, outcomes);
  }

  /**
   * Only names from the policy catalogue are accepted, which is what keeps this
   * map bounded even if a caller passes something unexpected.
   */
  recordRateLimitRejection(policyName: string) {
    const key = policyName in RATE_LIMIT_POLICIES ? policyName : "unclassified";
    this.rateLimitRejections.set(key, (this.rateLimitRejections.get(key) ?? 0) + 1);
  }

  snapshot(): MetricsSnapshot {
    const routes: RouteGroupMetrics[] = [];
    const totalOutcomes = emptyOutcomes();
    let totalRequests = 0;

    for (const [group, histogram] of this.histograms) {
      const outcomes = this.outcomes.get(group) ?? emptyOutcomes();
      for (const outcomeClass of Object.keys(totalOutcomes) as HttpOutcomeClass[]) {
        totalOutcomes[outcomeClass] += outcomes[outcomeClass];
      }
      totalRequests += histogram.count;

      routes.push({
        group,
        requestCount: histogram.count,
        outcomes: { ...outcomes },
        durationMs: {
          averageMs: histogram.count > 0 ? Math.round(histogram.sumMs / histogram.count) : null,
          p50Ms: percentile(histogram, 0.5),
          p95Ms: percentile(histogram, 0.95),
          p99Ms: percentile(histogram, 0.99),
          maxMs: Math.round(histogram.maxMs),
        },
      });
    }

    routes.sort((left, right) => left.group.localeCompare(right.group));

    const rejections = Object.fromEntries(this.rateLimitRejections);
    return {
      since: this.startedAt.toISOString(),
      routes,
      rateLimitRejections: rejections,
      totals: {
        requestCount: totalRequests,
        outcomes: totalOutcomes,
        rateLimitRejections: Object.values(rejections).reduce((sum, value) => sum + value, 0),
      },
    };
  }

  reset() {
    this.startedAt = new Date();
    this.histograms.clear();
    this.outcomes.clear();
    this.rateLimitRejections.clear();
  }
}

const registry = new MetricsRegistry();

export function getMetricsRegistry() {
  return registry;
}
