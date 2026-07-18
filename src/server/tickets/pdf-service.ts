import QRCode from "qrcode";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import { assertTicketPdfViewIsBounded, type TicketPdfView } from "@/features/tickets/pdf";

function fitText(value: string, maximum = 72) {
  const normalized = value.replace(/[\r\n\t]+/g, " ").trim();
  return normalized.length > maximum ? `${normalized.slice(0, maximum - 1)}…` : normalized;
}

function sessionLabel(startAt: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone,
  }).format(startAt);
}

export async function renderBookingTicketPdf(viewInput: TicketPdfView) {
  const view = assertTicketPdfViewIsBounded(viewInput);
  const document = await PDFDocument.create();
  document.setTitle(`${fitText(view.eventTitle)} tickets`);
  document.setAuthor("SeatFlow");
  document.setCreator("SeatFlow secure ticket renderer");
  document.setProducer("SeatFlow");
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);

  for (const ticket of view.tickets) {
    const page = document.addPage([420, 720]);
    const { width, height } = page.getSize();
    page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(0.973, 0.98, 0.988) });
    page.drawRectangle({ x: 0, y: height - 154, width, height: 154, color: rgb(0.008, 0.024, 0.09) });
    page.drawText("SEATFLOW", { x: 30, y: height - 42, font: bold, size: 12, color: rgb(0.204, 0.827, 0.6) });
    page.drawText(fitText(view.eventTitle, 48), { x: 30, y: height - 78, font: bold, size: 22, color: rgb(1, 1, 1) });
    page.drawText(fitText(sessionLabel(view.startAt, view.timeZone), 58), { x: 30, y: height - 108, font: regular, size: 10, color: rgb(0.8, 0.835, 0.89) });
    page.drawText(fitText(`${view.venueName} · ${view.spaceName} · ${view.venueCity}`, 64), { x: 30, y: height - 128, font: regular, size: 10, color: rgb(0.65, 0.7, 0.78) });

    page.drawText("YOUR SEAT", { x: 30, y: height - 195, font: bold, size: 9, color: rgb(0.25, 0.32, 0.42) });
    page.drawText(fitText(`${ticket.sectionName} · Row ${ticket.rowLabel} · Seat ${ticket.seatLabel}`, 52), { x: 30, y: height - 225, font: bold, size: 18, color: rgb(0.008, 0.024, 0.09) });
    page.drawText(fitText(ticket.tierName, 50), { x: 30, y: height - 247, font: regular, size: 10, color: rgb(0.29, 0.36, 0.46) });

    page.drawRectangle({ x: 79, y: 220, width: 262, height: 262, color: rgb(1, 1, 1), borderColor: rgb(0.88, 0.9, 0.93), borderWidth: 1 });
    if (ticket.credential) {
      const qrPng = await QRCode.toBuffer(ticket.credential, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 512,
        type: "png",
        color: { dark: "#020617", light: "#ffffff" },
      });
      const qr = await document.embedPng(qrPng);
      page.drawImage(qr, { x: 89, y: 230, width: 242, height: 242 });
    } else {
      page.drawText("QR UNAVAILABLE", { x: 132, y: 360, font: bold, size: 18, color: rgb(0.55, 0.12, 0.12) });
      page.drawText(`This ticket is ${ticket.status.toLowerCase()}.`, { x: 139, y: 330, font: regular, size: 11, color: rgb(0.42, 0.18, 0.18) });
    }

    page.drawText(`Ticket ${fitText(ticket.ticketReference, 80)}`, { x: 30, y: 180, font: bold, size: 11, color: rgb(0.008, 0.024, 0.09) });
    page.drawText(`Status: ${ticket.status}`, { x: 30, y: 159, font: regular, size: 10, color: rgb(0.25, 0.32, 0.42) });
    page.drawLine({ start: { x: 30, y: 135 }, end: { x: width - 30, y: 135 }, thickness: 1, color: rgb(0.88, 0.9, 0.93) });
    page.drawText("Present this QR at entry. Network validation is authoritative.", { x: 30, y: 108, font: regular, size: 9, color: rgb(0.29, 0.36, 0.46) });
    page.drawText("Do not share this ticket. A replaced, revoked, or used credential is rejected.", { x: 30, y: 91, font: regular, size: 8, color: rgb(0.42, 0.47, 0.55) });
    page.drawText(`Page ${document.getPageCount()} of ${view.tickets.length}`, { x: width - 90, y: 34, font: regular, size: 8, color: rgb(0.5, 0.55, 0.62) });
  }
  return document.save({ useObjectStreams: false });
}
