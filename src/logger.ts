export type LogLevel = "info" | "warn" | "error";

export function logInfo(message: string, details?: Record<string, unknown>): void {
  writeLog("info", message, details);
}

export function logWarn(message: string, details?: Record<string, unknown>): void {
  writeLog("warn", message, details);
}

export function logError(message: string, details?: Record<string, unknown>): void {
  writeLog("error", message, details);
}

function writeLog(level: LogLevel, message: string, details?: Record<string, unknown>): void {
  const suffix = details && Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : "";
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}${suffix}`;
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}
