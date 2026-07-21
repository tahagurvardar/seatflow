/**
 * Deployment profile classification.
 *
 * Phase 5C1 recognized exactly two worlds: development and production. Phase
 * 5C2A added a third, the isolated E2E harness. Phase 5C2B adds a fourth — a
 * free, serverless **staging demo** that runs a production build on a
 * vercel.app origin with a simulated payment provider and redirected email.
 *
 * The four are not interchangeable, and the whole point of naming them is that
 * relaxations granted to one are refused to the others. In particular the
 * staging demo may run `LOCAL_SIGNED`, which real production must never do.
 * That permission is not granted by a flag: `evaluateStagingDemoMode` requires
 * every condition below to hold, exactly as `evaluateIsolatedE2EMode` does.
 *
 * Deliberately not achievable by:
 *  - setting the profile flag alone (it proves intent, not isolation)
 *  - running on any routable origin (it must be vercel.app or the declared
 *    staging origin, over https)
 *  - holding Stripe credentials (their presence means real money is reachable)
 *  - declaring a live provider mode
 *  - carrying the real-production launch marker
 *
 * Pure: no `process.env`, no I/O, no clock. The caller supplies the map, so the
 * decision is exhaustively unit-testable.
 */

import { isIsolatedE2EMode } from "./e2e-test-mode";

export type EnvironmentSource = Record<string, string | undefined>;

export type DeploymentProfile =
  | "local"
  | "isolated-e2e"
  | "staging-demo"
  | "production";

export const DEPLOYMENT_PROFILES: readonly DeploymentProfile[] = [
  "local",
  "isolated-e2e",
  "staging-demo",
  "production",
];

export type StagingDemoRefusal =
  | "PROFILE_NOT_STAGING_DEMO"
  | "NOT_PRODUCTION_BUILD"
  | "ORIGIN_NOT_STAGING"
  | "PAYMENT_PROVIDER_NOT_LOCAL_SIGNED"
  | "LOCAL_SECRET_MISSING"
  | "STRIPE_CREDENTIALS_PRESENT"
  | "LIVE_PROVIDER_MODE"
  | "PRODUCTION_LAUNCH_DECLARED";

export type StagingDemoDecision =
  | { enabled: true }
  | { enabled: false; reason: StagingDemoRefusal };

function isDeploymentProfile(value: string | undefined): value is DeploymentProfile {
  return DEPLOYMENT_PROFILES.includes(value as DeploymentProfile);
}

/**
 * An origin this platform is willing to call a staging demo.
 *
 * A vercel.app subdomain is accepted because it is provably not a production
 * customer domain — nobody sells tickets from one. A deployment that wants a
 * different staging host must declare it explicitly rather than have it
 * inferred, so a future custom domain cannot silently inherit demo relaxations.
 */
export function isStagingOrigin(
  value: string | undefined,
  declaredStagingOrigin?: string | undefined,
) {
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase();
  if (host === "vercel.app" || host.endsWith(".vercel.app")) return true;

  if (!declaredStagingOrigin) return false;
  try {
    const declared = new URL(declaredStagingOrigin);
    return declared.protocol === "https:" && declared.hostname.toLowerCase() === host;
  } catch {
    return false;
  }
}

/**
 * Whether this process is a demonstrably isolated staging demo.
 *
 * Returns the first failing condition rather than a bare boolean, so a
 * misconfigured staging deployment reports why it was refused instead of
 * silently behaving like production — or, far worse, silently behaving like a
 * demo while serving a real origin.
 */
export function evaluateStagingDemoMode(env: EnvironmentSource): StagingDemoDecision {
  if (env.SEATFLOW_DEPLOYMENT_PROFILE !== "staging-demo") {
    return { enabled: false, reason: "PROFILE_NOT_STAGING_DEMO" };
  }

  // The relaxation only has to exist for a deployed build. A developer running
  // `next dev` already has LOCAL_SIGNED without any of this.
  if (env.NODE_ENV !== "production") {
    return { enabled: false, reason: "NOT_PRODUCTION_BUILD" };
  }

  // Both the auth origin and the browser-visible origin must be staging hosts.
  // Checking only one would let a deployment serve real users from a domain
  // while claiming demo status through the other.
  const declared = env.SEATFLOW_STAGING_ORIGIN;
  if (
    !isStagingOrigin(env.BETTER_AUTH_URL, declared) ||
    !isStagingOrigin(env.NEXT_PUBLIC_APP_URL, declared)
  ) {
    return { enabled: false, reason: "ORIGIN_NOT_STAGING" };
  }

  // The simulated provider must be chosen deliberately. This mode grants
  // nothing to a deployment that selected a real payment network.
  if (env.PAYMENT_PROVIDER !== "LOCAL_SIGNED") {
    return { enabled: false, reason: "PAYMENT_PROVIDER_NOT_LOCAL_SIGNED" };
  }
  if (!env.LOCAL_PAYMENT_WEBHOOK_SECRET || env.LOCAL_PAYMENT_WEBHOOK_SECRET.length < 32) {
    return { enabled: false, reason: "LOCAL_SECRET_MISSING" };
  }

  // Holding a Stripe credential disqualifies the mode outright. A process that
  // can reach a payment network is not a simulated demo, whatever it claims.
  if (env.STRIPE_SECRET_KEY || env.STRIPE_WEBHOOK_SECRET_CURRENT) {
    return { enabled: false, reason: "STRIPE_CREDENTIALS_PRESENT" };
  }

  // A demo never runs a provider in live mode. Resend in particular must stay
  // in test mode so every message is redirected to the approved recipient.
  if (env.STRIPE_MODE === "live" || env.RESEND_MODE === "live") {
    return { enabled: false, reason: "LIVE_PROVIDER_MODE" };
  }

  // The explicit real-production marker and the demo profile are mutually
  // exclusive; a deployment carrying both is misconfigured, not permitted.
  if (env.SEATFLOW_PRODUCTION_LAUNCH === "true") {
    return { enabled: false, reason: "PRODUCTION_LAUNCH_DECLARED" };
  }

  return { enabled: true };
}

/** Convenience predicate for call sites that only need the verdict. */
export function isStagingDemoMode(env: EnvironmentSource) {
  return evaluateStagingDemoMode(env).enabled;
}

/**
 * Classify the running deployment.
 *
 * The default matters more than the happy path: when the profile is unset, a
 * production build is classified as real **production**, the strictest world.
 * Forgetting to declare a profile therefore fails closed into the mode that
 * refuses simulated payments, not into the one that permits them.
 */
export function resolveDeploymentProfile(env: EnvironmentSource): DeploymentProfile {
  if (isIsolatedE2EMode(env)) return "isolated-e2e";

  const declared = env.SEATFLOW_DEPLOYMENT_PROFILE;
  if (isDeploymentProfile(declared)) {
    // A claimed staging demo that fails its conditions is not downgraded to
    // something permissive: it is treated as the production it resembles.
    if (declared === "staging-demo" && !isStagingDemoMode(env)) return "production";
    // "isolated-e2e" cannot be claimed by declaration alone; the harness
    // conditions above are the only route into it.
    if (declared === "isolated-e2e") return env.NODE_ENV === "production" ? "production" : "local";
    return declared;
  }

  return env.NODE_ENV === "production" ? "production" : "local";
}

/** True only for a deployment that intends to serve real customers. */
export function isRealProductionDeployment(env: EnvironmentSource) {
  return resolveDeploymentProfile(env) === "production";
}

/**
 * Whether this deployment may construct the simulated payment provider.
 *
 * The simulated provider guards itself, and it must ask this question rather
 * than answer it: a guard that reasons about flags directly is how a second,
 * subtly weaker idea of "staging" gets invented. Routing through
 * `resolveDeploymentProfile` means the permission is exactly the profile
 * policy — a claimed staging demo that fails any condition in
 * `evaluateStagingDemoMode` resolves to `production`, which refuses.
 */
export function permitsSimulatedPaymentProvider(env: EnvironmentSource) {
  return profileCapabilities(resolveDeploymentProfile(env)).allowsSimulatedPayments;
}

/**
 * What the profile is allowed to relax. Centralized so a new call site cannot
 * invent its own idea of what staging may do.
 */
export interface ProfileCapabilities {
  /** May run the simulated payment provider. */
  allowsSimulatedPayments: boolean;
  /** May redirect all outbound email to one approved test recipient. */
  allowsRedirectedEmail: boolean;
  /** May run scheduled work as serverless HTTP jobs instead of processes. */
  allowsServerlessJobs: boolean;
  /** May serve inventory updates by polling instead of a realtime socket. */
  allowsPollingFallback: boolean;
  /** Must present itself to users as a non-production environment. */
  requiresDemoDisclosure: boolean;
}

export function profileCapabilities(profile: DeploymentProfile): ProfileCapabilities {
  switch (profile) {
    case "production":
      return {
        allowsSimulatedPayments: false,
        allowsRedirectedEmail: false,
        allowsServerlessJobs: false,
        allowsPollingFallback: false,
        requiresDemoDisclosure: false,
      };
    case "staging-demo":
      return {
        allowsSimulatedPayments: true,
        allowsRedirectedEmail: true,
        allowsServerlessJobs: true,
        allowsPollingFallback: true,
        requiresDemoDisclosure: true,
      };
    case "isolated-e2e":
      return {
        allowsSimulatedPayments: true,
        allowsRedirectedEmail: true,
        allowsServerlessJobs: true,
        allowsPollingFallback: true,
        requiresDemoDisclosure: false,
      };
    case "local":
      return {
        allowsSimulatedPayments: true,
        allowsRedirectedEmail: true,
        allowsServerlessJobs: true,
        allowsPollingFallback: true,
        requiresDemoDisclosure: true,
      };
  }
}
