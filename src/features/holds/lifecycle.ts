import type { SeatHoldStatus } from "@/generated/prisma/enums";

interface HoldExpiryInput {
  status: SeatHoldStatus;
  expiresAt: Date;
  now?: Date;
}

/**
 * Server-authoritative expiry decision. The client countdown is informational
 * only; a hold is expired when its status is still ACTIVE but server time has
 * reached its expiry. Already-terminal holds are never "expired" again here.
 */
export function isHoldExpired({ status, expiresAt, now = new Date() }: HoldExpiryInput) {
  return status === "ACTIVE" && now >= expiresAt;
}

/** A hold is live only while ACTIVE and strictly before its expiry. */
export function isHoldLive({ status, expiresAt, now = new Date() }: HoldExpiryInput) {
  return status === "ACTIVE" && now < expiresAt;
}

/** Only the ACTIVE hold owner may release; terminal holds release idempotently. */
export function canReleaseHold(status: SeatHoldStatus) {
  return status === "ACTIVE";
}

export function isTerminalHoldStatus(status: SeatHoldStatus) {
  return status === "RELEASED" || status === "EXPIRED" || status === "CONVERTED";
}

/** Whole seconds remaining before expiry, clamped at zero. Presentation only. */
export function holdSecondsRemaining({ status, expiresAt, now = new Date() }: HoldExpiryInput) {
  if (status !== "ACTIVE") return 0;
  return Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
}
