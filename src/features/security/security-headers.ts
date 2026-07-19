/**
 * Production security header policy.
 *
 * Written as a pure function so the exact header set is unit testable and
 * reviewable without booting the application.
 *
 * The policy is deliberately compatible with the features this application
 * actually ships. Each relaxation below is a considered trade-off, not an
 * oversight:
 *
 *  - `style-src` includes `'unsafe-inline'` because the seat map positions
 *    every seat with an inline `style` attribute. Browsers govern inline style
 *    *attributes* through `style-src`/`style-src-attr`, so a nonce cannot cover
 *    them; removing the relaxation would break seat selection outright. The XSS
 *    value of inline styles is far lower than that of inline scripts, and
 *    `script-src` remains nonce-gated.
 *  - `img-src` allows `data:` and `blob:` because QR codes are rendered as
 *    inline SVG/data URIs and PDF downloads are delivered as object URLs.
 *  - `connect-src` includes the configured Socket.IO gateway origin and its
 *    WebSocket scheme, otherwise realtime inventory invalidation silently fails
 *    and clients fall back to polling.
 *  - `media-src` allows `blob:` so the scanner's camera stream can be attached.
 *  - `'unsafe-eval'` is added in development only, where React uses `eval` to
 *    rebuild server error stacks.
 */

export interface SecurityHeaderOptions {
  /** Per-request nonce used to authorize Next.js's inline bootstrap scripts. */
  nonce: string;
  isDevelopment: boolean;
  /** Send HSTS only over HTTPS; sending it over plain HTTP is meaningless. */
  isHttps: boolean;
  hstsMaxAgeSeconds: number;
  /** Origin of the Socket.IO gateway, e.g. `https://realtime.example.com`. */
  realtimeOrigin?: string | null;
}

/** Convert an http(s) origin into its ws(s) equivalent for `connect-src`. */
export function toWebSocketOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol === "https:") return `wss://${url.host}`;
    if (url.protocol === "http:") return `ws://${url.host}`;
    return null;
  } catch {
    return null;
  }
}

function connectSources(realtimeOrigin: string | null | undefined) {
  const sources = ["'self'"];
  if (!realtimeOrigin) return sources;

  try {
    const url = new URL(realtimeOrigin);
    sources.push(url.origin);
    const webSocketOrigin = toWebSocketOrigin(realtimeOrigin);
    if (webSocketOrigin) sources.push(webSocketOrigin);
  } catch {
    // An unparseable origin is ignored rather than injected into the policy.
  }
  return sources;
}

export function buildContentSecurityPolicy(options: SecurityHeaderOptions): string {
  const scriptSources = [
    "'self'",
    `'nonce-${options.nonce}'`,
    // `strict-dynamic` lets Next.js's nonced bootstrap load its own chunks
    // without enumerating every hashed filename.
    "'strict-dynamic'",
    ...(options.isDevelopment ? ["'unsafe-eval'"] : []),
  ];

  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["script-src", scriptSources],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'", "data:"]],
    ["media-src", ["'self'", "blob:"]],
    ["connect-src", connectSources(options.realtimeOrigin)],
    ["worker-src", ["'self'", "blob:"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
    ["frame-src", ["'none'"]],
  ];

  const rendered = directives.map(([name, values]) => `${name} ${values.join(" ")}`);
  if (!options.isDevelopment) {
    // Only meaningful in production; in local HTTP development it would break
    // the dev server by rewriting every request to https.
    rendered.push("upgrade-insecure-requests");
  }
  return rendered.join("; ");
}

/**
 * Build the complete response header set.
 *
 * `Permissions-Policy` grants `camera=(self)` rather than denying it, because
 * the organizer scanner needs the camera on this origin. Everything else the
 * application does not use is denied outright.
 */
export function buildSecurityHeaders(
  options: SecurityHeaderOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": buildContentSecurityPolicy(options),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": [
      "camera=(self)",
      "microphone=()",
      "geolocation=()",
      "payment=()",
      "usb=()",
      "magnetometer=()",
      "accelerometer=()",
      "gyroscope=()",
      "interest-cohort=()",
    ].join(", "),
    // `same-origin` would block the cross-origin Socket.IO handshake, so the
    // opener policy is relaxed to the strongest value that keeps realtime working.
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    "Cross-Origin-Resource-Policy": "same-site",
    "X-DNS-Prefetch-Control": "off",
  };

  if (options.isHttps && options.hstsMaxAgeSeconds > 0) {
    headers["Strict-Transport-Security"] =
      `max-age=${options.hstsMaxAgeSeconds}; includeSubDomains`;
  }

  return headers;
}

/**
 * Path prefixes whose responses must never be stored by a shared or browser
 * cache: tickets, QR images, PDFs, bookings, checkout, payments, and health.
 */
const SENSITIVE_PATH_PREFIXES = [
  "/api/tickets",
  "/api/payments",
  "/api/operations",
  "/api/health",
  "/api/inventory",
  "/customer",
  "/organizer",
  "/venue-operator",
  "/admin",
] as const;

export function isSensitivePath(pathname: string) {
  return SENSITIVE_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export const SENSITIVE_CACHE_CONTROL = "private, no-store, max-age=0, must-revalidate";
