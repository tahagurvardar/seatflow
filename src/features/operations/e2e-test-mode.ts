/**
 * Isolated end-to-end test mode.
 *
 * Browser verification has to run against a **production build**, because the
 * dev server injects a hot-reload socket and a dev-tools portal that make "no
 * console errors" and "no framework overlay" unverifiable. But a production
 * build sets `NODE_ENV=production`, and the development-only `LOCAL_SIGNED`
 * payment provider is deliberately forbidden there — which is exactly the rule
 * that must not be weakened.
 *
 * This module is the narrow, auditable exception. It grants nothing on its own:
 * it answers one question — "is this process demonstrably an isolated E2E
 * harness?" — and **every** condition below must hold. Any single failure means
 * no override.
 *
 * Deliberately not achievable by:
 *  - setting one flag (the flag alone proves nothing)
 *  - pointing at a real database (the name must be test-marked, and must differ
 *    from the protected development/production URL)
 *  - serving real users (the origin must be loopback)
 *  - holding real provider credentials (their presence disqualifies the mode)
 *
 * Pure: no `process.env`, no I/O, no clock. The caller supplies the map, so the
 * decision is exhaustively unit-testable.
 */

export type EnvironmentSource = Record<string, string | undefined>;

export type E2EModeRefusal =
  | "FLAG_NOT_SET"
  | "DATABASE_NOT_TEST_MARKED"
  | "DATABASE_IS_PROTECTED"
  | "ORIGIN_NOT_LOOPBACK"
  | "LOCAL_SECRET_MISSING"
  | "REAL_PROVIDER_CREDENTIALS_PRESENT";

export type E2EModeDecision =
  | { enabled: true }
  | { enabled: false; reason: E2EModeRefusal };

/** A database whose name is clearly disposable, e.g. `seatflow_test`. */
function isTestMarkedDatabase(url: string | undefined) {
  if (!url) return false;
  try {
    const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
    return /(^|[_-])test($|[_-])/i.test(name);
  } catch {
    return false;
  }
}

function isLoopbackOrigin(value: string | undefined) {
  if (!value) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/**
 * Whether this process is an isolated E2E harness.
 *
 * Returns the first failing condition rather than a bare boolean, so a
 * misconfigured harness reports why it was refused instead of silently
 * behaving like production.
 */
export function evaluateIsolatedE2EMode(env: EnvironmentSource): E2EModeDecision {
  if (env.SEATFLOW_E2E_TEST_MODE !== "true") {
    return { enabled: false, reason: "FLAG_NOT_SET" };
  }

  // The application must be pointed at a disposable, clearly-marked test
  // database — never at whatever DATABASE_URL happened to be inherited.
  if (!isTestMarkedDatabase(env.DATABASE_URL)) {
    return { enabled: false, reason: "DATABASE_NOT_TEST_MARKED" };
  }

  // And it must not be the database the deployment protects. If the harness is
  // somehow aimed at the real one, the mode is refused even if that database
  // were named to look like a test.
  const protectedUrl = env.SEATFLOW_PROTECTED_DATABASE_URL;
  if (protectedUrl && (env.DATABASE_URL === protectedUrl || env.DIRECT_URL === protectedUrl)) {
    return { enabled: false, reason: "DATABASE_IS_PROTECTED" };
  }

  // A harness serves itself on loopback. Anything routable is real traffic.
  if (!isLoopbackOrigin(env.BETTER_AUTH_URL) || !isLoopbackOrigin(env.NEXT_PUBLIC_APP_URL)) {
    return { enabled: false, reason: "ORIGIN_NOT_LOOPBACK" };
  }

  // The simulated provider needs its synthetic secret; without one there is
  // nothing to verify signatures against and no reason to grant the mode.
  if (!env.LOCAL_PAYMENT_WEBHOOK_SECRET || env.LOCAL_PAYMENT_WEBHOOK_SECRET.length < 32) {
    return { enabled: false, reason: "LOCAL_SECRET_MISSING" };
  }

  // Holding real provider credentials disqualifies the mode outright. A process
  // that can reach Stripe or Resend is not a sealed harness, whatever else it
  // claims about itself.
  if (env.STRIPE_SECRET_KEY || env.RESEND_API_KEY) {
    return { enabled: false, reason: "REAL_PROVIDER_CREDENTIALS_PRESENT" };
  }

  return { enabled: true };
}

/** Convenience predicate for call sites that only need the verdict. */
export function isIsolatedE2EMode(env: EnvironmentSource) {
  return evaluateIsolatedE2EMode(env).enabled;
}
