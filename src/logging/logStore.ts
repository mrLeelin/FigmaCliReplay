import fs from "node:fs";
import path from "node:path";

import {
  normalizeIncomingLogEvent,
  type LogEvent,
  type LogQuery,
} from "./logEvent.js";
import { fitLogEventToSize } from "./logRedaction.js";

const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const DEFAULT_MEMORY_LIMIT = 10_000;
const MAX_INGEST_EVENTS = 200;
const MAX_INGEST_BYTES = 1024 * 1024;

export interface LogStoreOptions {
  directory: string;
  retentionDays?: number;
  maxTotalBytes?: number;
  memoryLimit?: number;
  now?: () => Date;
  emergencyWrite?: (line: string) => void;
}

export interface LogQueryResult {
  events: LogEvent[];
  nextCursor?: number;
  totalMatched: number;
}

export class LogStore {
  readonly directory: string;

  private readonly retentionDays: number;
  private readonly maxTotalBytes: number;
  private readonly memoryLimit: number;
  private readonly clock: () => Date;
  private readonly customEmergencyWrite?: (line: string) => void;
  private readonly memory: LogEvent[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private ingestSequence = 0;

  constructor(options: LogStoreOptions) {
    this.directory = options.directory;
    this.retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.memoryLimit = options.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
    this.clock = options.now ?? (() => new Date());
    this.customEmergencyWrite = options.emergencyWrite;
  }

  append(event: LogEvent): void {
    try {
      this.appendPrepared(this.prepare(event));
    } catch (error) {
      this.writeEmergency(this.describeFailure(error, event));
    }
  }

  ingest(events: unknown[]): LogEvent[] {
    if (events.length > MAX_INGEST_EVENTS) {
      throw new Error(`log ingest batch exceeds ${MAX_INGEST_EVENTS} events`);
    }
    const serializedBytes = Buffer.byteLength(JSON.stringify(events), "utf8");
    if (serializedBytes > MAX_INGEST_BYTES) {
      throw new Error("log ingest batch exceeds 1 MiB");
    }
    const normalized = events.map((event) => this.prepare(normalizeIncomingLogEvent(event), true));
    for (const event of normalized) {
      this.appendPrepared(event);
    }
    return normalized;
  }

  async query(query: LogQuery): Promise<LogQueryResult> {
    await this.flush();
    const historical = await this.readHistoricalEvents();
    const combined = deduplicateEvents([...historical, ...this.memory]);
    const matched = combined.filter((event) => matchesQuery(event, query));
    matched.sort(compareEvents);
    const cursor = clampInteger(query.cursor, 0, Number.MAX_SAFE_INTEGER, 0);
    const limit = clampInteger(query.limit, 1, 1_000, 1_000);
    const events = matched.slice(cursor, cursor + limit);
    const next = cursor + events.length;
    return {
      events,
      totalMatched: matched.length,
      ...(next < matched.length ? { nextCursor: next } : {}),
    };
  }

  async cleanup(): Promise<void> {
    await this.flush();
    let files: Array<{ path: string; date: Date; size: number }>;
    try {
      files = await this.listLogFiles();
    } catch (error) {
      this.writeEmergency(this.describeFailure(error));
      return;
    }
    const cutoff = this.clock().getTime() - this.retentionDays * 24 * 60 * 60 * 1_000;
    for (const file of files) {
      if (file.date.getTime() < cutoff) {
        await fs.promises.rm(file.path, { force: true });
      }
    }
    files = (await this.listLogFiles()).sort((left, right) => left.date.getTime() - right.date.getTime());
    let totalBytes = files.reduce((total, file) => total + file.size, 0);
    for (const file of files) {
      if (totalBytes <= this.maxTotalBytes) {
        break;
      }
      await fs.promises.rm(file.path, { force: true });
      totalBytes -= file.size;
    }
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private prepare(event: LogEvent, forceIngestionFields = false): LogEvent {
    const now = this.clock().toISOString();
    const sequence = ++this.ingestSequence;
    return fitLogEventToSize({
      ...event,
      ingestedAt: forceIngestionFields || !event.ingestedAt ? now : event.ingestedAt,
      ingestSequence: forceIngestionFields || event.ingestSequence === undefined
        ? sequence
        : event.ingestSequence,
    });
  }

  private appendPrepared(event: LogEvent): void {
    this.memory.push(event);
    if (this.memory.length > this.memoryLimit) {
      this.memory.splice(0, this.memory.length - this.memoryLimit);
    }
    const line = `${JSON.stringify(event)}\n`;
    const filePath = path.join(this.directory, `relay-${event.timestamp.slice(0, 10)}.jsonl`);
    this.writeChain = this.writeChain
      .then(async () => {
        await fs.promises.mkdir(this.directory, { recursive: true });
        await fs.promises.appendFile(filePath, line, "utf8");
      })
      .catch((error) => {
        this.writeEmergency(this.describeFailure(error, event));
      });
  }

  private async readHistoricalEvents(): Promise<LogEvent[]> {
    let fileNames: string[];
    try {
      fileNames = await fs.promises.readdir(this.directory);
    } catch (error) {
      if (isMissingPath(error)) {
        return [];
      }
      this.writeEmergency(this.describeFailure(error));
      return [];
    }
    const events: LogEvent[] = [];
    for (const fileName of fileNames.filter(isRelayLogFile).sort()) {
      try {
        const content = await fs.promises.readFile(path.join(this.directory, fileName), "utf8");
        for (const line of content.split(/\r?\n/)) {
          if (!line.trim()) {
            continue;
          }
          try {
            events.push(normalizeIncomingLogEvent(JSON.parse(line)));
          } catch {
            // A partial or externally edited line must not prevent querying valid history.
          }
        }
      } catch (error) {
        this.writeEmergency(this.describeFailure(error));
      }
    }
    return events;
  }

  private async listLogFiles(): Promise<Array<{ path: string; date: Date; size: number }>> {
    let fileNames: string[];
    try {
      fileNames = await fs.promises.readdir(this.directory);
    } catch (error) {
      if (isMissingPath(error)) {
        return [];
      }
      throw error;
    }
    const files = await Promise.all(fileNames.filter(isRelayLogFile).map(async (fileName) => {
      const filePath = path.join(this.directory, fileName);
      const stats = await fs.promises.stat(filePath);
      return {
        path: filePath,
        date: new Date(`${fileName.slice(6, 16)}T00:00:00.000Z`),
        size: stats.size,
      };
    }));
    return files.filter((file) => Number.isFinite(file.date.getTime()));
  }

  private writeEmergency(line: string): void {
    if (this.customEmergencyWrite) {
      try {
        this.customEmergencyWrite(line);
        return;
      } catch {
        // Continue to the built-in non-recursive fallback.
      }
    }
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      fs.appendFileSync(path.join(this.directory, "emergency.log"), `${line}\n`, "utf8");
    } catch {
      process.stderr.write(`${line}\n`);
    }
  }

  private describeFailure(error: unknown, event?: LogEvent): string {
    const reason = error instanceof Error ? error.message : String(error);
    return JSON.stringify({
      timestamp: this.clock().toISOString(),
      level: "error",
      source: "relay",
      module: "log-store",
      message: "日志持久化失败",
      reason,
      ...(event ? { operationId: event.operationId } : {}),
    });
  }
}

function isRelayLogFile(fileName: string): boolean {
  return /^relay-\d{4}-\d{2}-\d{2}\.jsonl$/.test(fileName);
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function deduplicateEvents(events: LogEvent[]): LogEvent[] {
  const seen = new Set<string>();
  const result: LogEvent[] = [];
  for (const event of events) {
    const key = [
      event.ingestSequence ?? "",
      event.ingestedAt ?? "",
      event.operationId,
      event.source,
      event.stepIndex,
      event.timestamp,
    ].join("|");
    if (!seen.has(key)) {
      seen.add(key);
      result.push(event);
    }
  }
  return result;
}

function matchesQuery(event: LogEvent, query: LogQuery): boolean {
  if (query.from && event.timestamp < query.from) return false;
  if (query.to && event.timestamp > query.to) return false;
  if (query.level && event.level !== query.level) return false;
  if (query.source && event.source !== query.source) return false;
  if (query.module && event.module !== query.module) return false;
  if (query.status && event.status !== query.status) return false;
  if (query.operationId && event.operationId !== query.operationId) return false;
  if (query.keyword) {
    const haystack = `${event.message}\n${JSON.stringify(event.data ?? {})}\n${event.error?.message ?? ""}`.toLowerCase();
    if (!haystack.includes(query.keyword.toLowerCase())) return false;
  }
  return true;
}

function compareEvents(left: LogEvent, right: LogEvent): number {
  const sequenceDifference = (left.ingestSequence ?? Number.MAX_SAFE_INTEGER)
    - (right.ingestSequence ?? Number.MAX_SAFE_INTEGER);
  return sequenceDifference || left.timestamp.localeCompare(right.timestamp);
}

function clampInteger(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Number(value)));
}
