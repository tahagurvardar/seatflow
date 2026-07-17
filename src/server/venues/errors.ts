export class VenueManagementAuthorizationError extends Error {
  constructor() {
    super("The resource was not found or you do not have permission to change it.");
    this.name = "VenueManagementAuthorizationError";
  }
}

export class VenueManagementConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VenueManagementConflictError";
  }
}

export class VenueManagementLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VenueManagementLifecycleError";
  }
}

export class SeatMapValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues[0] ?? "The seat map is not ready to publish.");
    this.name = "SeatMapValidationError";
  }
}

export function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}
