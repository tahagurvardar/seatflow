import type {
  EventSessionStatus,
  EventStatus,
} from "@/generated/prisma/enums";

/**
 * Why a session cannot currently be sold to a customer. The reason drives honest
 * UI messaging without leaking internal state.
 */
export type SaleBlockReason =
  | "EVENT_UNAVAILABLE"
  | "SESSION_CANCELLED"
  | "SESSION_COMPLETED"
  | "SESSION_STARTED"
  | "SALES_ENDED"
  | "SALES_NOT_STARTED"
  | "SALES_NOT_OPEN"
  | "NO_INVENTORY";

export type SessionSalesEligibility =
  | { sellable: true }
  | { sellable: false; reason: SaleBlockReason; message: string };

export interface SessionSalesEligibilityInput {
  eventStatus: EventStatus;
  sessionStatus: EventSessionStatus;
  sessionStartAt: Date;
  salesStartAt: Date;
  salesEndAt: Date;
  hasInventory: boolean;
  now?: Date;
}

const REASON_MESSAGES: Record<SaleBlockReason, string> = {
  EVENT_UNAVAILABLE: "This event is not currently available.",
  SESSION_CANCELLED: "This session has been cancelled.",
  SESSION_COMPLETED: "This session has already taken place.",
  SESSION_STARTED: "This session has already started.",
  SALES_ENDED: "Sales for this session have closed.",
  SALES_NOT_STARTED: "Sales for this session have not opened yet.",
  SALES_NOT_OPEN: "Sales for this session are not currently open.",
  NO_INVENTORY: "Seats for this session are not available yet.",
};

function blocked(reason: SaleBlockReason): SessionSalesEligibility {
  return { sellable: false, reason, message: REASON_MESSAGES[reason] };
}

/**
 * The single source of truth for whether a session may be sold to a customer
 * right now. It deliberately trusts server time and the real sales window over
 * the stored status: an `ON_SALE` session whose window has elapsed is not
 * sellable, and a started session is never sellable.
 */
export function evaluateSessionSalesEligibility(
  input: SessionSalesEligibilityInput,
): SessionSalesEligibility {
  const now = input.now ?? new Date();

  if (input.eventStatus !== "PUBLISHED") return blocked("EVENT_UNAVAILABLE");
  if (input.sessionStatus === "CANCELLED") return blocked("SESSION_CANCELLED");
  if (input.sessionStatus === "COMPLETED") return blocked("SESSION_COMPLETED");
  if (now >= input.sessionStartAt) return blocked("SESSION_STARTED");
  if (now >= input.salesEndAt) return blocked("SALES_ENDED");
  if (now < input.salesStartAt) return blocked("SALES_NOT_STARTED");
  if (input.sessionStatus !== "ON_SALE") return blocked("SALES_NOT_OPEN");
  if (!input.hasInventory) return blocked("NO_INVENTORY");

  return { sellable: true };
}

export function isSessionSellable(
  input: SessionSalesEligibilityInput,
): boolean {
  return evaluateSessionSalesEligibility(input).sellable;
}
