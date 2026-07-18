import { redactLogData } from "./logRedaction.js";

export { redactLogData } from "./logRedaction.js";

export const LogLevels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export const LogSources = ["ui", "plugin", "relay", "python", "unity"] as const;
export const LogStatuses = ["started", "progress", "succeeded", "failed", "cancelled"] as const;

export type LogLevel = (typeof LogLevels)[number];
export type LogSource = (typeof LogSources)[number];
export type LogStatus = (typeof LogStatuses)[number];

export interface LogErrorDetails {
  name?: string;
  code?: string;
  message: string;
  stack?: string;
}

export interface LogEvent {
  timestamp: string;
  level: LogLevel;
  source: LogSource;
  module: string;
  operationId: string;
  operationName: string;
  step: string;
  stepIndex: number;
  status: LogStatus;
  message: string;
  durationMs?: number;
  data?: Record<string, unknown>;
  error?: LogErrorDetails;
  ingestedAt?: string;
  ingestSequence?: number;
}

export interface OperationContext {
  operationId: string;
  operationName: string;
  source: LogSource;
  module: string;
}

export interface LogQuery {
  from?: string;
  to?: string;
  level?: LogLevel;
  source?: LogSource;
  module?: string;
  status?: LogStatus;
  operationId?: string;
  keyword?: string;
  cursor?: number;
  limit?: number;
}

export function normalizeIncomingLogEvent(value: unknown): LogEvent {
  const record = requireRecord(value, "event");
  const timestamp = requireString(record.timestamp, "timestamp");
  if (!Number.isFinite(Date.parse(timestamp))) {
    invalid("timestamp");
  }
  const level = requireMember(record.level, LogLevels, "level");
  const source = requireMember(record.source, LogSources, "source");
  const status = requireMember(record.status, LogStatuses, "status");
  const stepIndex = requireNonNegativeInteger(record.stepIndex, "stepIndex");
  const durationMs = record.durationMs === undefined
    ? undefined
    : requireNonNegativeNumber(record.durationMs, "durationMs");
  const data = record.data === undefined
    ? undefined
    : asRedactedRecord(record.data, "data");
  const error = record.error === undefined
    ? undefined
    : normalizeError(record.error);
  const ingestedAt = record.ingestedAt === undefined
    ? undefined
    : requireString(record.ingestedAt, "ingestedAt");
  const ingestSequence = record.ingestSequence === undefined
    ? undefined
    : requireNonNegativeInteger(record.ingestSequence, "ingestSequence");

  return {
    timestamp,
    level,
    source,
    module: requireString(record.module, "module"),
    operationId: requireString(record.operationId, "operationId"),
    operationName: requireString(record.operationName, "operationName"),
    step: requireString(record.step, "step"),
    stepIndex,
    status,
    message: requireString(record.message, "message"),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(data === undefined ? {} : { data }),
    ...(error === undefined ? {} : { error }),
    ...(ingestedAt === undefined ? {} : { ingestedAt }),
    ...(ingestSequence === undefined ? {} : { ingestSequence }),
  };
}

function normalizeError(value: unknown): LogErrorDetails {
  const record = requireRecord(value, "error");
  return {
    ...(record.name === undefined ? {} : { name: requireString(record.name, "error.name") }),
    ...(record.code === undefined ? {} : { code: requireString(record.code, "error.code") }),
    message: requireString(record.message, "error.message"),
    ...(record.stack === undefined ? {} : { stack: requireString(record.stack, "error.stack") }),
  };
}

function asRedactedRecord(value: unknown, field: string): Record<string, unknown> {
  const record = requireRecord(value, field);
  const redacted = redactLogData(record);
  return redacted && typeof redacted === "object" && !Array.isArray(redacted)
    ? redacted as Record<string, unknown>
    : {};
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(field);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(field);
  }
  return value.trim();
}

function requireMember<const T extends readonly string[]>(value: unknown, values: T, field: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    invalid(field);
  }
  return value as T[number];
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    invalid(field);
  }
  return Number(value);
}

function requireNonNegativeNumber(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    invalid(field);
  }
  return number;
}

function invalid(field: string): never {
  throw new Error(`invalid log event: ${field}`);
}
