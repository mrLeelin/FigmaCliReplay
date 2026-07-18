import { randomUUID } from "node:crypto";

import type {
  LogErrorDetails,
  LogEvent,
  LogLevel,
  LogSource,
  LogStatus,
  OperationContext,
} from "./logEvent.js";
import { fitLogEventToSize } from "./logRedaction.js";
import { OperationScope } from "./operationScope.js";

export interface RelayLoggerOptions {
  source?: LogSource;
  module: string;
  emit: (event: LogEvent) => void;
  now?: () => Date;
  idFactory?: () => string;
  protocolWrite?: (message: string) => void;
}

export interface StartOperationOptions {
  operationId?: string;
  source?: LogSource;
  module?: string;
  data?: Record<string, unknown>;
}

export interface OperationEventInput {
  context: OperationContext;
  step: string;
  stepIndex: number;
  status: LogStatus;
  level: LogLevel;
  message: string;
  timestamp: Date;
  durationMs?: number;
  data?: Record<string, unknown>;
  error?: LogErrorDetails;
}

export class RelayLogger {
  readonly source: LogSource;
  readonly module: string;

  private readonly emitSink: (event: LogEvent) => void;
  private readonly clock: () => Date;
  private readonly createId: () => string;
  private readonly protocolWrite?: (message: string) => void;

  constructor(options: RelayLoggerOptions) {
    this.source = options.source ?? "relay";
    this.module = options.module;
    this.emitSink = options.emit;
    this.clock = options.now ?? (() => new Date());
    this.createId = options.idFactory ?? randomUUID;
    this.protocolWrite = options.protocolWrite ?? ((line) => process.stdout.write(line));
  }

  child(module: string): RelayLogger {
    return new RelayLogger({
      source: this.source,
      module,
      emit: this.emitSink,
      now: this.clock,
      idFactory: this.createId,
      protocolWrite: this.protocolWrite,
    });
  }

  startOperation(
    operationName: string,
    messageOrContext: string | Partial<OperationContext> = operationName,
    dataOrOptions?: Record<string, unknown> | StartOperationOptions,
  ): OperationScope {
    const context = typeof messageOrContext === "string" ? undefined : messageOrContext;
    const message = typeof messageOrContext === "string" ? messageOrContext : operationName;
    const options = normalizeStartOptions(dataOrOptions);
    return new OperationScope({
      logger: this,
      context: {
        operationId: options.operationId ?? context?.operationId ?? this.createId(),
        operationName: context?.operationName ?? operationName,
        source: options.source ?? context?.source ?? this.source,
        module: options.module ?? context?.module ?? this.module,
      },
      message,
      data: options.data,
      startedAt: this.now(),
    });
  }

  now(): Date {
    return this.clock();
  }

  trace(message: string, data?: Record<string, unknown>, context?: Partial<OperationContext>): void {
    this.emitStandalone("trace", message, data, context);
  }

  debug(message: string, data?: Record<string, unknown>, context?: Partial<OperationContext>): void {
    this.emitStandalone("debug", message, data, context);
  }

  info(message: string, data?: Record<string, unknown>, context?: Partial<OperationContext>): void {
    this.emitStandalone("info", message, data, context);
  }

  warn(message: string, data?: Record<string, unknown>, context?: Partial<OperationContext>): void {
    this.emitStandalone("warn", message, data, context);
  }

  error(
    message: string,
    error?: unknown,
    data?: Record<string, unknown>,
    context?: Partial<OperationContext>,
  ): void {
    this.emitStandalone("error", message, data, context, normalizeError(error ?? message));
  }

  fatal(
    message: string,
    error?: unknown,
    data?: Record<string, unknown>,
    context?: Partial<OperationContext>,
  ): void {
    this.emitStandalone("fatal", message, data, context, normalizeError(error ?? message));
  }

  writeProtocolOutput(payload: unknown): void {
    const line = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.protocolWrite?.(`${line}\n`);
  }

  emitOperationEvent(input: OperationEventInput): void {
    const event = fitLogEventToSize({
      timestamp: input.timestamp.toISOString(),
      level: input.level,
      source: input.context.source,
      module: input.context.module,
      operationId: input.context.operationId,
      operationName: input.context.operationName,
      step: input.step,
      stepIndex: input.stepIndex,
      status: input.status,
      message: input.message,
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
      ...(input.data === undefined ? {} : { data: input.data }),
      ...(input.error === undefined ? {} : { error: input.error }),
    });
    try {
      this.emitSink(event);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[logging-fallback] ${reason}\n`);
    }
  }

  private emitStandalone(
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>,
    context?: Partial<OperationContext>,
    error?: LogErrorDetails,
  ): void {
    const timestamp = this.now();
    this.emitOperationEvent({
      context: {
        operationId: context?.operationId ?? this.createId(),
        operationName: context?.operationName ?? "diagnostic",
        source: context?.source ?? this.source,
        module: context?.module ?? this.module,
      },
      step: "log",
      stepIndex: 0,
      status: "progress",
      level,
      message,
      timestamp,
      data,
      error,
    });
  }
}

function normalizeStartOptions(
  value?: Record<string, unknown> | StartOperationOptions,
): StartOperationOptions {
  if (!value) {
    return {};
  }
  const hasOptionKey = "operationId" in value
    || "source" in value
    || "module" in value
    || "data" in value;
  return hasOptionKey
    ? value as StartOperationOptions
    : { data: value as Record<string, unknown> };
}

function normalizeError(error: unknown): LogErrorDetails {
  if (error instanceof Error) {
    const errorWithCode = error as Error & { code?: unknown };
    return {
      name: error.name,
      message: error.message,
      ...(typeof errorWithCode.code === "string" ? { code: errorWithCode.code } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { message: String(error) };
}
