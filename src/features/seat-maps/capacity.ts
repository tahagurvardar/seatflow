import type { SeatState, SeatType } from "@/generated/prisma/enums";

interface CapacitySeat {
  type: SeatType;
  state: SeatState;
}

interface CapacityGraph {
  sections: Array<{ rows: Array<{ seats: CapacitySeat[] }> }>;
}

const seatTypes: SeatType[] = ["STANDARD", "ACCESSIBLE", "COMPANION", "PREMIUM"];

export function calculateSeatMapCapacity(graph: CapacityGraph) {
  const seats = graph.sections.flatMap((section) =>
    section.rows.flatMap((row) => row.seats),
  );
  const byType = Object.fromEntries(
    seatTypes.map((type) => {
      const matching = seats.filter((seat) => seat.type === type);
      return [
        type,
        {
          total: matching.length,
          sellable: matching.filter((seat) => seat.state === "ACTIVE").length,
          blocked: matching.filter((seat) => seat.state === "BLOCKED").length,
        },
      ];
    }),
  ) as Record<SeatType, { total: number; sellable: number; blocked: number }>;

  return {
    total: seats.length,
    sellable: seats.filter((seat) => seat.state === "ACTIVE").length,
    blocked: seats.filter((seat) => seat.state === "BLOCKED").length,
    byType,
  };
}
