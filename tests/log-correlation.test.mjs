import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WebSocket } from "ws";

import { parseArgs } from "../dist/config.js";
import { createLoggingRuntime } from "../dist/logging/loggingRuntime.js";
import { RelayMcpServer } from "../dist/mcpServer.js";
import { RuntimeRelay } from "../dist/runtimeRelay.js";
import { WebSocketGateway } from "../dist/websocketGateway.js";

class FakeGateway {
  sent = [];
  receivedCallback;
  undeliveredCallback;

  onReceived(callback) { this.receivedCallback = callback; }
  onUndelivered(callback) { this.undeliveredCallback = callback; }
  sendJob(job) { this.sent.push(job); return true; }
  requiresExplicitTarget() { return false; }
  hasLiveSessionId() { return true; }
  status() { return { connected: true, authenticated: true, sessions: [], sessionCount: 1 }; }
  triggerReceived(requestId, operationId) { this.receivedCallback?.(requestId, operationId); }
}

function legacyRelay() {
  return {
    status: () => ({ enabled: false, available: false, url: "", scriptExists: false, processRunning: false }),
    proxyJson: async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }),
  };
}

async function createRelayHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-relay-correlation-"));
  const logging = createLoggingRuntime({ directory: path.join(root, "logs") });
  const gateway = new FakeGateway();
  const relay = new RuntimeRelay(
    parseArgs(["--port", "32197", "--transport", "websocket"]),
    gateway,
    legacyRelay(),
    logging,
  );
  return { root, logging, gateway, relay };
}

async function closeRelayHarness(harness) {
  harness.relay.dispose();
  await harness.logging.close();
  fs.rmSync(harness.root, { recursive: true, force: true });
}

test("relay job keeps one operation id through dispatch, acknowledgement, and result", async () => {
  const harness = await createRelayHarness();
  try {
    const result = harness.relay.submitJob({
      requestId: "req-1",
      operationId: "op-relay",
      job: { type: "TEST_JOB" },
    });
    assert.equal(result.operationId, "op-relay");
    assert.equal(harness.gateway.sent[0].operationId, "op-relay");

    harness.gateway.triggerReceived("req-1", "op-relay");
    harness.relay.setResult("req-1", { ok: true });
    await harness.logging.flush();

    const timeline = await harness.logging.store.query({ operationId: "op-relay" });
    assert.ok(timeline.events.some((event) => event.step === "plugin-acknowledged"));
    assert.ok(timeline.events.some((event) => event.step === "result-received"));
    assert.ok(timeline.events.some((event) => event.status === "succeeded"));
  } finally {
    await closeRelayHarness(harness);
  }
});

test("legacy relay submissions fall back to the request id as operation id", async () => {
  const harness = await createRelayHarness();
  try {
    const result = harness.relay.submitJob({ requestId: "req-legacy", job: { type: "TEST_JOB" } });
    assert.equal(result.operationId, "req-legacy");
    assert.equal(harness.gateway.sent[0].operationId, "req-legacy");
  } finally {
    await closeRelayHarness(harness);
  }
});

test("authenticated WebSocket log.events batches are ingested without becoming jobs", async () => {
  const accepted = [];
  const gateway = new WebSocketGateway((events) => accepted.push(...events));
  const server = createServer();
  gateway.attachServer(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/figma`);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  try {
    socket.send(JSON.stringify({ type: "log.events", events: [{ ignored: true }] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(accepted.length, 0);

    const registered = new Promise((resolve) => socket.once("message", resolve));
    socket.send(JSON.stringify({ type: "plugin.register", sessionId: "session-1", figma: {} }));
    await registered;
    socket.send(JSON.stringify({ type: "log.events", events: [{ source: "plugin" }] }));
    await waitFor(() => accepted.length === 1);
    assert.deepEqual(accepted, [{ source: "plugin" }]);
  } finally {
    socket.close();
    gateway.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("MCP metadata operation id is passed into submitted relay jobs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-relay-mcp-correlation-"));
  const logging = createLoggingRuntime({ directory: path.join(root, "logs") });
  let submittedPayload;
  const relay = {
    submitJob(payload) {
      submittedPayload = payload;
      return { requestId: "req-mcp", operationId: payload.operationId, transport: "polling" };
    },
  };
  try {
    const server = new RelayMcpServer(relay, logging);
    await server.handle({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "figma_submit_job",
        arguments: { job: { type: "TEST_JOB" } },
        _meta: { operationId: "op-mcp" },
      },
    });
    assert.equal(submittedPayload.operationId, "op-mcp");
  } finally {
    await logging.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
