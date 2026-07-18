import type { SupportedCurrency } from "@/config/site";
import type { SeatHoldStatus, SeatType } from "@/generated/prisma/enums";
import { holdSecondsRemaining, isHoldExpired, isHoldLive } from "@/features/holds/lifecycle";
import { calculateHoldTotal } from "@/features/holds/totals";

export interface HoldItemInput {
  sectionName: string;
  sectionCode: string;
  rowLabel: string;
  seatLabel: string;
  seatType: SeatType;
  priceMinor: number;
  currency: SupportedCurrency;
}

export interface HoldViewInput {
  publicToken: string;
  status: SeatHoldStatus;
  expiresAt: Date;
  createdAt: Date;
  releasedAt: Date | null;
  expiredAt: Date | null;
  event: { title: string; publicSlug: string };
  session: {
    id: string;
    startAt: Date;
    timeZone: string;
    venueName: string;
    spaceName: string;
    city: string;
  };
  items: HoldItemInput[];
  now?: Date;
}

export interface HoldSeatView {
  sectionName: string;
  sectionCode: string;
  rowLabel: string;
  seatLabel: string;
  seatType: SeatType;
  priceMinor: number;
  currency: SupportedCurrency;
}

export interface CustomerHoldView {
  publicToken: string;
  status: SeatHoldStatus;
  live: boolean;
  expired: boolean;
  expiresAt: string;
  createdAt: string;
  releasedAt: string | null;
  expiredAt: string | null;
  secondsRemaining: number;
  event: { title: string; publicSlug: string };
  session: {
    id: string;
    startAt: string;
    timeZone: string;
    venueName: string;
    spaceName: string;
    city: string;
  };
  seats: HoldSeatView[];
  totalMinor: number;
  currency: SupportedCurrency;
  seatCount: number;
}

/**
 * Build the hold's owner-facing view model. This is the only place hold detail
 * is exposed, and only ever to the authenticated owner. The official total is
 * recomputed here from the immutable per-seat snapshots, never trusted from a
 * client. No other customer's identity or token can appear in this shape.
 */
export function toCustomerHoldView(input: HoldViewInput): CustomerHoldView {
  const now = input.now ?? new Date();
  const total = calculateHoldTotal(
    input.items.map((item) => ({
      priceMinor: item.priceMinor,
      currency: item.currency,
    })),
  );

  const seats = [...input.items].sort(
    (first, second) =>
      first.sectionCode.localeCompare(second.sectionCode) ||
      first.rowLabel.localeCompare(second.rowLabel) ||
      first.seatLabel.localeCompare(second.seatLabel, undefined, { numeric: true }),
  );

  return {
    publicToken: input.publicToken,
    status: input.status,
    live: isHoldLive({ status: input.status, expiresAt: input.expiresAt, now }),
    expired: isHoldExpired({ status: input.status, expiresAt: input.expiresAt, now }),
    expiresAt: input.expiresAt.toISOString(),
    createdAt: input.createdAt.toISOString(),
    releasedAt: input.releasedAt ? input.releasedAt.toISOString() : null,
    expiredAt: input.expiredAt ? input.expiredAt.toISOString() : null,
    secondsRemaining: holdSecondsRemaining({
      status: input.status,
      expiresAt: input.expiresAt,
      now,
    }),
    event: input.event,
    session: {
      id: input.session.id,
      startAt: input.session.startAt.toISOString(),
      timeZone: input.session.timeZone,
      venueName: input.session.venueName,
      spaceName: input.session.spaceName,
      city: input.session.city,
    },
    seats,
    totalMinor: total.totalMinor,
    currency: total.currency,
    seatCount: total.seatCount,
  };
}

// ---------------------------------------------------------------------------
// Organizer inventory summary (aggregate counts only, never customer identity)
// ---------------------------------------------------------------------------

export interface InventoryStateCounts {
  total: number;
  available: number;
  held: number;
  activeHolds: number;
  earliestHoldExpiresAt: Date | null;
}

export interface OrganizerInventorySummary {
  total: number;
  available: number;
  held: number;
  activeHolds: number;
  earliestHoldExpiresAt: string | null;
}

/**
 * Read-only inventory summary for organizers. It reports aggregate availability
 * only: no customer email, id, or hold token, and holds are never presented as
 * sales.
 */
export function toOrganizerInventorySummary(
  counts: InventoryStateCounts,
): OrganizerInventorySummary {
  return {
    total: counts.total,
    available: counts.available,
    held: counts.held,
    activeHolds: counts.activeHolds,
    earliestHoldExpiresAt: counts.earliestHoldExpiresAt
      ? counts.earliestHoldExpiresAt.toISOString()
      : null,
  };
}
