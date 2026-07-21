/**
 * Where — and whether — the browser should open a realtime socket.
 *
 * Phase 4B assumed a Socket.IO gateway always exists, so the seat pages fell
 * back to `http://localhost:3001` when `NEXT_PUBLIC_REALTIME_URL` was unset.
 * On a hosted deployment that is actively wrong: every visitor's browser tries
 * to reach a gateway on *their own machine*, fails, logs a console error, and
 * only then degrades to polling.
 *
 * A free serverless staging environment has no gateway at all, which makes the
 * absence of a URL the normal case rather than a misconfiguration. Resolving to
 * an explicit "poll" decision means the client starts in its authoritative
 * refresh loop immediately, with no failed connection and no console noise.
 *
 * PostgreSQL is the authority in both modes. The socket only ever says
 * "something changed, ask again"; polling asks on a timer instead. No inventory
 * or financial decision depends on which one is in use.
 *
 * Pure: no I/O. The caller supplies the environment map.
 */

export type EnvironmentSource = Record<string, string | undefined>;

export type RealtimeEndpointDecision =
  | { mode: "socket"; url: string }
  | { mode: "poll"; reason: RealtimePollReason };

export type RealtimePollReason =
  | "NOT_CONFIGURED"
  | "INVALID_URL"
  | "LOOPBACK_ON_HOSTED_DEPLOYMENT";

/** Bounds the fallback refresh so a busy session cannot be hammered. */
export const MINIMUM_POLL_INTERVAL_MS = 5_000;
export const MAXIMUM_POLL_INTERVAL_MS = 300_000;
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

function isLoopbackHost(host: string) {
  const lowered = host.toLowerCase();
  return (
    lowered === "localhost" ||
    lowered === "127.0.0.1" ||
    lowered === "::1" ||
    lowered.endsWith(".local")
  );
}

/**
 * Decide the transport.
 *
 * `hosted` distinguishes a developer's machine — where a loopback gateway is
 * exactly right — from a deployed environment, where a loopback URL can only
 * ever point at the visitor's own computer.
 */
export function resolveRealtimeEndpoint(
  env: EnvironmentSource,
  options: { hosted?: boolean } = {},
): RealtimeEndpointDecision {
  const configured = env.NEXT_PUBLIC_REALTIME_URL?.trim();
  if (!configured) return { mode: "poll", reason: "NOT_CONFIGURED" };

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return { mode: "poll", reason: "INVALID_URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { mode: "poll", reason: "INVALID_URL" };
  }
  if (options.hosted && isLoopbackHost(url.hostname)) {
    return { mode: "poll", reason: "LOOPBACK_ON_HOSTED_DEPLOYMENT" };
  }

  return { mode: "socket", url: configured };
}

/** Clamp an operator-supplied interval into the supported range. */
export function resolvePollIntervalMs(value: string | undefined) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_POLL_INTERVAL_MS;
  return Math.min(MAXIMUM_POLL_INTERVAL_MS, Math.max(MINIMUM_POLL_INTERVAL_MS, Math.round(parsed)));
}

/**
 * The single value the seat pages pass to the client hook. An empty string is
 * the hook's existing signal for "no socket, poll instead", so the polling path
 * needs no new client contract.
 */
export function realtimeUrlForClient(
  env: EnvironmentSource,
  options: { hosted?: boolean } = {},
) {
  const decision = resolveRealtimeEndpoint(env, options);
  return decision.mode === "socket" ? decision.url : "";
}
