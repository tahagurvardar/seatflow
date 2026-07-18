import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ScannerPanel } from "@/components/tickets/scanner-panel";
import { TicketSummaryCard } from "@/components/tickets/ticket-summary-card";
import type { CustomerTicketView } from "@/server/tickets/ticket-queries";

function ticket(status: CustomerTicketView["status"]): CustomerTicketView {
  return {
    publicReference: "A".repeat(32),
    bookingReference: "B".repeat(32),
    status,
    issuedAt: "2026-07-18T10:00:00.000Z",
    revokedAt: status === "REVOKED" ? "2026-07-18T11:00:00.000Z" : null,
    revocationReason: status === "REVOKED" ? "COMPROMISED" : null,
    credentialAvailable: status === "ACTIVE",
    event: { title: "Aurora Room", publicSlug: "seatflow--aurora-room" },
    session: {
      id: "session-safe",
      startAt: "2026-07-20T18:00:00.000Z",
      endAt: "2026-07-20T20:00:00.000Z",
      timeZone: "Asia/Baku",
      venueName: "Harbor Hall",
      spaceName: "Main",
      city: "Baku",
    },
    seat: { seatLabel: "12", rowLabel: "A", sectionName: "Orchestra", sectionCode: "ORCH", tierName: "Standard" },
  };
}

describe("Phase 5B customer ticket components", () => {
  it.each([
    ["ACTIVE", "Ready for entry"],
    ["USED", "Entry used"],
    ["REVOKED", "Revoked"],
  ] as const)("renders the %s ticket state accurately", (status, label) => {
    render(<TicketSummaryCard ticket={ticket(status)} />);
    expect(screen.getByText(status)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(label))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View ticket" })).toHaveAttribute("href", `/customer/tickets/${"A".repeat(32)}`);
  });
});

describe("Phase 5B scanner", () => {
  it("keeps the manual fallback usable when camera detection is unavailable", () => {
    render(<ScannerPanel sessionId="session-safe" />);
    fireEvent.click(screen.getByRole("button", { name: "Start camera" }));
    expect(screen.getByText(/camera qr detection is unavailable/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/manual credential fallback/i)).toBeEnabled();
  });

  it("shows an accepted result returned by authoritative validation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ outcome: "ACCEPTED", accepted: true, ticket: { reference: "T".repeat(32), eventTitle: "Aurora Room", venueName: "Hall", sectionName: "Main", rowLabel: "A", seatLabel: "1" } }),
    }));
    render(<ScannerPanel sessionId="session-safe" />);
    fireEvent.change(screen.getByLabelText(/manual credential fallback/i), { target: { value: `SFT1.${"A".repeat(43)}` } });
    fireEvent.click(screen.getByRole("button", { name: "Validate with SeatFlow" }));
    await waitFor(() => expect(screen.getByText("ACCEPTED")).toBeInTheDocument());
    expect(screen.getByText(/row a · seat 1/i)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("renders already-used and rejected states without claiming offline acceptance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ outcome: "ALREADY_USED", accepted: false }) }));
    render(<ScannerPanel sessionId="session-safe" />);
    fireEvent.change(screen.getByLabelText(/manual credential fallback/i), { target: { value: `SFT1.${"B".repeat(43)}` } });
    fireEvent.submit(screen.getByLabelText(/manual credential fallback/i).closest("form")!);
    await waitFor(() => expect(screen.getByText("ALREADY USED")).toBeInTheDocument());
    expect(screen.getByText(/offline validation is not supported/i)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
