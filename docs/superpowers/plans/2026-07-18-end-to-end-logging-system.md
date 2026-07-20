# End-to-End Logging System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a correlated, searchable, failure-tolerant logging system spanning Node Relay, Figma UI/plugin, Python tasks, and Unity Bridge.

**Architecture:** Each runtime owns one logger class but emits the same structured event contract. Figma plugin logs travel to the UI through `figma.ui.postMessage`, the UI batches both UI and plugin logs over its existing WebSocket/HTTP path, Python writes structured diagnostics to stderr for Node capture, and Unity exposes its local ring buffer for Relay queries. Node Relay assigns ingestion order, redacts again, stores JSONL, and serves filtering/download APIs.

**Tech Stack:** TypeScript 5.8, Node.js 24 built-in test runner, Pino 9, Figma Plugin JavaScript/UI HTML, Python 3 with pytest, Unity Editor C#, JSON Lines.

---

## Execution Constraints

- The current worktree contains user-owned staged and unstaged changes, including a pre-staged `ui.html` and overlapping edits in logging-related files. Do not reset, restore, unstage, or overwrite those changes.
- Do not create implementation commits while a task overlaps user-owned dirty files. Use `git diff --check`, targeted tests, and task checkpoints instead. The suggested Lore commit messages below may be used only after the user-owned changes have been separated or explicitly approved for inclusion.
- `scripts/build_ui.mjs` is referenced by the current dirty `package.json` but does not exist. Do not silently repair or replace that unrelated build-script work. Use `npx tsc -p tsconfig.json` for TypeScript emission and `python scripts/build.py` for the Figma plugin artifact.
- `unity/` is a distributable Editor bridge source tree, not a complete Unity project. Prove source shape with repository tests, then run the final compile in the actual selected Unity project after installing the bridge through the existing installer.
- Read and write all Chinese/non-ASCII files as UTF-8; after every edit, scan for `\uXXXX`, `???`, mojibake, and BOM drift.

## File Structure

### New TypeScript logging units

- `src/logging/logEvent.ts` — shared event/context/query types and runtime validation.
- `src/logging/logRedaction.ts` — recursive sensitive-field masking, payload summarization, and size limits.
- `src/logging/operationScope.ts` — one-operation lifecycle and exactly-one-terminal-state enforcement.
- `src/logging/logStore.ts` — JSONL append queue, memory index, query, rotation, retention, and emergency fallback.
- `src/logging/relayLogger.ts` — Node logger class, module child loggers, protocol stdout, and legacy adapters.
- `src/logging/loggingRuntime.ts` — lazy singleton wiring used by existing module-level imports.

### New runtime logging units

- `code/00_logging.js` — Figma main-thread `PluginLogger`.
- `python/__init__.py` — shared Python package marker.
- `python/relay_logger.py` — `PythonLogger` and protocol-output separation.
- `unity/Assets/Editor/FigmaBridge/BridgeLogger.cs` — Unity logger, operation scope, event, and ring buffer.
- `unity/Assets/Editor/FigmaBridge/BridgeLogger.cs.meta` — Unity asset metadata generated once and preserved.

### New tests

- `tests/log-event.test.mjs`
- `tests/operation-scope.test.mjs`
- `tests/log-store.test.mjs`
- `tests/log-http.test.mjs`
- `tests/log-correlation.test.mjs`
- `tests/logging-coverage.test.mjs`
- `tests/figma-logging.test.mjs`
- `tests/test_python_logger.py`
- `tests/unity-bridge-logging.test.mjs`

## Task 1: Establish the TypeScript Event Contract and Redaction Boundary

**Files:**

- Create: `src/logging/logEvent.ts`
- Create: `src/logging/logRedaction.ts`
- Create: `tests/log-event.test.mjs`

- [ ] **Step 1: Write the failing contract and redaction tests**

Create `tests/log-event.test.mjs` with focused behavior tests:

```javascript
import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeIncomingLogEvent,
  redactLogData,
} from "../dist/logging/logEvent.js";

test("normalizes a cross-runtime event without changing its operation id", () => {
  const event = normalizeIncomingLogEvent({
    timestamp: "2026-07-18T10:00:00.000Z",
    level: "info",
    source: "plugin",
    module: "cleanup",
    operationId: "op-123",
    operationName: "cleanup",
    step: "execute",
    stepIndex: 2,
    status: "progress",
    message: "Applying cleanup plan",
    data: { operationCount: 3 },
  });

  assert.equal(event.operationId, "op-123");
  assert.equal(event.source, "plugin");
  assert.equal(event.stepIndex, 2);
});

test("rejects malformed events at the ingestion boundary", () => {
  assert.throws(
    () => normalizeIncomingLogEvent({ level: "verbose", message: "bad" }),
    /invalid log event/i,
  );
});

test("redacts credentials and summarizes oversized binary payloads", () => {
  const redacted = redactLogData({
    authorization: "Bearer secret-token",
    apiKey: "sk-secret",
    nested: { password: "hunter2" },
    pngBase64: "A".repeat(10_000),
  });

  assert.equal(redacted.authorization, "[REDACTED]");
  assert.equal(redacted.apiKey, "[REDACTED]");
  assert.equal(redacted.nested.password, "[REDACTED]");
  assert.deepEqual(redacted.pngBase64, {
    kind: "large-payload",
    chars: 10_000,
    truncated: true,
  });
});
```

- [ ] **Step 2: Run the test and verify the RED state**

Run:

```powershell
node --test tests/log-event.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `dist/logging/logEvent.js`.

- [ ] **Step 3: Implement the event types and validator**

In `src/logging/logEvent.ts`, define the exact runtime contract:

```typescript
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
```

Implement `normalizeIncomingLogEvent(value: unknown): LogEvent` using explicit record/string/number checks. Reject unknown levels, sources, statuses, missing IDs, negative/non-integer `stepIndex`, and invalid timestamps with field-specific errors such as `new Error("invalid log event: operationId")`. Do not silently invent missing cross-runtime correlation fields.

- [ ] **Step 4: Implement recursive redaction and payload limits**

In `src/logging/logRedaction.ts`, export:

```typescript
export const MAX_LOG_EVENT_BYTES = 64 * 1024;
export const MAX_INLINE_TEXT_CHARS = 4_096;

export function redactLogData(value: unknown): unknown;
export function fitLogEventToSize(event: LogEvent): LogEvent;
```

Use a case-insensitive sensitive-key set containing `password`, `token`, `authorization`, `cookie`, `apiKey`, `secret`, `clientSecret`, and `accessToken`. Replace sensitive values with `[REDACTED]`. Replace Base64/image/byte fields over `MAX_INLINE_TEXT_CHARS` with `{ kind: "large-payload", chars, truncated: true }`. Track visited objects with `WeakSet` and replace cycles with `[Circular]`. If the serialized event still exceeds 64 KiB, replace `data` with `{ truncated: true, originalBytes }` while retaining operation fields and `error`.

Re-export `redactLogData` from `logEvent.ts` so the test import remains stable.

- [ ] **Step 5: Compile and verify GREEN**

Run:

```powershell
npx tsc -p tsconfig.json
node --test tests/log-event.test.mjs
```

Expected: TypeScript emits successfully and all three tests PASS.

- [ ] **Step 6: Checkpoint the task without disturbing existing staging**

Run:

```powershell
git diff --check -- src/logging/logEvent.ts src/logging/logRedaction.ts tests/log-event.test.mjs
git status --short -- src/logging/logEvent.ts src/logging/logRedaction.ts tests/log-event.test.mjs
```

Expected: no whitespace errors; only the three task files are listed. Do not commit while overlapping user-owned work remains. Suggested future Lore intent: `Make every runtime speak one safe diagnostic event contract`.

## Task 2: Implement RelayLogger and Exactly-One-Terminal OperationScope

**Files:**

- Create: `src/logging/operationScope.ts`
- Create: `src/logging/relayLogger.ts`
- Test: `tests/operation-scope.test.mjs`

- [ ] **Step 1: Write failing operation lifecycle tests**

Create `tests/operation-scope.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";

import { RelayLogger } from "../dist/logging/relayLogger.js";

test("operation emits start, ordered steps, and one success terminal", () => {
  const events = [];
  const logger = new RelayLogger({ module: "test", emit: (event) => events.push(event), now: fakeClock() });
  const operation = logger.startOperation("cleanup", { operationId: "op-1" });
  operation.step("planning", { nodes: 5 });
  operation.succeed({ operations: 2 });

  assert.deepEqual(events.map((event) => event.status), ["started", "progress", "succeeded"]);
  assert.deepEqual(events.map((event) => event.stepIndex), [0, 1, 2]);
  assert.ok(events[2].durationMs >= 0);
});

test("second terminal call is ignored and emits an internal warning", () => {
  const events = [];
  const logger = new RelayLogger({ module: "test", emit: (event) => events.push(event), now: fakeClock() });
  const operation = logger.startOperation("import", { operationId: "op-2" });
  operation.fail(new Error("boom"));
  operation.succeed();

  assert.equal(events.filter((event) => ["failed", "succeeded", "cancelled"].includes(event.status)).length, 1);
  assert.match(events.at(-1).message, /already completed/i);
});

function fakeClock() {
  let value = Date.parse("2026-07-18T10:00:00.000Z");
  return () => new Date(value += 5);
}
```

- [ ] **Step 2: Verify RED**

Run `node --test tests/operation-scope.test.mjs`.

Expected: FAIL because `RelayLogger` does not exist.

- [ ] **Step 3: Implement RelayLogger**

`RelayLogger` must accept injected `emit`, `now`, and `idFactory` functions for real behavior tests without global mocks:

```typescript
export interface RelayLoggerOptions {
  module: string;
  source?: LogSource;
  emit: (event: LogEvent) => void;
  now?: () => Date;
  idFactory?: () => string;
  protocolWrite?: (line: string) => void;
}

export class RelayLogger {
  child(module: string): RelayLogger;
  startOperation(name: string, context?: Partial<OperationContext>): OperationScope;
  trace(message: string, data?: Record<string, unknown>, context?: Partial<OperationContext>): void;
  debug(message: string, data?: Record<string, unknown>, context?: Partial<OperationContext>): void;
  info(message: string, data?: Record<string, unknown>, context?: Partial<OperationContext>): void;
  warn(message: string, data?: Record<string, unknown>, context?: Partial<OperationContext>): void;
  error(message: string, error?: unknown, data?: Record<string, unknown>, context?: Partial<OperationContext>): void;
  fatal(message: string, error?: unknown, data?: Record<string, unknown>, context?: Partial<OperationContext>): void;
  writeProtocolOutput(payload: unknown): void;
}
```

Use `randomUUID()` as the production ID factory. Diagnostic console output must go to stderr; `writeProtocolOutput` is the only method that writes machine-readable JSON to stdout.

- [ ] **Step 4: Implement OperationScope**

`OperationScope` stores the immutable context, start time, current `stepIndex`, and terminal flag. `step()` increments the index. `succeed()`, `fail()`, and `cancel()` increment once and set the terminal flag. `fail()` normalizes unknown thrown values to `{ message }`, preserving `name`, `code`, and `stack` when available. A repeated terminal call emits a `warn/progress` internal event and does not emit another terminal event.

Expose a read-only `completed` getter so transport wrappers can avoid issuing a second terminal event after a catch path has already failed the operation.

- [ ] **Step 5: Preserve the injection seam needed by later tasks**

Keep `RelayLogger` independent of filesystem and global process state except for its default clock/ID/protocol writers. Its constructor must always accept an `emit` function, and `child(module)` must reuse the same emitter, clock, ID factory, and protocol writer while changing only the module name. This lets Task 3 connect the logger to `LogStore` without rewriting the lifecycle class.

- [ ] **Step 6: Compile and verify GREEN**

Run:

```powershell
npx tsc -p tsconfig.json
node --test tests/operation-scope.test.mjs
```

Expected: operation lifecycle tests PASS; existing logging callers remain untouched in this task.

- [ ] **Step 7: UTF-8 and direct-output audit**

Run:

```powershell
rg -n "\\u[0-9a-fA-F]{4}|\?\?\?|鏃ュ織|閿欒" src/logging tests/operation-scope.test.mjs
git diff --check -- src/logging tests/operation-scope.test.mjs
```

Expected: no encoding-corruption matches and no whitespace errors. Suggested future Lore intent: `Make operation lifecycles reconstructable without changing legacy callers`.

## Task 3: Add JSONL LogStore, Querying, Rotation, and Emergency Fallback

**Files:**

- Create: `src/logging/logStore.ts`
- Create: `src/logging/loggingRuntime.ts`
- Modify: `src/utils/logger.ts`
- Create: `tests/log-store.test.mjs`

- [ ] **Step 1: Write failing persistence, query, retention, and fallback tests**

Create tests using real temporary directories and real filesystem writes. Cover these exact behaviors:

```javascript
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LogStore } from "../dist/logging/logStore.js";

function makeEvent(overrides = {}) {
  return {
    timestamp: "2026-07-18T10:00:00.000Z",
    level: "info",
    source: "relay",
    module: "test",
    operationId: "op-default",
    operationName: "test-operation",
    step: "run",
    stepIndex: 1,
    status: "progress",
    message: "message",
    ...overrides,
  };
}

test("appends JSONL and queries by operation, source, level, and keyword", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-relay-logs-"));
  try {
    const store = new LogStore({ directory: root });
    store.append(makeEvent({ operationId: "op-a", source: "relay", level: "info", message: "started" }));
    store.append(makeEvent({ operationId: "op-a", source: "plugin", level: "error", message: "node failed" }));
    store.append(makeEvent({ operationId: "op-b", source: "unity", level: "info", message: "unrelated" }));
    await store.flush();

    const result = await store.query({ operationId: "op-a", level: "error", keyword: "failed", limit: 100 });
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].source, "plugin");
    await store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("deletes files older than 14 days before enforcing 200 MB total", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-relay-retention-"));
  try {
    fs.writeFileSync(path.join(root, "relay-2026-06-30.jsonl"), "x".repeat(40));
    fs.writeFileSync(path.join(root, "relay-2026-07-10.jsonl"), "y".repeat(80));
    fs.writeFileSync(path.join(root, "relay-2026-07-17.jsonl"), "z".repeat(80));
    const store = new LogStore({
      directory: root,
      retentionDays: 14,
      maxTotalBytes: 100,
      now: () => new Date("2026-07-18T10:00:00.000Z"),
    });
    await store.cleanup();
    assert.equal(fs.existsSync(path.join(root, "relay-2026-06-30.jsonl")), false);
    assert.equal(fs.existsSync(path.join(root, "relay-2026-07-10.jsonl")), false);
    assert.equal(fs.existsSync(path.join(root, "relay-2026-07-17.jsonl")), true);
    await store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("uses emergency sink and never throws when the primary append fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-relay-fallback-"));
  try {
    const blocker = path.join(root, "blocker");
    fs.writeFileSync(blocker, "not-a-directory");
    const emergency = [];
    const store = new LogStore({
      directory: path.join(blocker, "logs"),
      emergencyWrite: (line) => emergency.push(line),
    });
    assert.doesNotThrow(() => store.append(makeEvent({ level: "error" })));
    await store.flush();
    assert.equal(emergency.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Verify RED**

Run `node --test tests/log-store.test.mjs`.

Expected: FAIL because `LogStore` does not exist.

- [ ] **Step 3: Implement LogStore**

Expose:

```typescript
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
  append(event: LogEvent): void;
  ingest(events: unknown[]): LogEvent[];
  query(query: LogQuery): Promise<LogQueryResult>;
  cleanup(): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}
```

Requirements:

- Store path is `.logs/relay-YYYY-MM-DD.jsonl` using the UTC date.
- `append()` redacts and size-fits before inserting into the memory ring immediately.
- File writes run through one promise chain to preserve order without blocking the business call.
- `ingest()` validates every event, assigns `ingestedAt` and a monotonic `ingestSequence`, and rejects batches over 200 events or 1 MiB serialized size.
- `query()` filters historical JSONL plus memory entries without duplicates, sorts by `ingestSequence` then timestamp, clamps `limit` to 1–1,000, and returns a numeric cursor.
- `cleanup()` deletes files older than 14 days, then oldest remaining files until total size is at most 200 MiB.
- Primary write failures call the non-recursive emergency writer; the emergency writer first appends to `.logs/emergency.log`, then uses `process.stderr.write` if that append also fails.

- [ ] **Step 4: Connect LogStore to the production runtime**

In `src/logging/loggingRuntime.ts`, create the production singleton lazily so imports do not create files before the application uses logging:

```typescript
export interface LoggingRuntime {
  store: LogStore;
  logger(module: string): RelayLogger;
  flush(): Promise<void>;
}

export function getLoggingRuntime(): LoggingRuntime;
export function createLoggingRuntime(options: LoggingRuntimeOptions): LoggingRuntime;
```

`createLoggingRuntime()` creates one `LogStore`, sends each `RelayLogger` event to the store, and mirrors human-readable diagnostics to stderr through Pino. Do not configure a second Pino file transport; `LogStore` is the only persistent JSONL owner.

Rewrite `src/utils/logger.ts` as a compatibility facade. Keep the current public names `logger`, `createLogger`, `logTrace`, `logDebug`, `logInfo`, `logWarn`, `logError`, and `logFatal`, but forward every call to `getLoggingRuntime().logger("legacy")`. Preserve the existing `(message, details?)` signatures. Remove unused direct filesystem imports from this compatibility file. Do not restore deleted `src/logger.ts`.

- [ ] **Step 5: Verify GREEN**

Run:

```powershell
npx tsc -p tsconfig.json
node --test tests/log-event.test.mjs tests/operation-scope.test.mjs tests/log-store.test.mjs tests/ai-planning-providers.test.mjs tests/cli-planning-transport.test.mjs
```

Expected: all tests PASS, temporary directories are removed in test cleanup, and existing logger callers compile through the compatibility facade.

- [ ] **Step 6: Checkpoint**

Run `git diff --check -- src/logging tests/log-store.test.mjs`. Suggested future Lore intent: `Keep diagnostic history queryable without letting logging failures break work`.

## Task 4: Add HTTP Operation Context, Ingestion, Query, Timeline, and Download APIs

**Files:**

- Modify: `src/httpServer.ts`
- Modify: `src/index.ts`
- Modify: `src/utils.ts`
- Create: `tests/log-http.test.mjs`

- [ ] **Step 1: Write failing HTTP behavior tests**

Use a real temporary HTTP server and injected `LoggingRuntime`. Add tests for:

```javascript
test("HTTP requests receive a stable operation id and terminal request log", async () => {
  const response = await fetch(`${baseUrl}/health`, { headers: { "x-operation-id": "op-http" } });
  assert.equal(response.headers.get("x-operation-id"), "op-http");
  await logging.flush();
  const timeline = await logging.store.query({ operationId: "op-http" });
  assert.deepEqual(timeline.events.map((event) => event.status), ["started", "succeeded"]);
});

test("POST /logs/events ingests a local batch and GET /logs filters it", async () => {
  const posted = await fetch(`${baseUrl}/logs/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-figma-mcp-relay-internal": "plugin-runtime" },
    body: JSON.stringify({ events: [pluginEvent] }),
  });
  assert.equal(posted.status, 202);
  const queried = await fetch(`${baseUrl}/logs?operationId=op-plugin&source=plugin&limit=50`);
  assert.equal((await queried.json()).events.length, 1);
});

test("legacy GET /log returns real logs instead of a fixed empty array", async () => {
  const response = await fetch(`${baseUrl}/log?operationId=op-plugin`);
  assert.equal((await response.json()).logs.length, 1);
});
```

Also test `/logs/operations/op-plugin`, invalid query level `400`, and download response headers.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npx tsc -p tsconfig.json
node --test tests/log-http.test.mjs
```

Expected: FAIL because `/logs` routes are missing and `/log` returns an empty array.

- [ ] **Step 3: Add request operation context**

In `src/utils.ts`, add:

```typescript
export const OPERATION_ID_HEADER = "x-operation-id";

export function requestOperationId(request: IncomingMessage): string {
  const header = request.headers[OPERATION_ID_HEADER];
  const candidate = Array.isArray(header) ? header[0] : header;
  return typeof candidate === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)
    ? candidate
    : randomUUID();
}
```

In `createRelayHttpServer`, start an `http.request` scope before routing, set `X-Operation-Id` on the response, and terminalize on `finish`. Statuses below 400 succeed; 4xx/5xx fail with status data. The catch block calls `scope.fail(error)` before sending the 500 response, and the `finish` listener first checks `scope.completed` so it never emits a second terminal event.

- [ ] **Step 4: Add log routes**

Inject `LoggingRuntime` as the final optional argument of `createRelayHttpServer`, defaulting to `getLoggingRuntime()` so existing callers remain source-compatible. Add:

- `POST /logs/events` with existing local/internal request checks, `{ events: unknown[] }`, and `202 { accepted }`.
- `GET /logs` with validated query parameters.
- `GET /logs/operations/:operationId` as an operation-filtered query.
- `GET /logs/download` as UTF-8 JSONL attachment with a timestamped filename.
- `GET /log` compatibility response `{ logs: events }`.

Do not return unredacted raw files.

- [ ] **Step 5: Flush on process shutdown**

In `src/index.ts`, create/get the logging runtime before constructing gateways. During `SIGINT`/`SIGTERM`, log shutdown start, await `logging.flush()`, then close the server. Route startup JSON through `writeProtocolOutput` rather than direct `console.log`.

- [ ] **Step 6: Verify GREEN**

Run:

```powershell
npx tsc -p tsconfig.json
node --test tests/log-http.test.mjs tests/unity-project-http.test.mjs tests/cleanup-http.test.mjs
```

Expected: all targeted tests PASS; legacy APIs remain compatible.

- [ ] **Step 7: Checkpoint**

Run `git diff --check -- src/httpServer.ts src/index.ts src/utils.ts tests/log-http.test.mjs`. Suggested future Lore intent: `Expose one safe timeline for every local Relay request`.

## Task 5: Propagate Correlation Through Relay Jobs, MCP, and the UI-Owned WebSocket

**Files:**

- Modify: `src/types.ts`
- Modify: `src/runtimeRelay.ts`
- Modify: `src/websocketGateway.ts`
- Modify: `src/mcpServer.ts`
- Create: `tests/log-correlation.test.mjs`

- [ ] **Step 1: Write failing correlation tests**

Test real job envelopes and logger events:

```javascript
test("relay job keeps one operation id through dispatch, acknowledgement, and result", async () => {
  const result = relay.submitJob({
    requestId: "req-1",
    operationId: "op-relay",
    job: { type: "TEST_JOB" },
  });
  assert.equal(result.operationId, "op-relay");
  assert.equal(gateway.sent[0].operationId, "op-relay");

  gateway.receive({ type: "command.received", id: "req-1", operationId: "op-relay" });
  gateway.receive({ type: "command.response", id: "req-1", operationId: "op-relay", result: { ok: true } });
  await logging.flush();
  const timeline = await logging.store.query({ operationId: "op-relay" });
  assert.ok(timeline.events.some((event) => event.step === "plugin-acknowledged"));
  assert.ok(timeline.events.some((event) => event.status === "succeeded"));
});
```

Add a second test proving a missing inbound `operationId` falls back to the request ID for legacy clients, and a third proving `log.events` WebSocket batches are ingested without entering the job queue.

- [ ] **Step 2: Verify RED**

Run `npx tsc -p tsconfig.json; node --test tests/log-correlation.test.mjs`.

Expected: FAIL because job and command interfaces do not contain `operationId` and `log.events` is unknown.

- [ ] **Step 3: Extend transport contracts**

Add `operationId: string` to `RelayJob` and `PluginCommand`. Include it in `RuntimeRelay.submitJob()` responses, polling payloads, WebSocket sends, acknowledgements, and results. Resolve it as:

```typescript
const operationId = validOperationId(payload.operationId)
  ? payload.operationId
  : requestId;
```

Do not generate a new ID at each hop.

- [ ] **Step 4: Instrument the Relay job lifecycle**

Start a `relay.job` operation when submitting. Record steps `queued`, `websocket-dispatched` or `polling-leased`, `plugin-acknowledged`, `result-received`, and terminal `succeeded/failed/cancelled/expired`. Store the scope or sufficient operation context on `RelayJob`; never infer completion only from `command.response accepted`.

- [ ] **Step 5: Ingest UI/plugin WebSocket log batches**

Teach `WebSocketGateway.handleMessage()` to accept:

```json
{
  "type": "log.events",
  "events": ["<validated LogEvent>"]
}
```

Inject an ingestion callback into the gateway constructor. Reject unauthenticated batches, cap them through `LogStore.ingest`, and log only a batch summary to avoid recursion.

- [ ] **Step 6: Carry operation IDs through MCP tool calls**

In `mcpServer.ts`, resolve `operationId` from request metadata when present, otherwise use a stable value derived from the MCP session and JSON-RPC ID. Start `mcp.tool` scopes around handlers and pass the ID to `relay.submitJob()`.

- [ ] **Step 7: Verify GREEN**

Run:

```powershell
npx tsc -p tsconfig.json
node --test tests/log-correlation.test.mjs tests/runtime-relay-health.test.mjs tests/cleanup-transaction.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 8: Checkpoint**

Run `git diff --check -- src/types.ts src/runtimeRelay.ts src/websocketGateway.ts src/mcpServer.ts tests/log-correlation.test.mjs`. Suggested future Lore intent: `Preserve one diagnostic identity across every Relay transport hop`.

## Task 6: Cover Node Business Operations and Python Process Boundaries

**Files:**

- Modify: `src/cleanup/cleanupController.ts`
- Modify: `src/cleanup/cleanupExecutor.ts`
- Modify: `src/cleanup/cleanupRunStore.ts`
- Modify: `src/cleanup/cleanupRuntime.ts`
- Modify: `src/cleanup/cleanupPlanner.ts`
- Modify: `src/cleanupPlan.ts`
- Modify: `src/ai/providerRegistry.ts`
- Modify: `src/ai/cliPlanningTransport.ts`
- Modify: `src/ai/claudeCodeCliProvider.ts`
- Modify: `src/ai/codexCliProvider.ts`
- Modify: `src/localAiRunner.ts`
- Modify: `src/psdImportTask.ts`
- Modify: `src/pythonWorker.ts`
- Modify: `src/mcpConfig.ts`
- Modify: `src/unityProjectRegistry.ts`
- Modify: `src/unityGatewayDiscovery.ts`
- Modify: `src/unityBridgeInstaller.ts`
- Create: `tests/logging-coverage.test.mjs`

- [ ] **Step 1: Write the failing coverage guard**

Create a test that reads the listed runtime files and asserts:

- No diagnostic `console.log/info/warn/error/debug` exists in `src/`; `writeProtocolOutput` is the explicit protocol exception.
- Every operation-owner file imports `getLoggingRuntime`, `RelayLogger`, or the compatibility facade.
- Required step names are present: cleanup `planning/approval/execution/rollback/verification`, AI `provider-probe/cli-spawn/cli-exit/timeout/cancel`, PSD `queued/export/submit/result`, Unity `discover/install/connect`, and config `read/write/delete/open`.

The test must use an explicit file manifest rather than scanning type-only files such as `cleanupTypes.ts`.

- [ ] **Step 2: Verify RED**

Run `node --test tests/logging-coverage.test.mjs`.

Expected: FAIL listing operation-owner files that do not yet import the logger and direct output in `src/index.ts`/`src/config.ts`.

- [ ] **Step 3: Instrument cleanup lifecycle**

Use the cleanup run ID as the `operationId`. `cleanupController.start()` emits planning start and result; `approve()` emits approval; executor emits transaction submission, Figma acceptance, final result, verification, rollback, failure, or cancellation. `CleanupRunStore` logs state transitions only, not every poll/read. Preserve the current planning/timeout behavior and existing error messages.

- [ ] **Step 4: Instrument provider and CLI lifecycle**

Use the local AI run ID as the operation ID. Record provider probe start/result, selected provider, executable and safe arguments, spawn success, exit code, timeout, cancellation, and output byte counts. Never log prompts, environment secrets, or full stdout/stderr. The logger records summaries; user-visible streaming output remains in existing run state.

- [ ] **Step 5: Capture structured Python stderr**

In `psdImportTask.runPythonScript()` and Python worker process handling, pass `FIGMA_RELAY_OPERATION_ID` and `FIGMA_RELAY_OPERATION_NAME` in the child environment. Parse stderr line-by-line: lines with the Python logger marker become ingested `LogEvent`s; other lines become redacted `python.stderr` warning summaries. Keep stdout exclusively for the existing command/protocol result.

- [ ] **Step 6: Instrument Unity project and configuration operations**

Record `discover/install/connect/read/write/delete/open` starts and terminal results with project ID/path summaries, destination paths, elapsed time, and errors. Redact home-directory details where not needed and never log config file secrets.

- [ ] **Step 7: Route CLI protocol output through the logger**

Replace direct output in `src/index.ts` and `src/config.ts` with `writeProtocolOutput`. Do not convert protocol JSON into diagnostic events.

- [ ] **Step 8: Verify GREEN and regression coverage**

Run:

```powershell
npx tsc -p tsconfig.json
node --test tests/logging-coverage.test.mjs tests/cleanup-controller.test.mjs tests/cleanup-executor.test.mjs tests/ai-planning-providers.test.mjs tests/cli-planning-transport.test.mjs tests/local-ai-runner-lifecycle.test.mjs tests/unity-project-registry.test.mjs tests/unity-bridge-installer.test.mjs
```

Expected: all targeted tests PASS.

- [ ] **Step 9: Checkpoint**

Run `git diff --check` on the files listed in this task. Suggested future Lore intent: `Make every Node-owned operation report its decisive boundaries`.

## Task 7: Implement PluginLogger and UiLogger on the Existing Figma Transport

**Files:**

- Create: `code/00_logging.js`
- Modify: `scripts/build.py`
- Modify: `code/00_init.js`
- Modify: `code/01_handlers.js`
- Modify: `code/04_hierarchy.js`
- Modify: `code/05_utils.js`
- Modify: `ui.html`
- Create: `tests/figma-logging.test.mjs`

- [ ] **Step 1: Write failing source/runtime tests**

Create `tests/figma-logging.test.mjs` that:

- Extracts and evaluates `PluginLogger` with a fake `figma.ui.postMessage`.
- Asserts a plugin event has `source: "plugin"`, preserves supplied `operationId`, and posts `{ type: "LOG_EVENT", event }`.
- Extracts/evaluates `UiLogger`, asserts it renders entries, caps the queue, and prioritizes errors when full.
- Asserts `scripts/build.py` places `00_logging.js` before `00_init.js`.
- Asserts diagnostic `console.*` no longer appears outside the logger class emergency sink.
- Asserts the UI WebSocket sends `log.events` batches and receives plugin `LOG_EVENT` messages.

- [ ] **Step 2: Verify RED**

Run `node --test tests/figma-logging.test.mjs`.

Expected: FAIL because the two logger classes and batch protocol do not exist.

- [ ] **Step 3: Implement PluginLogger**

Create `code/00_logging.js` with no module syntax because `scripts/build.py` concatenates fragments:

```javascript
class PluginOperationScope {
  constructor(logger, name, context) {
    this.logger = logger;
    this.context = {
      operationId: context.operationId || logger.idFactory(),
      operationName: name,
      module: context.module || logger.module,
    };
    this.startedAt = logger.clock();
    this.stepIndex = 0;
    this.terminal = false;
    logger.emit("info", "started", "started", "Operation started", {}, this.context, this.stepIndex);
  }

  step(step, data) {
    if (this.terminal) return;
    this.stepIndex += 1;
    this.logger.emit("info", "progress", step, step, data || {}, this.context, this.stepIndex);
  }

  succeed(data) {
    this.finish("info", "succeeded", "completed", "Operation succeeded", null, data || {});
  }

  fail(error, data) {
    this.finish("error", "failed", "failed", "Operation failed", error, data || {});
  }

  cancel(reason) {
    this.finish("warn", "cancelled", "cancelled", reason || "Operation cancelled", null, {});
  }

  finish(level, status, step, message, error, data) {
    if (this.terminal) {
      this.logger.emit("warn", "progress", "already-completed", "Operation already completed", {}, this.context, this.stepIndex);
      return;
    }
    this.terminal = true;
    this.stepIndex += 1;
    this.logger.emit(level, status, step, message, data, this.context, this.stepIndex, error, this.logger.clock() - this.startedAt);
  }
}

class PluginLogger {
  constructor(options) {
    this.module = options.module || "figma-plugin";
    this.clock = options.clock || Date.now;
    this.idFactory = options.idFactory || function () {
      return "plugin-" + Date.now() + "-" + Math.random().toString(16).slice(2);
    };
    this.postEvent = options.postEvent;
  }

  startOperation(name, context) {
    return new PluginOperationScope(this, name, context || {});
  }

  trace(message, data, context) { this.log("trace", message, data, context); }
  debug(message, data, context) { this.log("debug", message, data, context); }
  info(message, data, context) { this.log("info", message, data, context); }
  warn(message, data, context) { this.log("warn", message, data, context); }

  error(message, error, data, context) {
    this.emit("error", "failed", "diagnostic", message, data || {}, context || {}, 0, error);
  }

  log(level, message, data, context) {
    this.emit(level, "progress", "diagnostic", message, data || {}, context || {}, 0);
  }

  emit(level, status, step, message, data, context, stepIndex, error, durationMs) {
    var event = {
      timestamp: new Date(this.clock()).toISOString(),
      level: level,
      source: "plugin",
      module: context.module || this.module,
      operationId: context.operationId || this.idFactory(),
      operationName: context.operationName || "diagnostic",
      step: step,
      stepIndex: stepIndex,
      status: status,
      message: String(message || ""),
      data: redactPluginLogData(data || {}),
    };
    if (durationMs !== undefined) event.durationMs = durationMs;
    if (error) {
      event.error = {
        name: error && error.name ? String(error.name) : "Error",
        message: error && error.message ? String(error.message) : String(error),
        stack: error && error.stack ? String(error.stack) : undefined,
      };
    }
    try {
      this.postEvent(event);
    } catch (postError) {
      try { console.error("[PluginLogger emergency]", postError); } catch (_) {}
    }
  }
}

function redactPluginLogData(value) {
  var sensitive = /password|token|authorization|cookie|api.?key|secret/i;
  var result = {};
  Object.keys(value || {}).forEach(function (key) {
    var item = value[key];
    if (sensitive.test(key)) {
      result[key] = "[REDACTED]";
    } else if (typeof item === "string" && item.length > 4096) {
      result[key] = { kind: "large-payload", chars: item.length, truncated: true };
    } else {
      result[key] = item;
    }
  });
  return result;
}

var pluginLogger = new PluginLogger({
  postEvent: function (event) {
    figma.ui.postMessage({ type: "LOG_EVENT", event: event });
  }
});
```

The class must apply the same field names and basic redaction. Its only direct console call may be an internal emergency fallback inside a guarded `try/catch`.

- [ ] **Step 4: Put logger code before plugin initialization**

Insert `"00_logging.js"` immediately before `"00_init.js"` in `scripts/build.py` `ORDER`. Do not change unrelated prompt or version build logic.

- [ ] **Step 5: Wrap plugin command dispatch**

In `code/00_init.js`, read `message.operationId || message.requestId`, start a plugin operation before invoking the handler, add a handler step, and terminalize on result/error. Include `operationId` in every response posted back to UI. Replace direct console diagnostics in the listed code fragments with `pluginLogger` calls.

- [ ] **Step 6: Implement UiLogger and compatibility rendering**

Define `class UiLogger` once near the start of the existing UI script. It owns:

- A maximum 1,000-event queue and byte cap.
- `startOperation`, step, success, fail, cancel, and level methods.
- Existing bottom-panel rendering.
- Batched WebSocket/HTTP submission.
- Plugin `LOG_EVENT` ingestion.

Keep `appendLog(message, isError)` as a compatibility function, but make it call `uiLogger.error()` or `uiLogger.info()`; it must not write `logEl` directly. This safely migrates the many existing UI call sites while key operations receive explicit scopes.

- [ ] **Step 7: Add operation IDs to UI commands and WebSocket results**

For PSD import, cleanup, AI execution, prefab import/export, Unity sync, and configuration actions, start a UI operation and pass its `operationId` through `parent.postMessage`, WebSocket job messages, HTTP `X-Operation-Id`, acknowledgements, and results. Do not reuse one global ID for concurrent operations.

- [ ] **Step 8: Verify GREEN and build the plugin artifact**

Run:

```powershell
node --test tests/figma-logging.test.mjs tests/figma-ui-initialization.test.mjs tests/cleanup-plan-ui.test.mjs tests/psd-incremental-ui.test.mjs
python scripts/build.py
node --check code.js
```

Expected: tests PASS, build lists `00_logging.js` before `00_init.js`, and generated `code.js` parses.

- [ ] **Step 9: Verify generated-source consistency and encoding**

Run:

```powershell
rg -n "\\u[0-9a-fA-F]{4}|\?\?\?|鏃ュ織|閿欒" code ui.html code.js
git diff --check -- code scripts/build.py code.js ui.html tests/figma-logging.test.mjs .build_version
```

Expected: no encoding corruption and no patch whitespace errors. Do not commit `ui.html` or `code.js` while they still include user-owned overlapping changes. Suggested future Lore intent: `Keep Figma-side failures correlated through the UI-owned socket`.

## Task 8: Build the Searchable Figma UI Log Viewer and Diagnostic Download

**Files:**

- Modify: `ui.html`
- Modify: `tests/figma-logging.test.mjs`
- Modify: `tests/settings-tab-ui.test.mjs`

- [ ] **Step 1: Add failing UI contract assertions**

Assert the log section contains:

- Level/source/module filters.
- Keyword and `operationId` inputs.
- Timeline list and expandable JSON/error details.
- Copy-operation-ID and download buttons.
- Pagination/load-more control.

Evaluate the query builder and verify it encodes filters into `/logs`, clamps limit to 1,000, and uses `/logs/download` for downloads.

- [ ] **Step 2: Verify RED**

Run `node --test tests/figma-logging.test.mjs tests/settings-tab-ui.test.mjs`.

Expected: FAIL because filter controls and query helpers are missing.

- [ ] **Step 3: Replace the plain text panel with a structured viewer**

Preserve the existing `#log` element as the compatibility summary, then add semantic controls and a list. Render only text through `textContent`; never inject log messages with `innerHTML`. Display newest first in summary view, but operation timeline view in causal/ingestion order.

- [ ] **Step 4: Implement query, timeline, copy, download, and pagination actions**

Use local Relay URL resolution already present in `ui.html`. `GET /logs/operations/{operationId}` drives timeline view. Download uses `fetch`, `Blob`, and a temporary anchor. Failed queries are logged through `UiLogger` without recursively retrying.

- [ ] **Step 5: Verify GREEN**

Run:

```powershell
node --test tests/figma-logging.test.mjs tests/settings-tab-ui.test.mjs tests/figma-ui-initialization.test.mjs
python scripts/build.py
```

Expected: all tests PASS and prompt synchronization remains unchanged.

- [ ] **Step 6: Checkpoint**

Run `git diff --check -- ui.html tests/figma-logging.test.mjs tests/settings-tab-ui.test.mjs`. Suggested future Lore intent: `Let operators find one failure without reading raw console streams`.

## Task 9: Implement the Shared PythonLogger and Protocol Separation

**Files:**

- Create: `python/__init__.py`
- Create: `python/relay_logger.py`
- Modify: `server/figma_mcp_relay_server.py`
- Modify: `server/figma_mcp_companion.py`
- Modify: `client/figma_mcp_client.py`
- Modify: `ai/skills/psd-layer-to-figma/scripts/export_psd_layers.py`
- Modify: `ai/skills/psd-layer-to-figma/scripts/submit_psd_import_job.py`
- Modify: `ai/skills/figma-hierarchy-cleanup-mcp/scripts/run_cleanup_pipeline.py`
- Modify: `ai/skills/figma-hierarchy-cleanup-mcp/scripts/apply_cleanup_plan.py`
- Modify: `ai/skills/figma-to-prefab/scripts/run_full_import.py`
- Modify: `ai/skills/prefab-to-figma/scripts/prefab_to_figma.py`
- Create: `tests/test_python_logger.py`

- [ ] **Step 1: Write failing Python tests**

Create `tests/test_python_logger.py`:

```python
import io
import json

from python.relay_logger import PythonLogger


def test_structured_diagnostics_go_to_stderr_with_operation_id():
    stderr = io.StringIO()
    logger = PythonLogger(module="test", stderr=stderr, environ={"FIGMA_RELAY_OPERATION_ID": "op-py"})
    operation = logger.start_operation("export")
    operation.step("read-psd", {"layers": 4})
    operation.succeed({"written": 4})
    events = [json.loads(line.removeprefix("[FIGMA_RELAY_LOG]")) for line in stderr.getvalue().splitlines()]
    assert [event["status"] for event in events] == ["started", "progress", "succeeded"]
    assert {event["operationId"] for event in events} == {"op-py"}


def test_protocol_output_uses_stdout_and_diagnostics_never_do():
    stdout = io.StringIO()
    stderr = io.StringIO()
    logger = PythonLogger(module="test", stdout=stdout, stderr=stderr)
    logger.info("diagnostic")
    logger.write_protocol_output({"ok": True})
    assert json.loads(stdout.getvalue()) == {"ok": True}
    assert "diagnostic" not in stdout.getvalue()
    assert "diagnostic" in stderr.getvalue()


def test_sensitive_fields_are_redacted():
    stderr = io.StringIO()
    logger = PythonLogger(module="test", stderr=stderr)
    logger.info("request", {"authorization": "Bearer secret", "pngBase64": "A" * 10000})
    line = json.loads(stderr.getvalue().split("[FIGMA_RELAY_LOG]", 1)[1])
    assert line["data"]["authorization"] == "[REDACTED]"
    assert line["data"]["pngBase64"]["truncated"] is True
```

- [ ] **Step 2: Verify RED**

Run `python -m pytest tests/test_python_logger.py -q`.

Expected: FAIL because `python.relay_logger` does not exist.

- [ ] **Step 3: Implement PythonLogger**

Mirror the TypeScript fields and lifecycle. Prefix each stderr JSON line with `[FIGMA_RELAY_LOG]` so Node can distinguish structured diagnostics from legacy stderr. Use `FIGMA_RELAY_OPERATION_ID` and `FIGMA_RELAY_OPERATION_NAME`; generate a UUID only when the process is the first operation boundary. `write_protocol_output()` writes JSON to stdout and flushes.

- [ ] **Step 4: Replace Python runtime diagnostics**

Add the repo root to `sys.path` once per executable entry script, import `PythonLogger`, and replace diagnostic `print`/`log` calls with logger methods. Convert machine-readable final JSON and MCP framing to `write_protocol_output` or retain binary framing behind a dedicated protocol writer method. Each primary workflow creates one operation scope and records its named stages.

- [ ] **Step 5: Audit direct Python output**

Run `rg -n "\bprint\(|sys\.stderr\.write|sys\.stdout\.write"` across the files listed in this task. Every match must be inside `PythonLogger`, an MCP framing writer, or a documented protocol-output adapter; no diagnostic print remains.

- [ ] **Step 6: Verify GREEN and regressions**

Run:

```powershell
python -m pytest tests/test_python_logger.py tests/test_apply_cleanup_plan.py -q
python -m py_compile python/relay_logger.py server/figma_mcp_relay_server.py server/figma_mcp_companion.py client/figma_mcp_client.py
```

Expected: all tests PASS and compilation exits 0.

- [ ] **Step 7: Checkpoint**

Run `git diff --check` on the Python files. Suggested future Lore intent: `Separate machine protocols from correlated Python diagnostics`.

## Task 10: Implement BridgeLogger, Unity Request Scopes, Buffer Query, and Window Subscription

**Files:**

- Create: `unity/Assets/Editor/FigmaBridge/BridgeLogger.cs`
- Create: `unity/Assets/Editor/FigmaBridge/BridgeLogger.cs.meta`
- Modify: `unity/Assets/Editor/FigmaBridge/FigmaBridgeServer.cs`
- Modify: `unity/Assets/Editor/FigmaBridge/FigmaBridgeWindow.cs`
- Create: `tests/unity-bridge-logging.test.mjs`

- [ ] **Step 1: Write failing Unity source-contract tests**

Read C# source and assert:

- `BridgeLogger` defines `StartOperation`, `Step`, `Succeed`, `Fail`, `Cancel`, `Changed`, `Entries`, and a fixed-capacity buffer.
- `FigmaBridgeServer.DispatchRequest` reads `X-Operation-Id` and starts an HTTP operation scope.
- `/logs` is a read-only endpoint returning structured entries.
- `FigmaBridgeWindow` subscribes to `BridgeLogger.Changed`, renders `BridgeLogger.Entries`, and clears through `BridgeLogger.Clear()`.
- `FigmaBridgeServer.AddLog` and direct `ZLog.Log`/`Debug.Log` diagnostic calls no longer exist outside `BridgeLogger`.

- [ ] **Step 2: Verify RED**

Run `node --test tests/unity-bridge-logging.test.mjs`.

Expected: FAIL because `BridgeLogger.cs` is missing and the window still uses `FigmaBridgeServer` logging members.

- [ ] **Step 3: Implement BridgeLogger**

Use namespace `MagicWarrior.Editor.FigmaBridge`, matching the assembly root namespace and neighboring files. Define serializable `BridgeLogEntry`, `BridgeOperationScope : IDisposable`, and static `BridgeLogger`. The ring buffer capacity is 1,000 structured entries; the window may display the newest 20 by default. Protect the buffer with one lock because listener/background and Editor main threads can both log.

`BridgeLogger` must send human-readable diagnostics through the existing `ZLog` dependency only inside the class. If ZLog throws, fall back to `UnityEngine.Debug.LogError` inside a guarded emergency method that never calls `BridgeLogger` again.

- [ ] **Step 4: Add Unity HTTP operation scopes and log endpoint**

In `DispatchRequest`, resolve the operation ID from `X-Operation-Id` or generate a GUID, start `unity.http`, record the endpoint step, and terminalize based on response/error. Add `GET /logs` returning redacted structured entries with optional `operationId`, `level`, and `limit` filters. Keep it under the existing localhost/CORS security boundary and never expose asset bytes.

- [ ] **Step 5: Migrate server and window log calls**

Replace all `AddLog` calls with `BridgeLogger.Info/Warn/Error` and add explicit operation steps to export, image import, text sync, hierarchy sync, and prefab canvas workflows. Update window subscription/render/clear behavior to use `BridgeLogger`.

- [ ] **Step 6: Generate and preserve Unity metadata**

Create `BridgeLogger.cs.meta` once with a new stable 32-character lowercase GUID. Do not reuse a neighboring GUID. Validate both files are UTF-8 and the `.meta` is not regenerated on later edits.

- [ ] **Step 7: Verify source tests and installer packaging**

Run:

```powershell
node --test tests/unity-bridge-logging.test.mjs tests/unity-bridge-installer.test.mjs tests/release-portability.test.mjs
```

Expected: all tests PASS and installer/package tests include both `BridgeLogger.cs` and `.meta`.

- [ ] **Step 8: Compile in the selected real Unity project**

Resolve the selected project from `.local/projects.json`. The current selected entry is `E:\Project\Work\JellybeanUnity\JellybeanUnity`; re-read the registry immediately before executing in case the selection changed. Validate the resolved absolute path contains both `Assets` and `ProjectSettings`, then run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install_unity_bridge.ps1 -ProjectPath "E:\Project\Work\JellybeanUnity\JellybeanUnity"
uloop compile --project-path "E:\Project\Work\JellybeanUnity\JellybeanUnity" --force-recompile true --wait-for-domain-reload true
```

Expected: installer reports the exact target `Assets/Editor/FigmaBridge`, confirms project settings were untouched, and `uloop compile` returns zero C# compile errors. If the registry now points elsewhere, substitute only the newly resolved validated path in both commands. If no project is selected or Unity is unavailable, record this as an explicit validation gap rather than claiming compile proof.

- [ ] **Step 9: Checkpoint**

Run `git diff --check -- unity tests/unity-bridge-logging.test.mjs`. Suggested future Lore intent: `Make Unity Bridge failures visible in the same operation timeline`.

## Task 11: Integrate Unity Logs Into Relay Queries and Complete Cross-Runtime Timelines

**Files:**

- Modify: `src/httpServer.ts`
- Modify: `src/unityGatewayDiscovery.ts`
- Modify: `src/types.ts`
- Modify: `tests/log-http.test.mjs`
- Modify: `tests/log-correlation.test.mjs`

- [ ] **Step 1: Add failing Unity-merge tests**

Use a fake Unity HTTP gateway that serves `/logs`. Assert `GET /logs/operations/op-unity?includeUnity=true` fetches, validates, redacts, and merges Unity events with Relay events. Assert an unavailable Unity gateway returns Relay logs plus a `warnings` entry rather than failing the entire query.

- [ ] **Step 2: Verify RED**

Run `npx tsc -p tsconfig.json; node --test tests/log-http.test.mjs tests/log-correlation.test.mjs`.

Expected: FAIL because Unity log merging is not implemented.

- [ ] **Step 3: Add safe Unity log retrieval**

Use the selected project's discovered localhost gateway only. Send `X-Operation-Id`, apply a short bounded timeout, validate every returned event through `normalizeIncomingLogEvent`, and ingest/merge without duplicating events already present in Relay storage. Never follow redirects or accept non-local gateway URLs.

- [ ] **Step 4: Preserve partial diagnostic results**

If Unity is offline, include `{ source: "unity", message: "Unity log source unavailable", error }` in response warnings and return HTTP 200 with available Relay/UI/plugin/Python logs.

- [ ] **Step 5: Verify GREEN**

Run:

```powershell
npx tsc -p tsconfig.json
node --test tests/log-http.test.mjs tests/log-correlation.test.mjs tests/unity-project-http.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 6: Checkpoint**

Run `git diff --check` on task files. Suggested future Lore intent: `Keep diagnostic timelines useful even when one runtime is offline`.

## Task 12: Documentation, Full Verification, and Real Operation Proof

**Files:**

- Modify: `LOGGING.md`
- Remove after replacement: `.test-logging-system.mjs`
- Remove after replacement: `.test-logging.mjs`
- Modify as generated artifact: `code.js`
- Modify as generated artifact: `.build_version`

- [ ] **Step 1: Replace stale logging documentation**

Document:

- Logger classes and source ownership.
- Unified event fields and operation lifecycle.
- Query/filter/download endpoints.
- `operationId` propagation.
- 14-day/200 MiB retention.
- Redaction rules.
- Emergency fallback.
- PowerShell examples using `Get-Content -Encoding utf8` and `ConvertFrom-Json`.
- A troubleshooting workflow beginning with `/logs/operations/{operationId}`.

Remove claims that `/log` returns an empty placeholder or that the old Pino transport owns persistence.

- [ ] **Step 2: Remove obsolete ad-hoc logging probes**

Delete `.test-logging-system.mjs` and `.test-logging.mjs` only after their behavior is covered by automated tests. These files are untracked and currently contain stale API calls and encoding-corrupted display text; their removal must not touch other untracked diagnostic artifacts.

- [ ] **Step 3: Run the full automated suite**

Run:

```powershell
npx tsc -p tsconfig.json
node --test tests/*.test.mjs
python -m pytest tests/test_python_logger.py tests/test_apply_cleanup_plan.py -q
python scripts/build.py
node --check code.js
git diff --check
```

Expected: TypeScript emission succeeds, all Node/Python tests PASS, plugin build succeeds, generated code parses, and no diff whitespace errors exist.

- [ ] **Step 4: Run the direct-output and encoding audits**

Run:

```powershell
rg -n "console\.(log|info|warn|error|debug)" src code ui.html
rg -n "\bprint\(|sys\.stderr\.write|sys\.stdout\.write" server client python ai/skills
rg -n "Debug\.Log|ZLog\.Log|AddLog\(" unity/Assets/Editor/FigmaBridge
rg -n "\\u[0-9a-fA-F]{4}|\?\?\?|鏃ュ織|閿欒" src code ui.html server client python unity LOGGING.md
```

Expected: matches exist only in the logger classes' emergency/protocol methods or documented test fixtures; no mojibake or escaped Chinese source text remains.

- [ ] **Step 5: Start Relay and prove HTTP logging**

Start a hidden isolated Relay process on a free test port using the emitted `dist/index.js`. Submit one health request with a known `X-Operation-Id`, query `/logs/operations/{id}`, and assert both start and success events appear. Stop only the process started by this test.

- [ ] **Step 6: Prove a real Figma operation timeline**

With the live Figma plugin connected, trigger one safe read-only operation such as selection query. Capture its `operationId` from UI, then query the timeline. Required sources: `ui`, `plugin`, and `relay`; required terminal status: `succeeded`. If the live plugin is unavailable, report this exact runtime gap.

- [ ] **Step 7: Prove Python and Unity correlation**

Run one safe Python-backed operation and one read-only Unity health/selection operation with known IDs. Query each timeline and verify `python`/`unity` events merge with Relay events. Unity proof must use the actual selected project and active Bridge version.

- [ ] **Step 8: Review only the intended diff**

Run:

```powershell
git status --short
git diff --name-status
git diff --cached --name-status
```

Classify every changed file as pre-existing user work, logging implementation, generated logging artifact, or unexpected. Do not stage, commit, or revert pre-existing user work. Report any overlap explicitly.

- [ ] **Step 9: Produce the completion report**

Report changed files by runtime, test counts, compile/runtime evidence, the example operation IDs used for proof, retention/redaction behavior, and any remaining live-runtime gap. Do not claim end-to-end completion unless the relevant real Figma and Unity operations were observed.
