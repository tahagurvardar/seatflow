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

/**
 * Customer-facing explanation of a revoked ticket.
 *
 * Only system-issued reason codes are translated. Any other value is free text
 * entered by an operator and may contain internal notes, so it is never shown
 * to the customer; a neutral explanation is used instead.
 */
export function ticketRevocationMessage(reason: string | null) {
  switch (reason) {
    case "REFUNDED":
      return "This ticket was cancelled because it was refunded. It can no longer be used for entry.";
    case "DISPUTE_OPENED":
      return "This ticket is on hold while a payment dispute is reviewed. It cannot be used for entry right now.";
    case "DISPUTE_LOST":
      return "This ticket was cancelled after a payment dispute. It can no longer be used for entry.";
    default:
      return "This ticket was cancelled and can no longer be used for entry. Contact the event organizer if you have questions.";
  }
}

export type TicketPdfAvailability =
  | { available: true }
  | { available: false; message: string };

/**
 * Whether the booking PDF action should be offered.
 *
 * Mirrors the server rule, which issues a PDF grant only for a CONFIRMED booking,
 * so the customer is never offered an action that is certain to fail. A ticket
 * page for a cancelled ticket does not offer it either: the PDF could not admit
 * that ticket.
 */
export function ticketPdfAvailability(input: {
  bookingStatus: "CONFIRMED" | "REFUNDED";
  ticketStatuses: readonly TicketStatus[];
  /** Set on a single-ticket page: the ticket the customer is looking at. */
  viewedTicketStatus?: TicketStatus;
}): TicketPdfAvailability {
  if (input.bookingStatus === "REFUNDED") {
    return {
      available: false,
      message: "Ticket PDFs are no longer available because this booking was refunded.",
    };
  }
  if (input.viewedTicketStatus === "REVOKED") {
    return {
      available: false,
      message: "This ticket was cancelled, so it is not included as a valid ticket in a download.",
    };
  }
  if (input.ticketStatuses.length > 0 && input.ticketStatuses.every((status) => status === "REVOKED")) {
    return {
      available: false,
      message: "No ticket in this booking can be used for entry, so there is no ticket PDF to download.",
    };
  }
  return { available: true };
}
