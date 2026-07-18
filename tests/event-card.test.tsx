import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EventCard } from "@/components/events/event-card";
import { eventFixtures } from "./fixtures/events";

describe("EventCard", () => {
  it("renders the event identity, availability, location, and price", () => {
    const event = eventFixtures[0];
    if (!event) throw new Error("Expected event fixture");

    render(<EventCard event={event} />);

    expect(
      screen.getByRole("heading", { name: "Aurora Room Sessions" }),
    ).toBeInTheDocument();
    expect(screen.getByText("On sale")).toBeInTheDocument();
    expect(screen.getByText(/Stone Hall, Baku/)).toBeInTheDocument();
    expect(screen.getByText(/AZN\s*38\.00/)).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: event.image.alt }),
    ).toBeInTheDocument();
  });

  it("links the card to the event detail route", () => {
    const event = eventFixtures[1];
    if (!event) throw new Error("Expected event fixture");

    render(<EventCard event={event} />);

    const detailLinks = screen.getAllByRole("link", {
      name: /Afterlight: Premiere Night/,
    });
    expect(detailLinks[0]).toHaveAttribute("href", "/events/frame-field--afterlight-premiere");
  });
});
