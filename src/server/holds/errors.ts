import type { SaleBlockReason } from "@/features/holds/eligibility";

/** Authentication is required to create or manage a hold. */
export class HoldAuthenticationError extends Error {
  constructor() {
    super("You must be signed in to hold seats.");
    this.name = "HoldAuthenticationError";
  }
}

/**
 * The hold or session was not found, or the caller does not own it. The message
 * is intentionally uniform so it cannot be used to enumerate holds or seats.
 */
export class HoldAuthorizationError extends Error {
  constructor(message = "That hold was not found or is not yours.") {
    super(message);
    this.name = "HoldAuthorizationError";
  }
}

/** The session cannot currently be sold to a customer. */
export class HoldEligibilityError extends Error {
  constructor(
    public readonly reason: SaleBlockReason,
    message: string,
  ) {
    super(message);
    this.name = "HoldEligibilityError";
  }
}

/**
 * A concurrency or idempotency conflict: a requested seat is no longer
 * available, the customer already holds seats for this session, or an
 * idempotency key was reused with a different payload.
 */
export class HoldConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HoldConflictError";
  }
}

/** The request was structurally invalid (unknown seats, cross-session mixing). */
export class HoldValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues[0] ?? "Your seat selection is not valid.");
    this.name = "HoldValidationError";
  }
}

/** Inventory for the session is missing or internally inconsistent. */
export class InventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryError";
  }
}

function prismaErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String((error as { code: unknown }).code);
  }
  return undefined;
}

export function isUniqueConstraintError(error: unknown, constraint?: string) {
  if (prismaErrorCode(error) !== "P2002") return false;
  if (!constraint) return true;
  const target =
    typeof error === "object" && error !== null && "meta" in error
      ? (error as { meta?: { target?: unknown } }).meta?.target
      : undefined;
  const text = Array.isArray(target) ? target.join(",") : String(target ?? "");
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : "";
  return text.includes(constraint) || message.includes(constraint);
}
