import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EventCard } from "@/components/events/event-card";
import { events } from "@/data/events";

describe("EventCard", () => {
  it("renders the event identity, availability, location, and price", () => {
    const event = events[0];
    if (!event) throw new Error("Expected event fixture");

    render(<EventCard event={event} />);

    expect(
      screen.getByRole("heading", { name: "Aurora Room Sessions" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Selling fast")).toBeInTheDocument();
    expect(screen.getByText(/Stone Hall, Baku/)).toBeInTheDocument();
    expect(screen.getByText("AZN 38")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: event.image.alt }),
    ).toBeInTheDocument();
  });

  it("links the card to the event detail route", () => {
    const event = events[1];
    if (!event) throw new Error("Expected event fixture");

    render(<EventCard event={event} />);

    const detailLinks = screen.getAllByRole("link", {
      name: /Afterlight: Premiere Night/,
    });
    expect(detailLinks[0]).toHaveAttribute("href", "/events/afterlight-premiere");
  });
});
