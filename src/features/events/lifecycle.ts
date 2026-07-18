import type {
  EventSessionStatus,
  EventStatus,
} from "@/generated/prisma/enums";

export function canEditEvent(status: EventStatus) {
  return status === "DRAFT";
}

export function canPublishEvent(status: EventStatus) {
  return status === "DRAFT" || status === "PUBLISHED";
}

export function canCancelEvent(status: EventStatus) {
  return status === "DRAFT" || status === "PUBLISHED";
}

export function canArchiveEvent(status: EventStatus) {
  return status !== "ARCHIVED";
}

export function canRestoreEvent(
  status: EventStatus,
  preArchiveStatus: EventStatus | null,
) {
  return (
    status === "ARCHIVED" &&
    (preArchiveStatus === "DRAFT" || preArchiveStatus === "PUBLISHED")
  );
}

export function canEditSession(status: EventSessionStatus) {
  return status === "DRAFT";
}

export function canEditSessionPricing(status: EventSessionStatus) {
  return status === "DRAFT";
}

export function canPublishSession(status: EventSessionStatus) {
  return status === "DRAFT" || status === "SCHEDULED" || status === "ON_SALE";
}

export function canPauseSessionSales(status: EventSessionStatus) {
  return status === "ON_SALE";
}

export function canResumeSessionSales(status: EventSessionStatus) {
  return status === "SALES_PAUSED";
}

export function canCancelSession(status: EventSessionStatus) {
  return !["CANCELLED", "COMPLETED"].includes(status);
}
