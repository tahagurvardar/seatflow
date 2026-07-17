import type {
  SeatMapStatus,
  SpaceStatus,
  VenueStatus,
} from "@/generated/prisma/enums";

interface SeatMapLifecycleContext {
  seatMapStatus: SeatMapStatus;
  spaceStatus: SpaceStatus;
  venueStatus: VenueStatus;
}

function hasOperationalParents(
  context: Pick<SeatMapLifecycleContext, "spaceStatus" | "venueStatus">,
) {
  return (
    context.spaceStatus !== "ARCHIVED" && context.venueStatus !== "ARCHIVED"
  );
}

export function canEditSeatMap(context: SeatMapLifecycleContext) {
  return context.seatMapStatus === "DRAFT" && hasOperationalParents(context);
}

export function canPublishSeatMap(context: SeatMapLifecycleContext) {
  return canEditSeatMap(context);
}

export function canCloneSeatMap(context: SeatMapLifecycleContext) {
  return context.seatMapStatus === "PUBLISHED" && hasOperationalParents(context);
}
