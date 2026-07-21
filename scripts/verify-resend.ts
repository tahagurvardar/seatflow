import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import dotenv from "dotenv";

import { parseSenderAddress } from "../src/features/notifications/sender-address";
import { ResendNotificationProvider } from "../src/server/notifications/resend-provider";

/**
 * `npm run staging:verify:email -- [--yes]`
 *
 * Sends exactly one clearly-marked test message to `RESEND_TEST_RECIPIENT` and
 * nowhere else.
 *
 * This is a **manual** command. It is deliberately not wired into the build,
 * the deployment, any test suite, or any scheduled job: a network call that
 * spends someone's free-tier quota and puts mail in a real inbox must be an
 * explicit human decision every time.
 *
 * Safety properties
 * -----------------
 *   - the recipient is read from RESEND_TEST_RECIPIENT and cannot be overridden
 *     by an argument
 *   - the adapter runs in test mode, so its own redirect applies as a second
 *     independent guard
 *   - the API key is never printed, and neither is the provider's raw response
 *   - the message body carries no credential, no ticket reference, and no URL
 *     into this platform
 */

const STAGING_ENV_FILE = ".env.staging.local";

const args = process.argv.slice(2);
const assumeYes = args.includes("--yes");

const envPath = resolve(process.cwd(), STAGING_ENV_FILE);
if (!existsSync(envPath)) {
  console.error(`${STAGING_ENV_FILE} does not exist. Create it from .env.staging.example first.`);
  process.exit(1);
}

const parsed = dotenv.parse(readFileSync(envPath));

const missing = ["RESEND_API_KEY", "RESEND_FROM_ADDRESS", "RESEND_TEST_RECIPIENT"].filter(
  (name) => !parsed[name],
);
if (missing.length > 0) {
  console.error(`Missing required variable(s): ${missing.join(", ")}.`);
  process.exit(1);
}

const recipient = parsed.RESEND_TEST_RECIPIENT!;
const fromAddress = parsed.RESEND_FROM_ADDRESS!;

if (!parseSenderAddress(fromAddress)) {
  console.error("RESEND_FROM_ADDRESS is not a valid sender mailbox.");
  process.exit(1);
}
if (parsed.RESEND_MODE === "live") {
  console.error("RESEND_MODE is 'live'. This command only runs against test mode.");
  process.exit(1);
}

/** Show enough of an address to confirm it, never the whole thing. */
function maskAddress(value: string) {
  const [local, domain] = value.split("@");
  if (!domain) return "[unparseable address]";
  const visible = local.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(local.length - 2, 1))}@${domain}`;
}

async function confirm(question: string) {
  if (assumeYes) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

console.log("SeatFlow staging email verification");
console.log(`Recipient: ${maskAddress(recipient)} (the approved test recipient)`);
console.log(`Sender:    ${maskAddress(parseSenderAddress(fromAddress)!.address)}`);
console.log("");
console.log("This sends one real email through Resend and consumes free-tier quota.");
console.log("");

if (!(await confirm('Type "yes" to send the test message: '))) {
  console.log("Aborted. No message was sent.");
  process.exit(0);
}

const stamp = new Date().toISOString();
const provider = new ResendNotificationProvider({
  apiKey: parsed.RESEND_API_KEY!,
  fromAddress,
  mode: "test",
  testRecipient: recipient,
  requestTimeoutMs: Number(parsed.RESEND_REQUEST_TIMEOUT_MS ?? 15_000),
});

const result = await provider.send({
  to: recipient,
  subject: "SeatFlow staging test message",
  text: [
    "This is an automated test message from a SeatFlow staging environment.",
    "",
    "It confirms that the Resend adapter is configured and can deliver mail.",
    "It is not a booking, a ticket, or a receipt, and no action is required.",
    "",
    `Sent at: ${stamp}`,
  ].join("\n"),
  html: [
    "<p>This is an automated test message from a SeatFlow <strong>staging</strong> environment.</p>",
    "<p>It confirms that the Resend adapter is configured and can deliver mail. ",
    "It is not a booking, a ticket, or a receipt, and no action is required.</p>",
    `<p style="color:#666">Sent at: ${stamp}</p>`,
  ].join(""),
  // Stable per minute, so an accidental double-run inside the same minute is
  // deduplicated by Resend rather than producing two messages.
  idempotencyKey: `seatflow-staging-verification:${stamp.slice(0, 16)}`,
});

console.log("");
if (result.status === "SUCCEEDED") {
  console.log("Delivery accepted by Resend.");
  // A bounded prefix is enough to correlate with the Resend dashboard without
  // reproducing the full provider identifier in a terminal or a log.
  console.log(`Provider message id (truncated): ${result.providerMessageId.slice(0, 8)}…`);
  console.log("");
  console.log(`Check the inbox for ${maskAddress(recipient)}.`);
} else {
  // The safe error code only. The provider's message can quote the recipient
  // address and the request payload.
  console.error(`Delivery failed: ${result.status} (${result.safeErrorCode})`);
  process.exitCode = 1;
}
