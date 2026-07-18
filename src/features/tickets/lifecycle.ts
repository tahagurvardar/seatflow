import type { EventSessionStatus, TicketStatus } from "@/generated/prisma/enums";

export type EntryWindowOutcome = "OPEN" | "TOO_EARLY" | "TOO_LATE" | "SESSION_CANCELLED";

export function decideEntryWindow(input: {
  sessionStatus: EventSessionStatus;
  startAt: Date;
  endAt: Date;
  now: Date;
  earlyMinutes: number;
  lateMinutes: number;
}): EntryWindowOutcome {
  if (input.sessionStatus === "CANCELLED") return "SESSION_CANCELLED";
  const opensAt = input.startAt.getTime() - input.earlyMinutes * 60_000;
  const closesAt = input.endAt.getTime() + input.lateMinutes * 60_000;
  if (input.now.getTime() < opensAt) return "TOO_EARLY";
  if (input.now.getTime() > closesAt) return "TOO_LATE";
  return "OPEN";
}

export function canRotateTicket(status: TicketStatus) {
  return status === "ACTIVE";
}

export function ticketEntryLabel(status: TicketStatus) {
  if (status === "USED") return "Entry used";
  if (status === "REVOKED") return "Revoked";
  return "Ready for entry";
}

export function isDownloadGrantUsable(input: {
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  now: Date;
}) {
  return !input.usedAt && !input.revokedAt && input.expiresAt.getTime() > input.now.getTime();
}
