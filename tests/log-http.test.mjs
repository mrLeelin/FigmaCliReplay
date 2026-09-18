import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseArgs } from "../dist/config.js";
import { createRelayHttpServer } from "../dist/httpServer.js";
import { createLoggingRuntime } from "../dist/logging/loggingRuntime.js";
import { UnityProjectRegistry } from "../dist/unityProjectRegistry.js";

function pluginEvent(overrides = {}) {
  return {
    timestamp: "2026-07-18T10:00:00.000Z",
    level: "info",
    source: "plugin",
    module: "plugin-main",
    operationId: "op-plugin",
    operationName: "plugin.command",
    step: "plugin.execute",
    stepIndex: 1,
    status: "progress",
    message: "插件执行命令",
    ...overrides,
  };
}

async function createHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-relay-log-http-"));
  const logging = createLoggingRuntime({ directory: path.join(root, "logs") });
  const registry = new UnityProjectRegistry(path.join(root, "projects.json"));
  const config = parseArgs(["--port", "32199"]);
  const relay = { status: () => ({ status: "ok" }) };
  const server = createRelayHttpServer(config, relay, registry, {}, logging);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    root,
    logging,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function closeHarness(harness) {
  await new Promise((resolve) => harness.server.close(resolve));
  await harness.logging.close();
  fs.rmSync(harness.root, { recursive: true, force: true });
}

test("retired HTTP requests preserve correlation and rejection logs", async () => {
 const harness = await createHarness();
 try {
   const response = await fetch(harness.baseUrl + "/logs", { headers: { "x-operation-id": "op-http" } });
   assert.equal(response.status, 410);
   assert.equal(response.headers.get("x-operation-id"), "op-http");
   await harness.logging.flush();
   const timeline = await harness.logging.store.query({ operationId: "op-http" });
   assert.deepEqual(timeline.events.map(event => event.status), ["started", "progress", "failed"]);
 } finally { await closeHarness(harness); }
});
