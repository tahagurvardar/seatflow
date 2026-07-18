export class EventAuthorizationError extends Error {
  constructor() {
    super("The resource was not found or you do not have permission to change it.");
    this.name = "EventAuthorizationError";
  }
}

export class EventConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventConflictError";
  }
}

export class EventLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventLifecycleError";
  }
}

export class EventValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues[0] ?? "The event configuration is not valid.");
    this.name = "EventValidationError";
  }
}

export function isPrismaUniqueConstraintError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

export function isSessionOverlapConstraintError(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  const text = "message" in error ? String(error.message) : "";
  return (
    ("code" in error && error.code === "P2004") ||
    text.includes("EventSession_no_overlapping_space_time") ||
    text.includes("conflicting key value violates exclusion constraint")
  );
}
