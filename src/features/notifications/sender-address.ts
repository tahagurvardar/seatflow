/**
 * Sender address parsing.
 *
 * A recipient address and a sender address are not the same kind of value, and
 * Phase 5C2A validated them as if they were. A recipient must be a bare
 * `local@domain` — anything else is a header-injection risk or a data fault.
 * A *sender*, however, is legitimately an RFC 5322 mailbox and normally carries
 * a display name: `SeatFlow <onboarding@resend.dev>`. Every real provider,
 * Resend included, accepts and expects that form.
 *
 * Rejecting it forced the sender identity to be a bare address, which is why a
 * perfectly valid configured `From` could not boot. This module accepts both
 * forms for senders while keeping the recipient rule exactly as strict as it
 * was: the display name is bounded, stripped of control characters, and never
 * allowed to contain the quoting or angle brackets that would let it terminate
 * a header early.
 *
 * Pure: no I/O, no environment access.
 */

/** The address half of a mailbox, held to the same grammar as a recipient. */
const BARE_ADDRESS_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/**
 * A display name may not contain anything that can restructure a header:
 * CR, LF, tab, angle brackets, double quotes, commas, or semicolons.
 */
const DISPLAY_NAME_PATTERN = /^[^\r\n\t<>",;]{1,64}$/;

const MAILBOX_PATTERN = /^\s*(.*?)\s*<([^<>]+)>\s*$/;

export interface SenderMailbox {
  /** Null for a bare address with no display name. */
  displayName: string | null;
  address: string;
}

export function isBareEmailAddress(value: string) {
  return (
    value.length <= 254 && !/[\r\n\t]/.test(value) && BARE_ADDRESS_PATTERN.test(value)
  );
}

/**
 * Parse a sender into its parts, or return null when it is not a form this
 * platform will transmit.
 *
 * Returning null rather than throwing lets the environment schema report a
 * field-level message while the provider constructor throws, which is the
 * contract each of those call sites already has.
 */
export function parseSenderAddress(value: string): SenderMailbox | null {
  if (value.length > 320 || /[\r\n\t]/.test(value)) return null;

  const mailbox = MAILBOX_PATTERN.exec(value);
  if (!mailbox) {
    return isBareEmailAddress(value) ? { displayName: null, address: value } : null;
  }

  const [, rawDisplayName, address] = mailbox;
  if (!isBareEmailAddress(address.trim())) return null;

  // `<addr@example.com>` with no display name is valid; a *present* display
  // name must satisfy the grammar. Surrounding quotes are a legal RFC 5322
  // encoding, so they are unwrapped before the check rather than rejected.
  const unquoted = rawDisplayName.replace(/^"(.*)"$/, "$1").trim();
  if (unquoted.length === 0) return { displayName: null, address: address.trim() };
  if (!DISPLAY_NAME_PATTERN.test(unquoted)) return null;

  return { displayName: unquoted, address: address.trim() };
}

/** Throws with the platform's permanent-failure code, matching recipients. */
export function assertSafeSenderAddress(value: string) {
  const parsed = parseSenderAddress(value);
  if (!parsed) throw new Error("PERMANENT_INVALID_SENDER");
  return value;
}

/** The bare address a sender resolves to, for logging and comparison. */
export function senderEmailAddress(value: string) {
  return parseSenderAddress(value)?.address ?? null;
}
