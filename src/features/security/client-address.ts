/**
 * Trusted-proxy policy and client-address parsing.
 *
 * `X-Forwarded-For` is attacker-controlled unless every hop that appended to it
 * is trusted. SeatFlow therefore never reads a forwarding header without an
 * explicit deployment declaration of how many proxies sit in front, or which
 * platform header is authoritative.
 *
 * A resolved address is only ever used for abuse control and coarse diagnostics.
 * It is never an authorization input: authorization is the Better Auth session
 * plus PostgreSQL membership, both of which are unaffected by these headers.
 */

export const MAX_FORWARDED_HEADER_LENGTH = 1_024;
export const MAX_FORWARDED_HOPS = 20;

/**
 * - `none`      ignore all forwarding headers. Correct when the process is
 *               reached directly, and the safe default.
 * - `trusted-hop` trust a fixed number of reverse proxies that append to
 *               `X-Forwarded-For`. The client is the entry immediately left of
 *               the trusted suffix.
 * - `platform-header` trust exactly one platform-provided header, such as
 *               `cf-connecting-ip`, which the platform overwrites on ingress.
 */
export type TrustedProxyMode = "none" | "trusted-hop" | "platform-header";

export interface TrustedProxyPolicy {
  mode: TrustedProxyMode;
  /** Number of trusted proxies for `trusted-hop`. */
  hopCount?: number;
  /** Header name for `platform-header`, already lowercased. */
  headerName?: string;
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isValidIpv4(value: string) {
  const match = IPV4_PATTERN.exec(value);
  if (!match) return false;
  return match.slice(1).every((octet) => {
    if (octet.length > 1 && octet.startsWith("0")) return false;
    const parsed = Number(octet);
    return parsed >= 0 && parsed <= 255;
  });
}

export function isValidIpv6(value: string) {
  if (value.length > 45 || !/^[0-9A-Fa-f:.]+$/.test(value)) return false;
  // Three or more consecutive colons are never legal, and a single leading or
  // trailing colon must be part of a "::" elision.
  if (value.includes(":::")) return false;
  if (value.startsWith(":") && !value.startsWith("::")) return false;
  if (value.endsWith(":") && !value.endsWith("::")) return false;
  const doubleColonCount = value.split("::").length - 1;
  if (doubleColonCount > 1) return false;

  // An IPv4-mapped suffix (::ffff:203.0.113.9) is legal; validate it separately.
  const lastColon = value.lastIndexOf(":");
  let head = value;
  let trailingGroups = 0;
  if (lastColon !== -1 && value.slice(lastColon + 1).includes(".")) {
    if (!isValidIpv4(value.slice(lastColon + 1))) return false;
    head = value.slice(0, lastColon);
    trailingGroups = 2;
  }

  const groups = head.split(":");
  const explicit = groups.filter((group) => group !== "");
  if (explicit.some((group) => !/^[0-9A-Fa-f]{1,4}$/.test(group))) return false;

  const total = explicit.length + trailingGroups;
  return doubleColonCount === 1 ? total <= 7 : total === 8;
}

export function isValidIpAddress(value: string) {
  return isValidIpv4(value) || isValidIpv6(value);
}

/**
 * Normalize one forwarded entry: strip surrounding brackets, an IPv4 port
 * suffix, and whitespace. Returns null when the entry is not a valid address,
 * which is what makes a malformed chain detectable rather than guessable.
 */
export function normalizeForwardedEntry(rawEntry: string) {
  const entry = rawEntry.trim();
  if (!entry || entry.length > 64) return null;

  // [2001:db8::1]:443
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(entry);
  if (bracketed) {
    const candidate = bracketed[1]!;
    return isValidIpv6(candidate) ? candidate.toLowerCase() : null;
  }

  if (isValidIpv6(entry)) return entry.toLowerCase();

  // 203.0.113.9:443
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(entry);
  if (withPort) {
    const candidate = withPort[1]!;
    return isValidIpv4(candidate) ? candidate : null;
  }

  return isValidIpv4(entry) ? entry : null;
}

/**
 * Parse an `X-Forwarded-For` chain. A chain that is oversized, over-long, or
 * contains any entry that is not a valid IP is rejected outright rather than
 * partially trusted — a spoofed prefix must not shift which entry we select.
 */
export function parseForwardedChain(headerValue: string | null | undefined) {
  if (!headerValue) return null;
  if (headerValue.length > MAX_FORWARDED_HEADER_LENGTH) return null;
  if (/[\r\n]/.test(headerValue)) return null;

  const rawEntries = headerValue.split(",");
  if (rawEntries.length === 0 || rawEntries.length > MAX_FORWARDED_HOPS) return null;

  const entries: string[] = [];
  for (const rawEntry of rawEntries) {
    const normalized = normalizeForwardedEntry(rawEntry);
    if (!normalized) return null;
    entries.push(normalized);
  }
  return entries;
}

export interface ResolvedClientAddress {
  /** The address to attribute the request to, or null when undeterminable. */
  address: string | null;
  /** Why the address is null, for readiness and configuration diagnostics. */
  reason?: "no_forwarding_configured" | "malformed_chain" | "insufficient_hops" | "missing_header";
  /** True when the value came from a source the deployment declared trusted. */
  trusted: boolean;
}

/**
 * Resolve the client address under an explicit policy.
 *
 * `directAddress` is the peer address when the runtime exposes one. Next.js
 * route handlers generally do not, so under `none` the result is usually a null
 * address and limiters must fall back to an authenticated subject.
 */
export function resolveClientAddress(input: {
  policy: TrustedProxyPolicy;
  headers: Headers;
  directAddress?: string | null;
}): ResolvedClientAddress {
  const { policy, headers } = input;
  const direct =
    input.directAddress && isValidIpAddress(input.directAddress)
      ? input.directAddress
      : null;

  if (policy.mode === "none") {
    return direct
      ? { address: direct, trusted: true }
      : { address: null, trusted: false, reason: "no_forwarding_configured" };
  }

  if (policy.mode === "platform-header") {
    const headerName = policy.headerName;
    if (!headerName) {
      return { address: null, trusted: false, reason: "missing_header" };
    }
    const raw = headers.get(headerName);
    if (!raw) return { address: null, trusted: false, reason: "missing_header" };
    // A platform header carries exactly one address; a comma means something
    // upstream is not behaving as declared, so refuse to guess.
    const normalized = normalizeForwardedEntry(raw);
    if (!normalized || raw.includes(",")) {
      return { address: null, trusted: false, reason: "malformed_chain" };
    }
    return { address: normalized, trusted: true };
  }

  const hopCount = policy.hopCount ?? 1;
  const chain = parseForwardedChain(headers.get("x-forwarded-for"));
  if (!chain) {
    return { address: null, trusted: false, reason: "malformed_chain" };
  }
  // With N trusted proxies appending, the client is N entries from the right.
  const index = chain.length - hopCount - 1;
  if (index < 0) {
    return { address: null, trusted: false, reason: "insufficient_hops" };
  }
  return { address: chain[index]!, trusted: true };
}

/**
 * Coarsen an address for logging: IPv4 keeps its /24 and IPv6 its /48. This
 * retains enough signal to spot a noisy network without recording a full
 * address against a customer's activity.
 */
export function truncateAddressForLogs(address: string | null) {
  if (!address) return null;
  if (isValidIpv4(address)) {
    const octets = address.split(".");
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }
  if (isValidIpv6(address)) {
    const groups = address.split(":").filter((group) => group !== "");
    return `${groups.slice(0, 3).join(":")}::/48`;
  }
  return null;
}
