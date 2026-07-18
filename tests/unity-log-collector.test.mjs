import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";

import { createLoggingRuntime } from "../dist/logging/loggingRuntime.js";
import { UnityLogCollector } from "../dist/logging/unityLogCollector.js";

test("UnityLogCollector ingests Unity events once and preserves operationId", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "figma-unity-logs-"));
  const logging = createLoggingRuntime({ directory, diagnosticLogger: pino({ level: "silent" }) });
  const unityEvent = {
    timestamp: "2026-07-18T12:00:00.000Z",
    level: "error",
    source: "unity",
    module: "figma-bridge",
    operationId: "op-unity",
    operationName: "unity.http-request",
    step: "operation.complete",
    stepIndex: 2,
    status: "failed",
    message: "Unity failed"
  };
  let fetchCount = 0;
  const collector = new UnityLogCollector(logging, {
    discover: () => ({ found: true, gatewayUrl: "http://localhost:32129", updatedAtUtc: "2026-07-18T12:00:00Z" }),
    fetcher: async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ events: [unityEvent] }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  const registry = {
    list: () => ({
      projects: [{ id: "p1", name: "Unity", path: "E:/Unity", lastSeenAt: "", valid: true, bridgeInstalled: true, settingsConfigured: true }],
      lastSelectedProjectId: "p1"
    })
  };

  await collector.collect(registry, "relay-query-1");
  await collector.collect(registry, "relay-query-2");
  const result = await logging.store.query({ source: "unity" });

  assert.equal(2, fetchCount);
  assert.equal(1, result.events.filter((event) => event.operationId === "op-unity").length);
  assert.equal("Unity failed", result.events.find((event) => event.operationId === "op-unity")?.message);
  await logging.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
