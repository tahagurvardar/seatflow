import "server-only";

import { Receiver } from "@upstash/qstash";

import type { ServerlessJobEnvironment } from "@/env/schema";

/**
 * QStash delivery verification.
 *
 * The internal job endpoints trigger inventory sweeps, ticket issuance, and
 * refund reconciliation. Unsigned, they would be an unauthenticated remote
 * trigger for that work, so verification is not optional and there is no
 * configuration in which it can be skipped.
 *
 * Verification uses the official `@upstash/qstash` `Receiver`, which checks the
 * signature JWT against the current signing key and, failing that, the next
 * one. Supporting both is what makes key rotation possible without a window in
 * which every delivery is rejected.
 *
 * What is deliberately *not* done here:
 *  - the signature header is never logged, echoed, or included in an error
 *  - the raw body is never logged (it is verified as exact bytes, then parsed)
 *  - a verification failure returns a fixed reason, never the library message,
 *    so a caller cannot probe key state by reading error text
 */

export type SignatureVerdict =
  | { verified: true; usedKey: "current" | "next" }
  | { verified: false; reason: "MISSING" | "INVALID" };

/** The header QStash signs its deliveries with. */
export const QSTASH_SIGNATURE_HEADER = "upstash-signature";
/** Stable per message across retries — the basis of duplicate detection. */
export const QSTASH_MESSAGE_ID_HEADER = "upstash-message-id";
/** How many times QStash has already tried to deliver this message. */
export const QSTASH_RETRY_HEADER = "upstash-retried";

export interface QStashVerifierOptions {
  currentSigningKey: string;
  nextSigningKey: string;
  clockToleranceSeconds: number;
}

/**
 * Verify a signature against the current key, then the next.
 *
 * The `Receiver` already falls back internally, but doing it explicitly lets
 * the caller record *which* key verified. That matters during a rotation: if
 * every delivery is suddenly verifying on the next key, the current key has
 * already been retired at the provider and the environment is behind.
 */
export async function verifyQStashSignature(
  input: { signature: string | null; body: string; url?: string },
  options: QStashVerifierOptions,
): Promise<SignatureVerdict> {
  if (!input.signature) return { verified: false, reason: "MISSING" };

  const attempt = async (key: string, label: "current" | "next") => {
    const receiver = new Receiver({
      currentSigningKey: key,
      // Passing the same key twice would let the library's own fallback
      // silently accept it, which would defeat the point of reporting which
      // key matched.
      nextSigningKey: key,
    });
    try {
      const verified = await receiver.verify({
        signature: input.signature!,
        body: input.body,
        clockTolerance: options.clockToleranceSeconds,
        ...(input.url ? { url: input.url } : {}),
      });
      return verified ? label : null;
    } catch {
      // The library throws SignatureError for a bad signature. That is an
      // expected outcome here, not an exception worth propagating, and its
      // message is never surfaced.
      return null;
    }
  };

  const current = await attempt(options.currentSigningKey, "current");
  if (current) return { verified: true, usedKey: current };

  const next = await attempt(options.nextSigningKey, "next");
  if (next) return { verified: true, usedKey: next };

  return { verified: false, reason: "INVALID" };
}

export function createQStashVerifierOptions(
  environment: ServerlessJobEnvironment,
): QStashVerifierOptions | null {
  if (!environment.QSTASH_CURRENT_SIGNING_KEY || !environment.QSTASH_NEXT_SIGNING_KEY) {
    return null;
  }
  return {
    currentSigningKey: environment.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: environment.QSTASH_NEXT_SIGNING_KEY,
    clockToleranceSeconds: environment.JOB_CLOCK_TOLERANCE_SECONDS,
  };
}

/**
 * Reduce a scheduler-supplied message id to the stored grammar.
 *
 * The id reaches this platform as an untrusted header and is written to a
 * database column with a CHECK constraint on its shape, so it is normalized
 * here rather than trusted. An id that cannot be normalized yields null, and
 * the caller treats the delivery as un-deduplicable rather than inventing one.
 */
export function normalizeMessageId(value: string | null | undefined) {
  if (!value) return null;
  const cleaned = value.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 128);
  return cleaned.length > 0 ? cleaned : null;
}

/** Retry counter from the delivery headers, clamped to something sane. */
export function normalizeRetryCount(value: string | null | undefined) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(Math.round(parsed), 1_000);
}
