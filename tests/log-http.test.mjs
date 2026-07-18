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

test("HTTP requests receive a stable operation id and terminal request log", async () => {
  const harness = await createHarness();
  try {
    const response = await fetch(`${harness.baseUrl}/health`, {
      headers: { "x-operation-id": "op-http" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-operation-id"), "op-http");
    await harness.logging.flush();
    const timeline = await harness.logging.store.query({ operationId: "op-http" });
    assert.deepEqual(timeline.events.map((event) => event.status), ["started", "succeeded"]);
  } finally {
    await closeHarness(harness);
  }
});

test("log APIs ingest, filter, expose timelines, and preserve legacy GET /log", async () => {
  const harness = await createHarness();
  try {
    const posted = await fetch(`${harness.baseUrl}/logs/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-figma-mcp-relay-internal": "plugin-runtime",
      },
      body: JSON.stringify({ events: [pluginEvent()] }),
    });
    assert.equal(posted.status, 202);
    assert.deepEqual(await posted.json(), { accepted: 1 });

    const queried = await fetch(`${harness.baseUrl}/logs?operationId=op-plugin&source=plugin&limit=50`);
    const queriedBody = await queried.json();
    assert.equal(queriedBody.events.length, 1);

    const timeline = await fetch(`${harness.baseUrl}/logs/operations/op-plugin`);
    assert.equal((await timeline.json()).events.length, 1);

    const legacy = await fetch(`${harness.baseUrl}/log?operationId=op-plugin`);
    assert.equal((await legacy.json()).logs.length, 1);
  } finally {
    await closeHarness(harness);
  }
});

test("log query validates enum filters and download returns redacted JSONL attachment", async () => {
  const harness = await createHarness();
  try {
    harness.logging.store.ingest([pluginEvent({ data: { password: "secret" } })]);
    const invalid = await fetch(`${harness.baseUrl}/logs?level=verbose`);
    assert.equal(invalid.status, 400);

    const download = await fetch(`${harness.baseUrl}/logs/download?operationId=op-plugin`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-type") ?? "", /application\/x-ndjson/);
    assert.match(download.headers.get("content-disposition") ?? "", /attachment; filename="figma-mcp-relay-logs-/);
    const content = await download.text();
    assert.match(content, /\[REDACTED\]/);
    assert.doesNotMatch(content, /"password":"secret"/);
  } finally {
    await closeHarness(harness);
  }
});
