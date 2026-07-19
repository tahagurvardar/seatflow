import { createHmac } from "node:crypto";

import type { RateLimitPolicy } from "@/features/security/rate-limit-policy";

/**
 * Privacy-preserving identifiers for abuse control.
 *
 * Rate-limit keys must not contain a raw IP address, email, session token, hold
 * token, or ticket credential. Every subject is therefore reduced to a keyed
 * HMAC before it reaches Redis or a log field, which keeps counters functional
 * while making the stored key useless to anyone reading the key space.
 *
 * The derivation is domain-separated from every other use of the signing secret
 * by a fixed label, so a rate-limit key can never collide with, or be replayed
 * as, a Better Auth value or an inventory room ticket.
 */

const DERIVATION_LABEL = "seatflow:rate-limit-subject:v1";
const CLIENT_KEY_LENGTH = 32;

export function deriveClientKey(input: {
  value: string;
  dimension: "ip" | "subject" | "global";
  environment: string;
  secret: string;
}) {
  if (input.secret.length < 32) {
    throw new Error("Rate-limit key secret is invalid.");
  }
  return createHmac("sha256", input.secret)
    .update(`${DERIVATION_LABEL}:${input.environment}:${input.dimension}:${input.value}`)
    .digest("hex")
    .slice(0, CLIENT_KEY_LENGTH);
}

export interface RateLimitSubjectInput {
  policy: RateLimitPolicy;
  /** Authenticated user ID, when the request has one. */
  subjectId?: string | null;
  /** Resolved client address, already validated by the trusted-proxy policy. */
  address?: string | null;
  environment: string;
  secret: string;
}

/**
 * Build the hashed subject fragment for a policy, or null when the policy needs
 * an identifier the request cannot supply. A null subject means the caller must
 * treat the request as unattributable and apply the policy's failure mode
 * instead of inventing a shared bucket, which would let one abuser exhaust the
 * limit for everybody.
 */
export function buildRateLimitSubject(input: RateLimitSubjectInput): string | null {
  const { policy, environment, secret } = input;
  const subjectId = input.subjectId || null;
  const address = input.address || null;

  const hash = (value: string, dimension: "ip" | "subject" | "global") =>
    deriveClientKey({ value, dimension, environment, secret });

  switch (policy.scope) {
    case "global":
      return hash(policy.name, "global");
    case "ip":
      return address ? hash(address, "ip") : null;
    case "subject":
      return subjectId ? hash(subjectId, "subject") : null;
    case "subject_and_ip": {
      if (!subjectId && !address) return null;
      // Either dimension alone is still a useful bucket; combine when both are
      // present so a limit cannot be evaded by rotating just one of them.
      const parts = [
        subjectId ? hash(subjectId, "subject") : "anon",
        address ? hash(address, "ip") : "noaddr",
      ];
      return parts.join(".");
    }
  }
}

const KEY_SEGMENT_PATTERN = /^[a-z0-9._-]{1,96}$/i;
/** The environment prefix is namespaced with colons, e.g. `seatflow:production`. */
const KEY_PREFIX_PATTERN = /^[a-z0-9:._-]{1,96}$/i;

/**
 * Compose the final Redis key. Every segment is validated so a caller cannot
 * inject a separator, wildcard, or newline and reach another namespace.
 */
export function buildRateLimitKey(input: {
  prefix: string;
  policyName: string;
  subject: string;
}) {
  const policySegment = input.policyName.replace(/[^a-z0-9._-]/gi, "");
  if (!KEY_PREFIX_PATTERN.test(input.prefix)) {
    throw new Error("Rate-limit key prefix is invalid.");
  }
  if (!KEY_SEGMENT_PATTERN.test(policySegment) || !KEY_SEGMENT_PATTERN.test(input.subject)) {
    throw new Error("Rate-limit key segment is invalid.");
  }
  return `${input.prefix}:ratelimit:${policySegment}:${input.subject}`;
}
