import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BulkRowGenerator } from "../src/components/seat-maps/bulk-row-generator";
import { SeatEditor } from "../src/components/seat-maps/seat-editor";
import { SeatMapRenderer } from "../src/components/seat-maps/seat-map-renderer";
import { VenueForm } from "../src/components/venue-operator/venue-form";

const sections = [{
  id: "section-1",
  name: "Main",
  code: "MAIN",
  rows: [{
    id: "row-1",
    label: "A",
    seats: [
      { id: "seat-1", label: "1", x: 0, y: 0, type: "STANDARD" as const, state: "ACTIVE" as const },
      { id: "seat-2", label: "2", x: 40, y: 0, type: "PREMIUM" as const, state: "BLOCKED" as const },
    ],
  }],
}];

describe("seat-map components", () => {
  it("renders a readable seat preview with state and coordinate metadata", () => {
    render(<SeatMapRenderer sections={sections} />);
    expect(screen.getByText("Stage / screen")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(
      /checkout and booking are not available in Phase 4A/i,
    );
    const blockedSeat = screen.getByRole("img", {
      name: /Main, row A, seat 2: premium, blocked/i,
    });

    expect(blockedSeat).toHaveAttribute(
      "title",
      expect.stringMatching(/MAIN-A-2.*premium.*blocked.*\(40, 0\)/),
    );
    expect(blockedSeat.parentElement).toHaveAttribute(
      "data-seat-coordinate",
      "40,0",
    );
    expect(blockedSeat.parentElement).toHaveStyle({ left: "96px", top: "12px" });
  });

  it("renders an honest empty state for an empty layout", () => {
    render(<SeatMapRenderer sections={[]} />);
    expect(
      screen.getByText("This seat map does not contain any sections yet."),
    ).toBeInTheDocument();
  });

  it("updates the bulk-generation preview locally", async () => {
    const user = userEvent.setup();
    render(<BulkRowGenerator action={vi.fn()} sectionId="section-1" />);

    await user.clear(screen.getByLabelText("Start row"));
    await user.type(screen.getByLabelText("Start row"), "Y");
    fireEvent.change(screen.getByLabelText("Rows"), { target: { value: "4" } });

    expect(screen.getByText(/Y, Z, AA, AB/)).toBeInTheDocument();
    expect(screen.getByLabelText("Generated seat preview")).toBeInTheDocument();
  });

  it("uses semantic radio selection to edit a different seat", async () => {
    const user = userEvent.setup();
    render(<SeatEditor action={vi.fn()} sections={sections} />);

    const secondSeat = screen.getByRole("radio", {
      name: "MAIN row A seat 2",
    });
    expect(secondSeat.closest("label")?.parentElement).toHaveStyle({
      left: "96px",
      top: "12px",
    });

    await user.click(secondSeat);
    expect(screen.getByRole("heading", { name: "Edit seat 2" })).toBeInTheDocument();
    expect(screen.getByLabelText("State")).toHaveValue("BLOCKED");
  });

  it("shows the visual editor empty state without fake seats", () => {
    render(
      <SeatEditor
        action={vi.fn()}
        sections={[{ id: "section-1", code: "MAIN", rows: [] }]}
      />,
    );
    expect(screen.getByText(/Add a row and seat/i)).toBeInTheDocument();
  });

  it("renders venue defaults without exposing an archived status transition", () => {
    render(
      <VenueForm
        action={vi.fn(async () => ({}))}
        submitLabel="Save venue"
        defaults={{
          name: "Caspian Hall",
          city: "Baku",
          countryCode: "AZ",
          addressLine1: "1 Promenade Avenue",
          timeZone: "Asia/Baku",
          status: "ACTIVE",
        }}
      />,
    );

    expect(screen.getByLabelText("Venue name")).toHaveValue("Caspian Hall");
    expect(screen.getByLabelText("Time zone")).toHaveValue("Asia/Baku");
    expect(
      screen.queryByRole("option", { name: "Archived" }),
    ).not.toBeInTheDocument();
  });
});
