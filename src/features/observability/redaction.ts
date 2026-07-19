/**
 * Deterministic redaction rules shared by every SeatFlow log record.
 *
 * Phase 5C1 logs use an allow-list discipline: a caller may only attach bounded
 * primitive metadata under a non-sensitive key, and every free-text value is
 * scrubbed for credential-shaped material before it reaches a transport. This
 * module is intentionally pure so the rules are unit testable without a logger.
 */

export const MAX_LOG_STRING_LENGTH = 256;
export const MAX_LOG_MESSAGE_LENGTH = 512;
export const MAX_LOG_METADATA_KEYS = 24;
export const REDACTED = "[redacted]";

/**
 * Key fragments that must never carry a value into a log record. The candidate
 * key is normalized to lowercase alphanumerics first, so `apiKey`, `api_key`,
 * and `API-KEY` all collapse to the same comparison.
 */
const FORBIDDEN_KEY_FRAGMENTS = [
  "secret",
  "password",
  "passwd",
  "credential",
  "signature",
  "cookie",
  "authorization",
  "apikey",
  "accesskey",
  "privatekey",
  "bearer",
  "token",
  "hash",
  "salt",
  "dsn",
  "connectionstring",
  "databaseurl",
  "redisurl",
  "payload",
  "rawbody",
  "requestbody",
  "stack",
  "stacktrace",
  "email",
  "cardnumber",
  "cvv",
  "iban",
  "pan",
] as const;

const SAFE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

export function normalizeMetadataKey(key: string) {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/** A metadata key is usable only when it is short, plain, and non-sensitive. */
export function isForbiddenMetadataKey(key: string) {
  if (!SAFE_KEY_PATTERN.test(key)) return true;
  const normalized = normalizeMetadataKey(key);
  return FORBIDDEN_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/**
 * Scrub credential-shaped substrings out of free text. This runs on every
 * message and every string metadata value, so a message assembled from an
 * upstream error or provider response cannot smuggle a secret into a log.
 */
export function redactSensitiveText(value: string) {
  return (
    value
      // Connection strings first: they embed credentials in the authority part.
      .replace(/postgres(ql)?:\/\/\S+/gi, "[database endpoint redacted]")
      .replace(/redis(s)?:\/\/\S+/gi, "[redis endpoint redacted]")
      .replace(/mongodb(\+srv)?:\/\/\S+/gi, "[database endpoint redacted]")
      // Any URL carrying inline user:password credentials.
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@\S+/gi, "[credentialed url redacted]")
      // Ticket QR credentials and provider webhook signature grammar.
      .replace(/SFT1\.[A-Za-z0-9_-]+/g, "[ticket credential redacted]")
      .replace(/\bt=\d+,\s*v1=[A-Fa-f0-9]+/g, "[webhook signature redacted]")
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
      // JSON Web Tokens.
      .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, "[jwt redacted]")
      // Email addresses embedded in free text. Blocking the `email` metadata
      // key is not enough: an address quoted inside a message or a note would
      // otherwise reach the log. Callers that genuinely need the domain must
      // use `redactEmailAddress` and store the result under a non-email key.
      .replace(
        /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g,
        "[email redacted]",
      )
      // Stored keyed hashes are 64 hex characters; any long hex run is suspect.
      .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[hash redacted]")
      // Download-grant, hold, and credential tokens are >=43 base64url chars.
      // Ticket public references are 32 characters and stay readable on purpose.
      .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[token redacted]")
      .replace(/[\r\n\t]+/g, " ")
  );
}

export function boundString(value: string, maximumLength = MAX_LOG_STRING_LENGTH) {
  const collapsed = value.replace(/[\r\n\t]+/g, " ");
  return collapsed.length > maximumLength
    ? `${collapsed.slice(0, maximumLength - 1)}…`
    : collapsed;
}

/** Scrub then bound. Used for both messages and string metadata values. */
export function safeText(value: string, maximumLength = MAX_LOG_STRING_LENGTH) {
  return boundString(redactSensitiveText(value), maximumLength);
}

/**
 * Deliberate email redaction. The local part is removed entirely; the domain is
 * retained because it is operationally useful when triaging delivery failures
 * and is not personally identifying on its own.
 */
export function redactEmailAddress(value: string) {
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return REDACTED;
  const domain = value.slice(at + 1);
  if (!/^[A-Za-z0-9.-]{1,190}$/.test(domain)) return REDACTED;
  return `***@${boundString(domain, 64)}`;
}

export type SafeMetadataValue = string | number | boolean | null;
export type SafeMetadata = Record<string, SafeMetadataValue>;

/**
 * Reduce caller-supplied metadata to bounded primitives under allowed keys.
 * Objects, arrays, functions, symbols, and bigints are dropped rather than
 * serialized, which is what keeps a Prisma error or provider response from
 * being flattened into a log record wholesale.
 */
export function sanitizeMetadata(
  metadata: Record<string, unknown> | undefined,
): SafeMetadata | undefined {
  if (!metadata) return undefined;
  const result: SafeMetadata = {};
  let count = 0;

  for (const [key, value] of Object.entries(metadata)) {
    if (count >= MAX_LOG_METADATA_KEYS) break;
    if (isForbiddenMetadataKey(key)) continue;

    if (typeof value === "string") {
      result[key] = safeText(value);
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
      result[key] = value;
    } else if (typeof value === "boolean" || value === null) {
      result[key] = value;
    } else {
      continue;
    }
    count += 1;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
