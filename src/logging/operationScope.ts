import type {
  LogErrorDetails,
  LogLevel,
  LogStatus,
  OperationContext,
} from "./logEvent.js";
import type { RelayLogger } from "./relayLogger.js";

interface OperationScopeOptions {
  logger: RelayLogger;
  context: OperationContext;
  message: string;
  startedAt: Date;
  data?: Record<string, unknown>;
}

export class OperationScope {
  readonly context: OperationContext;

  private readonly logger: RelayLogger;
  private readonly startedAt: Date;
  private nextStepIndex = 1;
  private terminalStatus?: Extract<LogStatus, "succeeded" | "failed" | "cancelled">;

  constructor(options: OperationScopeOptions) {
    this.logger = options.logger;
    this.context = options.context;
    this.startedAt = options.startedAt;
    this.logger.emitOperationEvent({
      context: this.context,
      step: "operation.start",
      stepIndex: 0,
      status: "started",
      level: "info",
      message: options.message,
      timestamp: this.startedAt,
      data: options.data,
    });
  }

  get operationId(): string {
    return this.context.operationId;
  }

  get completed(): boolean {
    return this.terminalStatus !== undefined;
  }

  step(
    step: string,
    message: string,
    data?: Record<string, unknown>,
    level: LogLevel = "info",
  ): void {
    this.emitProgress(step, message, level, data);
  }

  succeed(message: string, data?: Record<string, unknown>): void {
    this.emitTerminal("succeeded", "info", message, data);
  }

  fail(error: unknown, message = "操作执行失败", data?: Record<string, unknown>): void {
    this.emitTerminal("failed", "error", message, data, toErrorDetails(error));
  }

  cancel(message = "操作已取消", data?: Record<string, unknown>): void {
    this.emitTerminal("cancelled", "warn", message, data);
  }

  private emitProgress(
    step: string,
    message: string,
    level: LogLevel,
    data?: Record<string, unknown>,
  ): void {
    const timestamp = this.logger.now();
    this.logger.emitOperationEvent({
      context: this.context,
      step,
      stepIndex: this.nextStepIndex++,
      status: "progress",
      level,
      message,
      timestamp,
      durationMs: timestamp.getTime() - this.startedAt.getTime(),
      data,
    });
  }

  private emitTerminal(
    status: Extract<LogStatus, "succeeded" | "failed" | "cancelled">,
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>,
    error?: LogErrorDetails,
  ): void {
    if (this.terminalStatus) {
      this.emitProgress(
        "operation.terminal.ignored",
        `忽略重复终态：已记录 ${this.terminalStatus}，收到 ${status}`,
        "warn",
        { recordedStatus: this.terminalStatus, ignoredStatus: status },
      );
      return;
    }
    this.terminalStatus = status;
    const timestamp = this.logger.now();
    this.logger.emitOperationEvent({
      context: this.context,
      step: "operation.complete",
      stepIndex: this.nextStepIndex++,
      status,
      level,
      message,
      timestamp,
      durationMs: timestamp.getTime() - this.startedAt.getTime(),
      data,
      error,
    });
  }
}

function toErrorDetails(error: unknown): LogErrorDetails {
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
