export interface TicketPdfView {
  bookingReference: string;
  eventTitle: string;
  startAt: Date;
  timeZone: string;
  venueName: string;
  venueCity: string;
  spaceName: string;
  tickets: Array<{
    ticketReference: string;
    sectionName: string;
    sectionCode: string;
    rowLabel: string;
    seatLabel: string;
    tierName: string;
    status: "ACTIVE" | "REVOKED" | "USED";
    credential?: string;
  }>;
}

export function safeTicketPdfFilename(eventTitle: string, bookingReference: string) {
  const title = eventTitle
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .toLowerCase() || "event";
  const reference = bookingReference.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12);
  return `seatflow-${title}-${reference}.pdf`;
}

export function assertTicketPdfViewIsBounded(view: TicketPdfView) {
  if (view.tickets.length < 1 || view.tickets.length > 8) {
    throw new Error("Ticket PDF must contain between one and eight tickets.");
  }
  const values = [view.eventTitle, view.venueName, view.venueCity, view.spaceName];
  if (values.some((value) => value.length > 200)) {
    throw new Error("Ticket PDF content exceeds its safe bound.");
  }
  return view;
}
