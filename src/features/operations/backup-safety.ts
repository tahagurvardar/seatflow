/**
 * Safety guards for backup and restore tooling.
 *
 * Restore is the most destructive operation in this repository: it drops and
 * recreates a schema. These guards are pure so they can be exhaustively unit
 * tested, and every restore path must call them before touching a database.
 *
 * The rule is simple and deliberately strict: a restore may only ever target a
 * database whose *name* marks it as disposable, and never one that matches the
 * configured runtime or migration URL.
 */

export class BackupSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupSafetyError";
  }
}

/** Database names that a restore is permitted to overwrite. */
const DISPOSABLE_NAME_PATTERN = /(^|[_-])(verify|verification|restore|scratch|test)($|[_-])/i;

export function isDisposableDatabaseName(name: string) {
  return DISPOSABLE_NAME_PATTERN.test(name);
}

export function databaseNameFromUrl(url: string) {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    return "";
  }
}

/**
 * Redact a connection string for display. Backup tooling prints its target so
 * an operator can confirm it, but must never print credentials.
 */
export function describeDatabaseTarget(url: string) {
  try {
    const parsed = new URL(url);
    const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    return `${parsed.hostname}:${parsed.port || "5432"}/${name}`;
  } catch {
    return "[unparseable database url]";
  }
}

export interface RestoreTargetInput {
  targetUrl: string;
  /** Runtime and migration URLs that must never be restore targets. */
  protectedUrls: readonly (string | undefined)[];
  /** Operator supplied `--confirm`. */
  confirmed: boolean;
}

/**
 * Throw unless the target is unambiguously a disposable verification database.
 * Returns the validated database name on success.
 */
export function assertDisposableRestoreTarget(input: RestoreTargetInput): string {
  const { targetUrl } = input;

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new BackupSafetyError("Restore target is not a valid URL.");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new BackupSafetyError("Restore target must be a postgresql:// URL.");
  }

  const name = databaseNameFromUrl(targetUrl);
  if (!name) {
    throw new BackupSafetyError("Restore target does not name a database.");
  }

  if (!isDisposableDatabaseName(name)) {
    throw new BackupSafetyError(
      "Refusing to restore: the target database name is not marked disposable. " +
        "Use a database whose name contains 'verify', 'restore', 'scratch', or 'test'.",
    );
  }

  const protectedSet = new Set(
    input.protectedUrls.filter((value): value is string => Boolean(value)),
  );
  if (protectedSet.has(targetUrl)) {
    throw new BackupSafetyError(
      "Refusing to restore: the target matches DATABASE_URL or DIRECT_URL.",
    );
  }

  // Also compare by host+name so a differently-spelled but equivalent URL
  // (extra query parameters, credentials) cannot slip past the exact match.
  const targetIdentity = `${parsed.host}/${name}`;
  for (const url of protectedSet) {
    try {
      const other = new URL(url);
      if (`${other.host}/${databaseNameFromUrl(url)}` === targetIdentity) {
        throw new BackupSafetyError(
          "Refusing to restore: the target resolves to the same host and database as a protected URL.",
        );
      }
    } catch (error) {
      if (error instanceof BackupSafetyError) throw error;
    }
  }

  if (!input.confirmed) {
    throw new BackupSafetyError(
      "Refusing to restore without --confirm. This drops and recreates the target schema.",
    );
  }

  return name;
}

const UNSAFE_PATH_PATTERN = /[\r\n\0]|\.\.[\\/]/;

/**
 * Backups contain complete customer, payment, and ticket data. They must never
 * be written inside the repository, where they could be committed.
 */
export function assertSafeBackupPath(filePath: string, repositoryRoot: string) {
  if (!filePath || UNSAFE_PATH_PATTERN.test(filePath)) {
    throw new BackupSafetyError("Backup path contains unsafe characters.");
  }

  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const normalizedPath = normalize(filePath);
  const normalizedRoot = normalize(repositoryRoot);

  if (normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`)) {
    throw new BackupSafetyError(
      "Refusing to write a backup inside the repository. Backups contain customer, payment, and ticket data and must never reach version control.",
    );
  }
  return filePath;
}

export interface RowCountComparison {
  table: string;
  source: number;
  restored: number;
  matches: boolean;
}

/** Compare critical table counts between the source and the restored copy. */
export function compareRowCounts(
  source: Record<string, number>,
  restored: Record<string, number>,
): RowCountComparison[] {
  return Object.keys(source)
    .sort()
    .map((table) => ({
      table,
      source: source[table] ?? 0,
      restored: restored[table] ?? 0,
      matches: (source[table] ?? 0) === (restored[table] ?? 0),
    }));
}

/** Tables whose counts must match exactly for a restore to be considered good. */
export const CRITICAL_BACKUP_TABLES = [
  "User",
  "Organization",
  "Event",
  "EventSession",
  "SessionSeatInventory",
  "SeatHold",
  "CheckoutOrder",
  "PaymentAttempt",
  "PaymentWebhookEvent",
  "Booking",
  "BookingSeat",
  "Ticket",
  "TicketCredential",
  "TicketRedemptionEvent",
  "InventoryEventOutbox",
  "NotificationOutbox",
] as const;
