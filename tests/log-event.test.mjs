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
