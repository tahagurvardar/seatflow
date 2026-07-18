import type { NotificationType } from "@/generated/prisma/enums";
import { assertSafeEmailAddress, type NotificationMessage } from "@/server/notifications/notification-provider";

export interface TicketNotificationView {
  type: NotificationType;
  recipientEmail: string;
  eventTitle: string;
  sessionLabel: string;
  venueName: string;
  seats: Array<{ sectionName: string; rowLabel: string; seatLabel: string }>;
  retrievalUrl: string;
  idempotencyKey: string;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

export function createSafeTicketEmail(view: TicketNotificationView): NotificationMessage {
  const recipient = assertSafeEmailAddress(view.recipientEmail);
  const title = view.type === "BOOKING_TICKETS_READY"
    ? "Your SeatFlow tickets are ready"
    : view.type === "CREDENTIAL_ROTATED"
      ? "Your SeatFlow ticket credential changed"
      : "A SeatFlow ticket was revoked";
  const seats = view.seats
    .slice(0, 8)
    .map((seat) => `${seat.sectionName}, row ${seat.rowLabel}, seat ${seat.seatLabel}`);
  const text = [
    title,
    view.eventTitle,
    view.sessionLabel,
    view.venueName,
    ...seats,
    "Sign in to retrieve the current ticket PDF using this short-lived link:",
    view.retrievalUrl,
    "The email does not contain a QR credential.",
  ].join("\n");
  const htmlSeats = seats.map((seat) => `<li>${escapeHtml(seat)}</li>`).join("");
  const html = `<h1>${escapeHtml(title)}</h1><p><strong>${escapeHtml(view.eventTitle)}</strong></p><p>${escapeHtml(view.sessionLabel)}<br>${escapeHtml(view.venueName)}</p><ul>${htmlSeats}</ul><p><a href="${escapeHtml(view.retrievalUrl)}">Sign in and retrieve tickets</a></p><p>This short-lived link is bound to your SeatFlow account. No QR credential is included in this email.</p>`;
  return { to: recipient, subject: title, text, html, idempotencyKey: view.idempotencyKey };
}
