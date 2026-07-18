import pino, { type Logger as PinoLogger } from "pino";

import { LOG_DIR } from "../config.js";
import { LogStore, type LogStoreOptions } from "./logStore.js";
import { RelayLogger } from "./relayLogger.js";

export interface LoggingRuntimeOptions extends Partial<Omit<LogStoreOptions, "directory">> {
  directory?: string;
  level?: string;
  diagnosticLogger?: PinoLogger;
}

export interface LoggingRuntime {
  store: LogStore;
  logger(module: string): RelayLogger;
  flush(): Promise<void>;
  close(): Promise<void>;
}

let productionRuntime: LoggingRuntime | undefined;

export function getLoggingRuntime(): LoggingRuntime {
  productionRuntime ??= createLoggingRuntime();
  return productionRuntime;
}

export function createLoggingRuntime(options: LoggingRuntimeOptions = {}): LoggingRuntime {
  const store = new LogStore({
    directory: options.directory ?? LOG_DIR,
    retentionDays: options.retentionDays,
    maxTotalBytes: options.maxTotalBytes,
    memoryLimit: options.memoryLimit,
    now: options.now,
    emergencyWrite: options.emergencyWrite,
  });
  const diagnostics = options.diagnosticLogger ?? pino(
    { level: options.level ?? process.env.LOG_LEVEL ?? "info" },
    pino.destination(2),
  );
  const base = new RelayLogger({
    source: "relay",
    module: "relay",
    now: options.now,
    emit: (event) => {
      store.append(event);
      const method = diagnostics[event.level].bind(diagnostics) as (data: object, message: string) => void;
      method({
        source: event.source,
        module: event.module,
        operationId: event.operationId,
        operationName: event.operationName,
        step: event.step,
        stepIndex: event.stepIndex,
        status: event.status,
        durationMs: event.durationMs,
        data: event.data,
        error: event.error,
      }, event.message);
    },
  });
  return {
    store,
    logger: (module) => base.child(module),
    flush: () => store.flush(),
    close: () => store.close(),
  };
}
