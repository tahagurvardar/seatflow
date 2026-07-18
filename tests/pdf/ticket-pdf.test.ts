import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { deriveTicketCredential } from "@/features/tickets/credential";
import { safeTicketPdfFilename, type TicketPdfView } from "@/features/tickets/pdf";
import { renderBookingTicketPdf } from "@/server/tickets/pdf-service";

const secret = "phase-5b-pdf-secret-000000000000000000000000000";

function view(): TicketPdfView {
  return {
    bookingReference: "BOOKING_PUBLIC_REFERENCE_123456",
    eventTitle: "Aurora Room",
    startAt: new Date("2026-07-20T18:00:00.000Z"),
    timeZone: "Asia/Baku",
    venueName: "Harbor Hall",
    venueCity: "Baku",
    spaceName: "Main Stage",
    tickets: [
      {
        ticketReference: "TICKET_PUBLIC_REFERENCE_1234567",
        sectionName: "Orchestra",
        sectionCode: "ORCH",
        rowLabel: "A",
        seatLabel: "12",
        tierName: "Standard",
        status: "ACTIVE",
        credential: deriveTicketCredential({ ticketReference: "A".repeat(32), version: 1, secret }),
      },
    ],
  };
}

async function extractText(bytes: Uint8Array) {
  const document = await getDocument({ data: new Uint8Array(bytes) }).promise;
  const text: string[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    text.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
  }
  return { pages: document.numPages, text: text.join(" ") };
}

describe("ticket PDF renderer", () => {
  it("creates a valid PDF with event, session, seat, ticket reference, and QR image", async () => {
    const bytes = await renderBookingTicketPdf(view());
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe("%PDF-");
    const extracted = await extractText(bytes);
    expect(extracted.pages).toBe(1);
    expect(extracted.text).toContain("Aurora Room");
    expect(extracted.text).toContain("Harbor Hall");
    expect(extracted.text).toContain("Seat 12");
    expect(extracted.text).toContain("TICKET_PUBLIC_REFERENCE_1234567");
    expect(bytes.byteLength).toBeGreaterThan(10_000);
  });

  it("contains no payment secret, customer identity, or internal database id", async () => {
    const bytes = await renderBookingTicketPdf(view());
    const extracted = (await extractText(bytes)).text;
    expect(extracted).not.toContain("customer@example.com");
    expect(extracted).not.toContain("LOCAL_PAYMENT_WEBHOOK_SECRET");
    expect(extracted).not.toContain("ck_internal_database_id");
  });

  it("renders terminal status without regenerating credential material", async () => {
    const terminal = view();
    terminal.tickets[0] = { ...terminal.tickets[0]!, status: "REVOKED", credential: undefined };
    const extracted = await extractText(await renderBookingTicketPdf(terminal));
    expect(extracted.text).toContain("QR UNAVAILABLE");
    expect(extracted.text).toContain("This ticket is revoked.");
  });

  it("uses a safe attachment filename and rejects unbounded ticket counts", async () => {
    expect(safeTicketPdfFilename("Aurora / Room", "ABC_def-123456789")).toMatch(/^seatflow-[a-z0-9-]+-[A-Za-z0-9_-]+\.pdf$/);
    await expect(renderBookingTicketPdf({ ...view(), tickets: [] })).rejects.toThrow(/between one and eight/i);
  });
});
