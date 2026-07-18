import type { OperationContext } from "../logging/logEvent.js";
import { getLoggingRuntime } from "../logging/loggingRuntime.js";
import type { RelayLogger } from "../logging/relayLogger.js";

type Details = Record<string, unknown>;

function legacyLogger(module = "legacy"): RelayLogger {
  return getLoggingRuntime().logger(module);
}

export const logTrace = (message: string, details?: Details): void =>
  legacyLogger().trace(message, details);
export const logDebug = (message: string, details?: Details): void =>
  legacyLogger().debug(message, details);
export const logInfo = (message: string, details?: Details): void =>
  legacyLogger().info(message, details);
export const logWarn = (message: string, details?: Details): void =>
  legacyLogger().warn(message, details);
export const logError = (message: string, details?: Details): void =>
  legacyLogger().error(message, undefined, details);
export const logFatal = (message: string, details?: Details): void =>
  legacyLogger().fatal(message, undefined, details);

export function createLogger(name: string): RelayLogger {
  return legacyLogger(name);
}

class CompatibilityLogger {
  trace(details: Details, message: string): void;
  trace(message: string, details?: Details): void;
  trace(first: string | Details, second?: string | Details): void {
    invoke(this.module, "trace", first, second);
  }

  debug(details: Details, message: string): void;
  debug(message: string, details?: Details): void;
  debug(first: string | Details, second?: string | Details): void {
    invoke(this.module, "debug", first, second);
  }

  info(details: Details, message: string): void;
  info(message: string, details?: Details): void;
  info(first: string | Details, second?: string | Details): void {
    invoke(this.module, "info", first, second);
  }

  warn(details: Details, message: string): void;
  warn(message: string, details?: Details): void;
  warn(first: string | Details, second?: string | Details): void {
    invoke(this.module, "warn", first, second);
  }

  error(details: Details, message: string): void;
  error(message: string, details?: Details): void;
  error(first: string | Details, second?: string | Details): void {
    invoke(this.module, "error", first, second);
  }

  fatal(details: Details, message: string): void;
  fatal(message: string, details?: Details): void;
  fatal(first: string | Details, second?: string | Details): void {
    invoke(this.module, "fatal", first, second);
  }

  child(context: Partial<OperationContext> & Details): CompatibilityLogger {
    const module = typeof context.module === "string" ? context.module : "legacy";
    return new CompatibilityLogger(module);
  }

  constructor(private readonly module = "legacy") {}

  relay(): RelayLogger {
    return legacyLogger(this.module);
  }
}

export const logger = new CompatibilityLogger();

function invoke(
  module: string,
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal",
  first: string | Details,
  second?: string | Details,
): void {
  const message = typeof first === "string"
    ? first
    : typeof second === "string" ? second : "日志事件";
  const details = typeof first === "object"
    ? first
    : typeof second === "object" ? second : undefined;
  if (level === "error" || level === "fatal") {
    legacyLogger(module)[level](message, undefined, details);
    return;
  }
  legacyLogger(module)[level](message, details);
}
