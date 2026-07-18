interface PublicVisibilityInput {
  eventStatus: "DRAFT" | "PUBLISHED" | "CANCELLED" | "ARCHIVED";
  sessionStatus:
    | "DRAFT"
    | "SCHEDULED"
    | "ON_SALE"
    | "SALES_PAUSED"
    | "CANCELLED"
    | "COMPLETED";
  sessionStartAt: Date;
  hasValidPricing: boolean;
  now?: Date;
}

export function isPubliclyEligibleSession({
  eventStatus,
  sessionStatus,
  sessionStartAt,
  hasValidPricing,
  now = new Date(),
}: PublicVisibilityInput) {
  return (
    eventStatus === "PUBLISHED" &&
    ["SCHEDULED", "ON_SALE", "SALES_PAUSED"].includes(sessionStatus) &&
    sessionStartAt > now &&
    hasValidPricing
  );
}
