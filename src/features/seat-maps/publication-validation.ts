import { SEAT_MAP_LIMITS } from "@/features/seat-maps/schema";
import type { SeatState, SeatType } from "@/generated/prisma/enums";

interface PublicationSeat {
  label: string;
  displayOrder: number;
  x: number;
  y: number;
  type: SeatType;
  state: SeatState;
}

interface PublicationRow {
  label: string;
  displayOrder: number;
  seats: PublicationSeat[];
}

interface PublicationSection {
  name: string;
  code: string;
  displayOrder: number;
  rows: PublicationRow[];
}

export interface PublicationGraph {
  sections: PublicationSection[];
}

function hasDuplicates(values: Array<string | number>) {
  return new Set(values).size !== values.length;
}

export function validateSeatMapForPublication(graph: PublicationGraph) {
  const issues: string[] = [];
  const totalSeats = graph.sections.reduce(
    (total, section) =>
      total + section.rows.reduce((sectionTotal, row) => sectionTotal + row.seats.length, 0),
    0,
  );

  if (graph.sections.length === 0) issues.push("Add at least one section.");
  if (graph.sections.length > SEAT_MAP_LIMITS.maximumSections) {
    issues.push(`A map can contain at most ${SEAT_MAP_LIMITS.maximumSections} sections.`);
  }
  if (totalSeats === 0) issues.push("Add at least one seat.");
  if (totalSeats > SEAT_MAP_LIMITS.maximumSeatsPerMap) {
    issues.push(`A map can contain at most ${SEAT_MAP_LIMITS.maximumSeatsPerMap} seats.`);
  }
  if (hasDuplicates(graph.sections.map((section) => section.code.toUpperCase()))) {
    issues.push("Section codes must be unique.");
  }
  if (hasDuplicates(graph.sections.map((section) => section.displayOrder))) {
    issues.push("Section order values must be unique.");
  }

  for (const section of graph.sections) {
    if (section.rows.length === 0) issues.push(`Section ${section.code} has no rows.`);
    if (section.rows.length > SEAT_MAP_LIMITS.maximumRowsPerSection) {
      issues.push(`Section ${section.code} exceeds the row limit.`);
    }
    if (hasDuplicates(section.rows.map((row) => row.label.toUpperCase()))) {
      issues.push(`Section ${section.code} contains duplicate row labels.`);
    }
    if (hasDuplicates(section.rows.map((row) => row.displayOrder))) {
      issues.push(`Section ${section.code} contains duplicate row order values.`);
    }

    const coordinates = section.rows.flatMap((row) =>
      row.seats.map((seat) => `${seat.x}:${seat.y}`),
    );
    if (hasDuplicates(coordinates)) {
      issues.push(`Section ${section.code} contains overlapping seat coordinates.`);
    }

    for (const row of section.rows) {
      if (row.seats.length === 0) issues.push(`Row ${section.code}-${row.label} has no seats.`);
      if (row.seats.length > SEAT_MAP_LIMITS.maximumSeatsPerRow) {
        issues.push(`Row ${section.code}-${row.label} exceeds the seat limit.`);
      }
      if (hasDuplicates(row.seats.map((seat) => seat.label.toUpperCase()))) {
        issues.push(`Row ${section.code}-${row.label} contains duplicate seat labels.`);
      }
      if (hasDuplicates(row.seats.map((seat) => seat.displayOrder))) {
        issues.push(`Row ${section.code}-${row.label} contains duplicate seat order values.`);
      }

      const accessibleSeats = row.seats.filter((seat) => seat.type === "ACCESSIBLE").length;
      const companionSeats = row.seats.filter((seat) => seat.type === "COMPANION").length;
      if (companionSeats > accessibleSeats) {
        issues.push(
          `Row ${section.code}-${row.label} needs at least one accessible seat for each companion seat.`,
        );
      }

      for (const seat of row.seats) {
        if (
          seat.x < SEAT_MAP_LIMITS.minimumCoordinate ||
          seat.x > SEAT_MAP_LIMITS.maximumCoordinate ||
          seat.y < SEAT_MAP_LIMITS.minimumCoordinate ||
          seat.y > SEAT_MAP_LIMITS.maximumCoordinate
        ) {
          issues.push(`Seat ${section.code}-${row.label}-${seat.label} is outside the canvas.`);
        }
      }
    }
  }

  return [...new Set(issues)];
}
