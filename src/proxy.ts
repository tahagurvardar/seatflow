import { NextResponse, type NextRequest } from "next/server";

import {
  CORRELATION_HEADER,
  correlationIdFromHeaders,
} from "@/features/observability/correlation";
import { resolveRealtimeEndpoint } from "@/features/inventory-events/realtime-endpoint";
import {
  buildSecurityHeaders,
  isSensitivePath,
  SENSITIVE_CACHE_CONTROL,
} from "@/features/security/security-headers";

/**
 * Request proxy (this Next.js version's replacement for the deprecated
 * `middleware` convention).
 *
 * Responsibilities are limited to things that must happen for every request and
 * that need no shared state, because a proxy may be executed away from the
 * render path and must not rely on module globals:
 *
 *  1. establish a correlation ID and expose it to both the route and the client;
 *  2. attach the security header policy;
 *  3. mark sensitive paths uncacheable.
 *
 * It performs no authorization. Every page, route handler, and Server Function
 * re-authorizes against PostgreSQL; a matcher change must never be able to
 * silently remove an access check.
 *
 * This function must never throw. A proxy exception would fail every request,
 * so configuration is read defensively rather than through the strict schema.
 */

/** Base64 nonce from 128 bits of CSPRNG entropy, fresh for every request. */
function createNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function isHttpsRequest(request: NextRequest) {
  if (request.nextUrl.protocol === "https:") return true;
  // Only consult the forwarded scheme when the deployment has declared that a
  // proxy sits in front; otherwise it is attacker-controlled.
  if ((process.env.TRUSTED_PROXY_MODE ?? "none") === "none") return false;
  return request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
}

function readHstsMaxAge() {
  const parsed = Number(process.env.SECURITY_HSTS_MAX_AGE_SECONDS ?? "31536000");
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 63_072_000) : 31_536_000;
}

export function proxy(request: NextRequest) {
  const correlationId = correlationIdFromHeaders(request.headers);
  const nonce = createNonce();
  const pathname = request.nextUrl.pathname;

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(CORRELATION_HEADER, correlationId);
  // Next.js reads the nonce from the request-side CSP header to stamp its own
  // inline bootstrap scripts, so it must be set here and not only on the response.
  requestHeaders.set("x-nonce", nonce);

  const securityHeadersEnabled = process.env.SECURITY_HEADERS_ENABLED !== "false";
  // Resolve the realtime origin the same hosted-aware way the seat pages do, so
  // a build that inlined a loopback NEXT_PUBLIC_REALTIME_URL never reaches the
  // policy on a hosted deployment. A hosted deployment with no real gateway
  // resolves to the polling fallback and contributes no connect-src origin.
  const realtime = resolveRealtimeEndpoint(process.env, {
    hosted: process.env.NODE_ENV === "production",
  });
  const headers = securityHeadersEnabled
    ? buildSecurityHeaders({
        nonce,
        isDevelopment: process.env.NODE_ENV === "development",
        isHttps: isHttpsRequest(request),
        hstsMaxAgeSeconds: readHstsMaxAge(),
        realtimeOrigin: realtime.mode === "socket" ? realtime.url : null,
      })
    : {};

  if (headers["Content-Security-Policy"]) {
    requestHeaders.set("Content-Security-Policy", headers["Content-Security-Policy"]);
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  for (const [name, value] of Object.entries(headers)) {
    response.headers.set(name, value);
  }
  // Echoing the correlation ID lets a customer or an operator quote one value
  // that ties a browser observation to the server-side log records.
  response.headers.set(CORRELATION_HEADER, correlationId);

  if (isSensitivePath(pathname)) {
    response.headers.set("Cache-Control", SENSITIVE_CACHE_CONTROL);
  }

  return response;
}

export const config = {
  /**
   * Skip Next.js internals and static assets. Everything else — pages, route
   * handlers, and the Server Function POSTs that target them — is covered.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
