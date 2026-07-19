/**
 * Structured logging for every SeatFlow process.
 *
 * Records are JSON-serializable and carry a fixed envelope (timestamp, level,
 * service, environment) plus optional correlation, operation, outcome, duration,
 * and bounded metadata. Production emits one JSON object per line for ingestion;
 * development emits a readable line. Both paths run the same redaction.
 */

import {
  MAX_LOG_MESSAGE_LENGTH,
  safeText,
  sanitizeMetadata,
  type SafeMetadata,
} from "@/features/observability/redaction";
import { serializeError, type SafeErrorRecord } from "@/features/observability/error-serializer";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Operation names label a bounded category such as `checkout.create`, never a
 * raw URL path. Public references in a path would make the label unbounded and
 * would leak identifiers into log indexes.
 */
const OPERATION_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$/;
const MAX_OPERATION_LENGTH = 64;

export function safeOperationName(value: string | undefined) {
  if (!value) return undefined;
  const trimmed = value.slice(0, MAX_OPERATION_LENGTH);
  return OPERATION_PATTERN.test(trimmed) ? trimmed : "unclassified";
}

export interface LogContext {
  correlationId?: string;
  operation?: string;
  outcome?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface ErrorLogContext extends LogContext {
  error?: unknown;
}

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  service: string;
  environment: string;
  message: string;
  correlationId?: string;
  operation?: string;
  outcome?: string;
  durationMs?: number;
  metadata?: SafeMetadata;
  error?: SafeErrorRecord;
}

export type LogSink = (record: LogRecord) => void;

const OUTCOME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

function safeOutcome(value: string | undefined) {
  if (!value) return undefined;
  return OUTCOME_PATTERN.test(value) ? value : "unclassified";
}

function safeDuration(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  // Bounded so a broken clock cannot write an absurd number into metrics.
  return Math.min(Math.round(value), 86_400_000);
}

function defaultSink(record: LogRecord) {
  const line =
    record.environment === "development"
      ? formatReadable(record)
      : JSON.stringify(record);

  if (record.level === "error") {
    console.error(line);
  } else if (record.level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function formatReadable(record: LogRecord) {
  const parts = [
    record.timestamp,
    record.level.toUpperCase().padEnd(5),
    record.operation ?? "-",
    record.message,
  ];
  if (record.correlationId) parts.push(`cid=${record.correlationId}`);
  if (record.outcome) parts.push(`outcome=${record.outcome}`);
  if (typeof record.durationMs === "number") parts.push(`${record.durationMs}ms`);
  if (record.error) parts.push(`err=${record.error.code}`);
  if (record.metadata) parts.push(JSON.stringify(record.metadata));
  return parts.join(" ");
}

export interface LoggerOptions {
  service?: string;
  environment?: string;
  level?: LogLevel;
  sink?: LogSink;
  now?: () => Date;
  base?: LogContext;
}

function resolveLevel(value: string | undefined): LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error"
    ? value
    : "info";
}

export class Logger {
  private readonly service: string;
  private readonly environment: string;
  private readonly level: LogLevel;
  private readonly sink: LogSink;
  private readonly now: () => Date;
  private readonly base: LogContext;

  constructor(options: LoggerOptions = {}) {
    this.service = options.service ?? process.env.SEATFLOW_SERVICE_NAME ?? "seatflow-web";
    this.environment = options.environment ?? process.env.NODE_ENV ?? "development";
    this.level = options.level ?? resolveLevel(process.env.LOG_LEVEL);
    this.sink = options.sink ?? defaultSink;
    this.now = options.now ?? (() => new Date());
    this.base = options.base ?? {};
  }

  /** Derive a logger that stamps every record with additional shared context. */
  child(context: LogContext): Logger {
    return new Logger({
      service: this.service,
      environment: this.environment,
      level: this.level,
      sink: this.sink,
      now: this.now,
      base: {
        ...this.base,
        ...context,
        metadata: { ...this.base.metadata, ...context.metadata },
      },
    });
  }

  withCorrelation(correlationId: string | undefined) {
    return correlationId ? this.child({ correlationId }) : this;
  }

  debug(message: string, context: LogContext = {}) {
    this.write("debug", message, context);
  }

  info(message: string, context: LogContext = {}) {
    this.write("info", message, context);
  }

  warn(message: string, context: ErrorLogContext = {}) {
    this.write("warn", message, context);
  }

  error(message: string, context: ErrorLogContext = {}) {
    this.write("error", message, context);
  }

  private write(level: LogLevel, message: string, context: ErrorLogContext) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

    const merged: ErrorLogContext = {
      ...this.base,
      ...context,
      metadata: { ...this.base.metadata, ...context.metadata },
    };
    const correlationId = merged.correlationId;

    const record: LogRecord = {
      timestamp: this.now().toISOString(),
      level,
      service: this.service,
      environment: this.environment,
      message: safeText(message, MAX_LOG_MESSAGE_LENGTH),
    };

    const operation = safeOperationName(merged.operation);
    if (operation) record.operation = operation;
    if (correlationId) record.correlationId = correlationId;

    const outcome = safeOutcome(merged.outcome);
    if (outcome) record.outcome = outcome;

    const durationMs = safeDuration(merged.durationMs);
    if (typeof durationMs === "number") record.durationMs = durationMs;

    const metadata = sanitizeMetadata(merged.metadata);
    if (metadata) record.metadata = metadata;

    if (merged.error !== undefined) {
      record.error = serializeError(merged.error, { correlationId });
    }

    this.sink(record);
  }
}

let rootLogger: Logger | null = null;

/** Process-wide logger. Workers override the service name through the env. */
export function getLogger() {
  rootLogger ??= new Logger();
  return rootLogger;
}

/** Test seam: replace or clear the process-wide logger. */
export function setLogger(logger: Logger | null) {
  rootLogger = logger;
}
