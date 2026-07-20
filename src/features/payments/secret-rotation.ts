/**
 * Webhook secret rotation.
 *
 * Rotating a webhook secret without dropping in-flight deliveries needs a
 * window in which both the new and the previous secret verify. The danger is
 * that the window never closes and a leaked old secret stays valid forever, so
 * the previous secret here is only accepted until an explicit expiry that the
 * deployment must state. There is no "accept any previous secret" mode.
 *
 * Pure: no `process.env`, no clock, no I/O. The caller supplies both.
 */

export interface WebhookSecretWindow {
  current: string;
  previous?: string | null;
  /** When the previous secret stops being accepted. Required if previous is set. */
  previousExpiresAt?: Date | null;
}

export type SecretWindowValidation =
  | { valid: true; acceptsPrevious: boolean }
  | { valid: false; reason: SecretWindowProblem };

export type SecretWindowProblem =
  | "CURRENT_SECRET_MISSING"
  | "CURRENT_SECRET_TOO_SHORT"
  | "PREVIOUS_SECRET_TOO_SHORT"
  | "PREVIOUS_EXPIRY_MISSING"
  | "PREVIOUS_EQUALS_CURRENT"
  | "PREVIOUS_WINDOW_TOO_LONG";

/** A rotation window longer than this is treated as a configuration mistake. */
export const MAXIMUM_PREVIOUS_SECRET_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

const MINIMUM_SECRET_LENGTH = 32;

export function validateSecretWindow(
  window: WebhookSecretWindow,
  now: Date,
): SecretWindowValidation {
  if (!window.current) return { valid: false, reason: "CURRENT_SECRET_MISSING" };
  if (window.current.length < MINIMUM_SECRET_LENGTH) {
    return { valid: false, reason: "CURRENT_SECRET_TOO_SHORT" };
  }

  if (!window.previous) return { valid: true, acceptsPrevious: false };

  if (window.previous.length < MINIMUM_SECRET_LENGTH) {
    return { valid: false, reason: "PREVIOUS_SECRET_TOO_SHORT" };
  }
  if (window.previous === window.current) {
    return { valid: false, reason: "PREVIOUS_EQUALS_CURRENT" };
  }
  if (!window.previousExpiresAt) {
    return { valid: false, reason: "PREVIOUS_EXPIRY_MISSING" };
  }
  if (
    window.previousExpiresAt.getTime() - now.getTime() >
    MAXIMUM_PREVIOUS_SECRET_WINDOW_MS
  ) {
    return { valid: false, reason: "PREVIOUS_WINDOW_TOO_LONG" };
  }

  return { valid: true, acceptsPrevious: window.previousExpiresAt.getTime() > now.getTime() };
}

/**
 * The secrets a verifier may try right now, newest first. An expired previous
 * secret simply is not returned, which is what makes the window close by itself
 * rather than by someone remembering to remove a variable.
 */
export function activeSecretsForVerification(
  window: WebhookSecretWindow,
  now: Date,
): string[] {
  const validation = validateSecretWindow(window, now);
  if (!validation.valid) return [];
  if (!validation.acceptsPrevious || !window.previous) return [window.current];
  return [window.current, window.previous];
}

/** True once the previous secret is no longer accepted anywhere. */
export function isRotationComplete(window: WebhookSecretWindow, now: Date) {
  if (!window.previous) return true;
  if (!window.previousExpiresAt) return false;
  return window.previousExpiresAt.getTime() <= now.getTime();
}
