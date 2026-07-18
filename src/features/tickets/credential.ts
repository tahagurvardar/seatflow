import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TICKET_CREDENTIAL_PREFIX = "SFT1";
export const TICKET_CREDENTIAL_ENTROPY_BITS = 256;
export const TICKET_REFERENCE_ENTROPY_BITS = 192;
export const TICKET_CREDENTIAL_MAX_LENGTH = 64;

const credentialPattern = /^SFT1\.[A-Za-z0-9_-]{43}$/;

export function generateTicketPublicReference() {
  return randomBytes(TICKET_REFERENCE_ENTROPY_BITS / 8).toString("base64url");
}

export function deriveTicketCredential(input: {
  ticketReference: string;
  version: number;
  secret: string;
}) {
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new Error("Ticket credential version must be a positive integer.");
  }
  if (!/^[A-Za-z0-9_-]{24,80}$/.test(input.ticketReference)) {
    throw new Error("Ticket reference is invalid.");
  }
  if (input.secret.length < 32) {
    throw new Error("Ticket credential secret is invalid.");
  }
  const opaque = createHmac("sha256", input.secret)
    .update(`seatflow:ticket-credential:v1:${input.ticketReference}:${input.version}`)
    .digest("base64url");
  return `${TICKET_CREDENTIAL_PREFIX}.${opaque}`;
}

export function parseTicketCredential(value: string) {
  if (value.length > TICKET_CREDENTIAL_MAX_LENGTH || !credentialPattern.test(value)) {
    return null;
  }
  return { version: 1 as const, credential: value };
}

export function hashTicketCredential(credential: string, secret: string) {
  if (!parseTicketCredential(credential)) {
    throw new Error("Ticket credential format is invalid.");
  }
  return createHmac("sha256", secret)
    .update(`seatflow:ticket-credential-hash:v1:${credential}`)
    .digest("hex");
}

export function compareTicketCredentialHash(expectedHex: string, actualHex: string) {
  if (!/^[a-f0-9]{64}$/.test(expectedHex) || !/^[a-f0-9]{64}$/.test(actualHex)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expectedHex, "hex"), Buffer.from(actualHex, "hex"));
}

export function generateDownloadGrantToken() {
  return randomBytes(32).toString("base64url");
}

export function deriveDownloadGrantToken(input: { idempotencySubject: string; secret: string }) {
  if (!/^[A-Za-z0-9:_-]{1,191}$/.test(input.idempotencySubject)) {
    throw new Error("Download grant idempotency subject is invalid.");
  }
  if (input.secret.length < 32) {
    throw new Error("Ticket credential secret is invalid.");
  }
  return createHmac("sha256", input.secret)
    .update(`seatflow:ticket-download-grant-token:v1:${input.idempotencySubject}`)
    .digest("base64url");
}

export function hashDownloadGrantToken(token: string, secret: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error("Download grant token format is invalid.");
  }
  return createHmac("sha256", secret)
    .update(`seatflow:ticket-download-grant:v1:${token}`)
    .digest("hex");
}
