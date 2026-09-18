import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

import { parseArgs, SERVER_VERSION } from "../dist/config.js";
import { createLoggingRuntime } from "../dist/logging/loggingRuntime.js";
import { RuntimeRelay } from "../dist/runtimeRelay.js";
import { WebSocketGateway } from "../dist/websocketGateway.js";
import { UnityProjectRegistry } from "../dist/unityProjectRegistry.js";
import { createRelayControlHandler } from "../dist/relayControl.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("CLI status and log controls cross WebSocket without a Figma session", async (t) => {
  const h = await harness(t, { controlHandler: createRelayControlHandler({ status: () => ({ status: "ok" }) }, {}) });
  const status = await runCli(h, ["control", "--job-type", "relay.status", "--payload", "{}"]);
  assert.equal(status.code, 0);
  assert.equal(status.json.result.status, "ok");
  const logs = await runCli(h, ["control", "--job-type", "logs.query", "--payload", JSON.stringify({ query: { source: "relay", limit: 5 } })]);
  assert.equal(logs.code, 0);
  assert.ok(Array.isArray(logs.json.result.events));
  const invalid = await runCli(h, ["control", "--job-type", "logs.query", "--payload", JSON.stringify({ query: { from: "invalid" } })]);
  assert.notEqual(invalid.code, 0);
  assert.deepEqual(h.httpRequests, []);
});

async function harness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-relay-cli-"));
  const logging = createLoggingRuntime({ directory: path.join(root, "logs"), level: "silent" });
  const config = { ...parseArgs([]), adminToken: "", ...options };
  const gateway = new WebSocketGateway();
  const relay = new RuntimeRelay(config, gateway, { status: () => ({ enabled: false }) }, logging);
  const httpRequests = [];
  const server = createServer((request, response) => {
    httpRequests.push(request.url);
    response.writeHead(404).end();
  });
  t.after(async () => {
    relay.dispose();
    gateway.close();
    await new Promise((resolve) => server.close(resolve));
    await logging.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { RelayCliEndpoint } = await import("../dist/relayCliEndpoint.js");
  gateway.attachServer(server, new RelayCliEndpoint(config, relay, logging, options.controlHandler));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `ws://127.0.0.1:${server.address().port}`;
  return { root, logging, config, gateway, relay, httpRequests, base };
}

async function plugin(t, h, sessionId = "figma-test-1", respond, capabilities = ["job.result", "job.reconcile", "job.cancel"]) {
  const socket = new WebSocket(`${h.base}/figma`);
  socket.on("error", () => {});
  t.after(() => socket.terminate());
  await once(socket, "open");
  const registered = once(socket, "message");
  socket.send(JSON.stringify({ type: "plugin.register", sessionId, capabilities, figma: { fileKey: "file-test", fileName: "Test file" } }));
  await registered;
  const commands = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type !== "command.request") return;
    commands.push(message);
    socket.send(JSON.stringify({ type: "command.received", id: message.requestId }));
    // Dispatch acknowledgement precedes the asynchronous plugin result.
    socket.send(JSON.stringify({ type: "command.response", id: message.requestId, accepted: true }));
    if (respond) respond(socket, message);
    else socket.send(JSON.stringify({
      type: "relay.request", requestId: `result-${message.requestId}`, action: "job.result",
      payload: { requestId: message.requestId, resultToken: message.resultToken, result: { status: "ok", selection: [{ id: "12:34", name: "Panel" }] } },
    }));
  });
  return { socket, commands };
}

async function runCli(h, args = [], env = {}) {
  const child = spawn(process.execPath, [cliPath, ...args, "--url", `${h.base}/relay`], {
    windowsHide: true,
    env: { ...process.env, FIGMA_RELAY_TOKEN: "", FIGMA_RELAY_TOKEN_FILE: path.join(h.root, "no-token"), LOG_LEVEL: "info", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const watchdog = setTimeout(() => child.kill(), 10_000);
  try {
    const [code, signal] = await once(child, "close");
    assert.equal(signal, null, stderr);
    return { code, stdout, stderr, json: JSON.parse(stdout) };
  } finally {
    clearTimeout(watchdog);
  }
}

test("PSD CLI wait streams progress and timeout never requests cancellation", {timeout: 15000}, async (t) => {
  const calls = [];
  let reads = 0;
  let complete = true;
  const h = await harness(t, {controlHandler: (action, payload) => {
    calls.push(action);
    assert.equal(payload.sessionId, 'fixed-session');
    assert.equal(payload.taskId, 'psd-test');
    if (action === 'psd.import.cancel') return {ok: true, accepted: false, task: {status: 'running'}};
    assert.equal(action, 'psd.import.get');
    return {ok: true, task: {taskId: 'psd-test', status: complete && ++reads >= 2 ? 'preview-ready' : 'running'}};
  }});
  const args = ['--session-id', 'fixed-session', '--task-id', 'psd-test'];
  const waited = await runCli(h, ['psd-wait', ...args, '--timeout', '2']);
  assert.equal(waited.code, 0, waited.stderr);
  assert.equal(waited.json.result.task.status, 'preview-ready');
  assert.equal(waited.stdout.trim().split('\n').length, 1);
  complete = false;
  const expired = await runCli(h, ['psd-wait', ...args, '--timeout', '0.1']);
  assert.equal(expired.code, 1);
  assert.equal(expired.json.error.code, 'TIMEOUT');
  assert.ok(!calls.includes('psd.import.cancel'));
  const status = await runCli(h, ['psd-status', ...args]);
  assert.equal(status.json.result.task.status, 'running');
  const cancelled = await runCli(h, ['psd-cancel', ...args]);
  assert.equal(cancelled.json.result.accepted, false);
  assert.equal(cancelled.json.result.task.status, 'running');
  assert.equal(h.httpRequests.length, 0);
});

test("Unity project CLI controls share the registry over authenticated WebSocket", {timeout: 15000}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-cli-projects-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const project = path.join(root, 'Project');
  fs.mkdirSync(path.join(project, 'Assets'), {recursive: true});
  fs.mkdirSync(path.join(project, 'ProjectSettings'));
  const registry = new UnityProjectRegistry(path.join(root, 'projects.json'));
  const h = await harness(t, {controlHandler: createRelayControlHandler({}, {}, undefined, registry)});
  const run = (action, payload) => runCli(h, ['control', '--job-type', action, '--payload', JSON.stringify(payload)]);
  const added = await run('unity.projects.add', {path: project});
  assert.equal(added.code, 0, added.stderr);
  const id = added.json.result.project.id;
  assert.equal((await run('unity.projects.list', {})).json.result.projects.length, 1);
  assert.equal((await run('unity.projects.select', {id})).json.result.lastSelectedProjectId, id);
  assert.equal((await run('unity.gateway.get', {id})).json.result.found, false);
  assert.equal((await run('unity.projects.select', {})).code, 1);
  assert.equal((await run('unity.projects.remove', {id})).json.result.projects.length, 0);
  assert.equal(fs.existsSync(path.join(project, 'Assets')), true);
  assert.equal(h.httpRequests.length, 0);
});

test("all Figma submissions require token-based WebSocket delivery even with legacy polling config", async (t) => {
  const h = await harness(t, { transport: "polling" });
  const figma = await plugin(t, h);
  const submitted = h.relay.submitJob({ requestId: "direct-job", job: { type: "QUERY_SELECTION" } });
  assert.equal(submitted.transport, "websocket");
  assert.equal(submitted.target.sessionId, "figma-test-1");
  const completed = await h.relay.waitResult("direct-job", 2, 0.01);
  assert.equal(completed.result.status, "ok");
  assert.equal(figma.commands[0].resultTransport, "websocket");
  assert.ok(figma.commands[0].resultToken);
  assert.equal(typeof h.relay.getNextPollingJob, "undefined");
  const repeated = h.relay.submitJob({ requestId: "direct-job", job: { type: "QUERY_SELECTION" } });
  assert.equal(repeated.replayed, true);
  assert.equal(figma.commands.length, 1);
});

test("CLI queries Figma selection through WebSocket in both directions", { timeout: 15_000 }, async (t) => {
  const h = await harness(t);
  const figma = await plugin(t, h);
  const result = await runCli(h, ["selection", "--session-id", "figma-test-1"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.equal(result.json.ok, true);
  assert.deepEqual(result.json.result.selection, [{ id: "12:34", name: "Panel" }]);
  assert.equal(figma.commands.length, 1);
  assert.equal(figma.commands[0].job.type, "QUERY_SELECTION");
  assert.equal(figma.commands[0].resultTransport, "websocket");
  assert.equal(figma.commands[0].operationId, result.json.operationId);
  assert.deepEqual(h.httpRequests, []);
  const logs = await h.logging.store.query({ operationId: result.json.operationId });
  const requestLogs = logs.events.filter((event) => event.operationName === "cli.request");
  assert.equal(requestLogs[0].status, "started");
  assert.ok(requestLogs.some((event) => event.status === "progress"));
  assert.equal(requestLogs.at(-1).status, "succeeded");
});

test("Python skill client preserves result artifacts over the real CLI WebSocket path", { timeout: 15_000 }, async (t) => {
  const h = await harness(t);
  const expected = { status: "completed", screenshot: { path: path.join(h.root, "capture.png") }, verify: { allPass: true } };
  const figma = await plugin(t, h, "python-client", (socket, message) => {
    socket.send(JSON.stringify({ type: "relay.request", requestId: "python-result", action: "job.result", payload: {
      requestId: message.requestId, resultToken: message.resultToken, result: expected,
    } }));
  });
  const script = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "from figma_relay_cli import submit_job",
    "print(json.dumps(submit_job({'type': 'QUERY_SELECTION', 'sessionId': 'python-client'}, relay_url=sys.argv[2], request_id='python-stable', timeout=5)))",
  ].join("\n");
  const child = spawn("python", ["-c", script, fileURLToPath(new URL("../client", import.meta.url)), h.base], {
    windowsHide: true,
    env: { ...process.env, FIGMA_RELAY_TOKEN: "", FIGMA_RELAY_TOKEN_FILE: path.join(h.root, "no-token") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "close");
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { requestId: "python-stable", result: expected });
  assert.equal(figma.commands.length, 1);
  assert.deepEqual(h.httpRequests, []);
});

test("CLI sends large manifests from a payload file without HTTP fallback", async (t) => {
  const h = await harness(t);
  const figma = await plugin(t, h);
  const payload = { manifest: { description: "x".repeat(128 * 1024) } };
  const payloadPath = path.join(h.root, "manifest.json");
  fs.writeFileSync(payloadPath, JSON.stringify(payload));
  const result = await runCli(h, ["figma-command", "--job-type", "QUERY_SELECTION", "--payload-file", payloadPath]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(figma.commands[0].job.manifest, payload.manifest);
  assert.deepEqual(h.httpRequests, []);
});

test("generic figma-command routes an explicit job type and payload through WebSocket", async (t) => {
  const h = await harness(t);
  const figma = await plugin(t, h, "generic-command", (socket, message) => {
    socket.send(JSON.stringify({ type: "relay.request", requestId: "generic-result", action: "job.result", payload: {
      requestId: message.requestId, resultToken: message.resultToken, result: { status: "ok", pluginStatus: "ready" },
    } }));
  });
  const result = await runCli(h, ["figma-command", "--session-id", "generic-command", "--job-type", "QUERY_PLUGIN_STATUS", "--payload", "{\"includeSelection\":true}"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.result.pluginStatus, "ready");
  assert.equal(figma.commands[0].job.type, "QUERY_PLUGIN_STATUS");
  assert.equal(figma.commands[0].job.includeSelection, true);
  assert.equal(figma.commands[0].resultTransport, "websocket");
});

test("Figma read aliases map to WebSocket job types", async (t) => {
  const h = await harness(t);
  const figma = await plugin(t, h, "alias-target");
  const result = await runCli(h, ["figma-status", "--session-id", "alias-target"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(figma.commands[0].job.type, "QUERY_PLUGIN_STATUS");
  assert.equal(figma.commands[0].resultTransport, "websocket");
  const children = await runCli(h, ["figma-children", "--session-id", "alias-target", "--payload", "{\"nodeId\":\"12:34\"}"]);
  assert.equal(children.code, 0, children.stderr);
  assert.equal(figma.commands[1].job.type, "QUERY_NODE_CHILDREN");
  assert.equal(figma.commands[1].job.nodeId, "12:34");
});

test("CLI control invokes Relay control actions over WebSocket", async (t) => {
  const calls = [];
  const h = await harness(t, { controlHandler: (action, payload) => {
    calls.push({ action, payload });
    return { runId: payload.runId, status: "running" };
  } });
  const result = await runCli(h, ["control", "--job-type", "ai.run.get", "--payload", "{\"runId\":\"run-test\",\"capabilityToken\":\"cap-test\"}"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.result.runId, "run-test");
  assert.equal(calls[0].action, "ai.run.get");
  assert.equal(calls[0].payload.capabilityToken, "cap-test");
  assert.deepEqual(h.httpRequests, []);
});

test("generic figma-command requires a job type and JSON payload", async (t) => {
  const h = await harness(t);
  const invalidType = await runCli(h, ["figma-command", "--job-type", "QUERY_PLUGIN_STATUS"]);
  assert.equal(invalidType.code, 2);
  assert.equal(invalidType.json.error.code, "USAGE");
  const invalidPayload = await runCli(h, ["figma-command", "--job-type", "QUERY_PLUGIN_STATUS", "--payload", "[]"]);
  assert.equal(invalidPayload.code, 2);
  assert.equal(invalidPayload.json.error.code, "USAGE");
});

test("file payload preserves a large cleanup plan without command-line encoding", async (t) => {
  const h = await harness(t);
  const figma = await plugin(t, h);
  const payload = { nodeId: "12:34", note: "plan ".repeat(2000) };
  const file = path.join(h.root, "plan.json");
  fs.writeFileSync(file, JSON.stringify(payload), "utf8");
  const result = await runCli(h, ["figma-command", "--job-type", "QUERY_NODE_CHILDREN", "--payload-file", file]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(figma.commands[0].job.note, payload.note);
  assert.deepEqual(h.httpRequests, []);
});

test("CLI registers assets through WebSocket while preserving path restrictions", async (t) => {
  const h = await harness(t);
  h.config.assetRoots = [h.root];
  const figma = await plugin(t, h);
  const imagePath = path.join(h.root, "image.png");
  fs.writeFileSync(imagePath, "asset-test");
  const file = path.join(h.root, "assets.json");
  fs.writeFileSync(file, JSON.stringify({ image: imagePath }));
  const args = ["figma-command", "--job-type", "QUERY_SELECTION", "--payload", "{}", "--assets-file", file];
  const accepted = await runCli(h, args);
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.equal(h.relay.assetPath(accepted.json.requestId, "image"), imagePath);
  fs.writeFileSync(file, JSON.stringify({ image: path.join(h.root, "..", "outside.png") }));
  const denied = await runCli(h, args);
  assert.equal(denied.code, 1);
  assert.match(denied.json.error.message, /outside allowed roots/);
  assert.equal(figma.commands.length, 1);
  assert.deepEqual(h.httpRequests, []);
});

test("CLI rejects a plugin without WebSocket results before dispatch", async (t) => {
  const h = await harness(t);
  const figma = await plugin(t, h, "old-plugin", undefined, []);
  const result = await runCli(h, ["selection"]);
  assert.equal(result.code, 1);
  assert.equal(result.json.error.code, "UPGRADE_REQUIRED");
  assert.equal(figma.commands.length, 0);
});

test("CLI lists sessions and refuses ambiguous or conflicting targets", async (t) => {
  const h = await harness(t);
  const first = await plugin(t, h, "first");
  const second = await plugin(t, h, "second");
  const listed = await runCli(h, ["sessions"]);
  assert.equal(listed.code, 0);
  assert.deepEqual(listed.json.result.sessions.map((session) => session.sessionId).sort(), ["first", "second"]);
  const ambiguous = await runCli(h, ["selection"]);
  assert.equal(ambiguous.code, 1);
  assert.equal(ambiguous.json.error.code, "TARGET_AMBIGUOUS");
  const conflicting = await runCli(h, ["selection", "--session-id", "first", "--file-key", "other-file"]);
  assert.equal(conflicting.code, 1);
  assert.equal(conflicting.json.error.code, "TARGET_OFFLINE");
  assert.equal(first.commands.length + second.commands.length, 0);
  const selected = await runCli(h, ["selection", "--session-id", "second"]);
  assert.equal(selected.code, 0);
  assert.equal(first.commands.length, 0);
  assert.equal(second.commands.length, 1);
  const logs = await h.logging.store.query({ operationId: ambiguous.json.operationId });
  assert.equal(logs.events.at(-1).status, "failed");
  assert.equal(logs.events.at(-1).data.code, "TARGET_AMBIGUOUS");
});

test("CLI honors the configured token and never logs it", async (t) => {
  const token = "test-cli-private-token";
  const h = await harness(t, { adminToken: token });
  const rejected = await runCli(h, ["sessions"]);
  assert.equal(rejected.code, 1);
  assert.equal(rejected.json.error.code, "FORBIDDEN");
  const allowed = await runCli(h, ["sessions"], { FIGMA_RELAY_TOKEN: token });
  assert.equal(allowed.code, 0);
  assert.ok(!allowed.stdout.includes(token) && !allowed.stderr.includes(token));
});

async function rawCli(t, h, hello = {}) {
  const socket = new WebSocket(`${h.base}/relay`);
  socket.on("error", () => {});
  t.after(() => socket.terminate());
  await once(socket, "open");
  const received = once(socket, "message");
  socket.send(JSON.stringify({ type: "relay.hello", role: "cli", protocolVersion: 1, clientVersion: SERVER_VERSION, ...hello }));
  return { socket, response: JSON.parse(String((await received)[0])) };
}

test("CLI endpoint rejects mismatched versions and forged plugin roles", async (t) => {
  const h = await harness(t);
  for (const hello of [{ protocolVersion: 0 }, { clientVersion: "0.0.0" }, { role: "plugin" }]) {
    const { response } = await rawCli(t, h, hello);
    assert.equal(response.type, "relay.error");
    assert.equal(response.error.code, "UPGRADE_REQUIRED");
  }
  assert.equal(h.gateway.status().sessionCount, 0);
});

test("CLI cannot submit arbitrary mutations through the read-only slice", async (t) => {
  const h = await harness(t);
  const figma = await plugin(t, h);
  const { socket } = await rawCli(t, h);
  const received = once(socket, "message");
  socket.send(JSON.stringify({ type: "relay.request", requestId: "write-1", operationId: "op-write", action: "figma.delete", payload: { nodeId: "12:34" } }));
  const response = JSON.parse(String((await received)[0]));
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "INVALID_REQUEST");
  assert.equal(figma.commands.length, 0);
});

test("Figma disconnect fails the read query without entering HTTP polling", async (t) => {
  const h = await harness(t);
  await plugin(t, h, "disconnecting", (socket) => socket.close());
  const result = await runCli(h, ["selection", "--timeout", "1"]);
  assert.equal(result.code, 1);
  assert.equal(result.json.error.code, "QUERY_FAILED");
  assert.equal(typeof h.relay.getNextPollingJob, "undefined");
  assert.deepEqual(h.httpRequests, []);
});

test("a plugin cannot submit another session's result", async (t) => {
  const h = await harness(t);
  const intruder = await plugin(t, h, "intruder");
  let rejected;
  await plugin(t, h, "target", (socket, message) => {
    const incoming = once(intruder.socket, "message");
    intruder.socket.send(JSON.stringify({ type: "relay.request", requestId: "forged-result", action: "job.result", payload: { requestId: message.requestId, result: { status: "ok", selection: ["forged"] } } }));
    rejected = incoming.then(([raw]) => {
      const response = JSON.parse(String(raw));
      socket.send(JSON.stringify({ type: "relay.request", requestId: "real-result", action: "job.result", payload: { requestId: message.requestId, resultToken: message.resultToken, result: { status: "ok", selection: ["real"] } } }));
      return response;
    });
  });
  const result = await runCli(h, ["selection", "--session-id", "target"]);
  assert.equal((await rejected).ok, false);
  assert.equal(result.code, 0);
  assert.deepEqual(result.json.result.selection, ["real"]);
});

test("query timeout reports failure and never queues a polling retry", async (t) => {
  const h = await harness(t);
  await plugin(t, h, "slow", () => {});
  const result = await runCli(h, ["selection", "--timeout", "0.1"]);
  assert.equal(result.code, 1);
  assert.match(result.json.error.message, /timeout/);
  assert.equal(typeof h.relay.getNextPollingJob, "undefined");
});

test("CLI refuses invalid arguments before connecting", async (t) => {
  const h = await harness(t);
  for (const args of [["selection", "--timeout", "NaN"], ["delete"], ["selection", "--unknown"]]) {
    const result = await runCli(h, args);
    assert.equal(result.code, 2);
    assert.equal(result.json.error.code, "USAGE");
  }
  assert.deepEqual(h.httpRequests, []);
});

test("CLI reports cancelled plugin results as failure", async (t) => {
  const h = await harness(t);
  await plugin(t, h, "cancelled", (socket, message) => {
    socket.send(JSON.stringify({ type: "relay.request", requestId: "cancel-result", action: "job.result", payload: { requestId: message.requestId, resultToken: message.resultToken, result: { status: "CANCELLED" } } }));
  });
  const result = await runCli(h, ["selection"]);
  assert.equal(result.code, 1);
  assert.equal(result.json.error.code, "PLUGIN_FAILED");
});

test("busy CLI requests have correlated failure logs", async (t) => {
  const h = await harness(t);
  await plugin(t, h, "slow", () => {});
  const { socket } = await rawCli(t, h);
  const busy = once(socket, "message");
  socket.send(JSON.stringify({ type: "relay.request", requestId: "first-query", operationId: "op-first", action: "figma.selection", payload: { timeout: 0.1 } }));
  socket.send(JSON.stringify({ type: "relay.request", requestId: "second-query", operationId: "op-second", action: "figma.selection", payload: {} }));
  const response = JSON.parse(String((await busy)[0]));
  assert.equal(response.error.code, "BUSY");
  assert.equal(response.operationId, "op-second");
  const logs = await h.logging.store.query({ operationId: "op-second" });
  assert.equal(logs.events.at(-1).status, "failed");
  await once(socket, "message");
});

test("repeated plugin results are acknowledged without overwriting the first result", async (t) => {
  const h = await harness(t);
  const figma = await plugin(t, h);
  const result = await runCli(h, ["selection"]);
  assert.equal(result.code, 0);
  const received = once(figma.socket, "message");
  figma.socket.send(JSON.stringify({ type: "relay.request", requestId: "repeat", action: "job.result", payload: { requestId: result.json.requestId, resultToken: figma.commands[0].resultToken, result: { status: "ok", selection: ["changed"] } } }));
  const response = JSON.parse(String((await received)[0]));
  assert.equal(response.ok, true);
  assert.deepEqual(h.relay.getJob(result.json.requestId).result.selection, [{ id: "12:34", name: "Panel" }]);
});

test("CLI logs the original connection error and one attempt without launching a service", async (t) => {
  const h = await harness(t);
  const unused = createServer();
  await new Promise((resolve) => unused.listen(0, "127.0.0.1", resolve));
  const port = unused.address().port;
  await new Promise((resolve) => unused.close(resolve));
  const result = await runCli({ ...h, base: `ws://127.0.0.1:${port}` }, ["sessions"]);
  assert.equal(result.code, 1);
  assert.equal(result.json.error.code, "CONNECTION_FAILED");
  const events = result.stderr.trim().split("\n").map((line) => JSON.parse(line));
  const failed = events.find((event) => event.status === "failed");
  assert.equal(failed.data.originalError.code, "ECONNREFUSED");
  assert.equal(failed.data.attempt, 1);
  assert.equal(failed.data.maxAttempts, 1);
  assert.equal(failed.operationId, result.json.operationId);
});

test("browser origins cannot impersonate the CLI endpoint", async (t) => {
  const h = await harness(t);
  const socket = new WebSocket(`${h.base}/relay`, { origin: "https://www.figma.com" });
  socket.on("error", () => {});
  t.after(() => socket.terminate());
  const response = await new Promise((resolve) => socket.once("unexpected-response", (_request, incoming) => {
    incoming.resume();
    resolve(incoming.statusCode);
    socket.terminate();
  }));
  assert.equal(response, 403);
});

test("detached selection survives CLI exit and can be queried and cancelled", async (t) => {
  const h = await harness(t);
  let activeCommand;
  const figma = await plugin(t, h, "detached", (socket, message) => {
    activeCommand = { socket, message };
  });
  const submitted = await runCli(h, ["selection", "--session-id", "detached", "--detach"]);
  assert.equal(submitted.code, 0, submitted.stderr);
  const taskId = submitted.json.requestId;
  assert.equal(submitted.json.result.status, "running");
  const status = await runCli(h, ["task-status", "--task-id", taskId]);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.json.result.requestId, taskId);
  assert.equal(status.json.result.status, "running");
  const cancelled = await runCli(h, ["task-cancel", "--task-id", taskId]);
  assert.equal(cancelled.code, 0, cancelled.stderr);
  assert.equal(cancelled.json.result.status, "cancel_requested");
  assert.equal(cancelled.json.result.cancelSent, true);
  figma.socket.send(JSON.stringify({ type: "relay.request", requestId: "cancel-confirm", action: "job.result", payload: { requestId: taskId, resultToken: activeCommand.message.resultToken, result: { status: "cancelled", reason: "user requested" } } }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const final = await runCli(h, ["task-status", "--task-id", taskId]);
  assert.equal(final.code, 0, final.stderr);
  assert.equal(final.json.result.status, "cancelled");
  assert.equal(activeCommand.message.requestId, taskId);
});

test("cancel is idempotent and does not overwrite a completed result", async (t) => {
  const h = await harness(t);
  const figma = await plugin(t, h);
  const submitted = await runCli(h, ["selection", "--session-id", "figma-test-1", "--detach"]);
  assert.equal(submitted.code, 0);
  const taskId = submitted.json.requestId;
  const cancelled = await runCli(h, ["task-cancel", "--task-id", taskId]);
  assert.equal(cancelled.code, 0);
  assert.equal(cancelled.json.result.status, "succeeded");
  const again = await runCli(h, ["task-cancel", "--task-id", taskId]);
  assert.equal(again.code, 0);
  assert.equal(again.json.result.status, "succeeded");
  assert.equal(figma.commands.length, 1);
});

test("unknown task IDs return a stable task error", async (t) => {
  const h = await harness(t);
  const status = await runCli(h, ["task-status", "--task-id", "missing-task"]);
  assert.equal(status.code, 1);
  assert.equal(status.json.error.code, "TASK_UNKNOWN");
  const cancel = await runCli(h, ["task-cancel", "--task-id", "missing-task"]);
  assert.equal(cancel.code, 1);
  assert.equal(cancel.json.error.code, "TASK_UNKNOWN");
});

test("a disconnected mutation becomes result_unknown and is never replayed", async (t) => {
  const h = await harness(t);
  const figma = await plugin(t, h, "writer", () => {});
  const submitted = h.relay.submitJob({
    requestId: "mutation-unknown",
    operationId: "op-mutation-unknown",
    target: { sessionId: "writer" },
    job: { type: "FIGMA_DELETE_NODE", nodeId: "12:34" },
  }, { transport: "websocket" });
  assert.equal(submitted.transport, "websocket");
  figma.socket.close();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.relay.getJobStatus("mutation-unknown").status, "waiting_reconnect");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(30_001);
  const status = h.relay.getJobStatus("mutation-unknown");
  assert.equal(status.status, "result_unknown");
  assert.equal(typeof h.relay.getNextPollingJob, "undefined");
  assert.equal(h.relay.getJob("mutation-unknown").dispatchAttempts, 1);
});

test("reusing a request ID returns the existing task without dispatching twice", async (t) => {
  const h = await harness(t);
  const figma = await plugin(t, h, "idempotent", () => {});
  const first = h.relay.submitJob({ requestId: "same-request", operationId: "op-first", target: { sessionId: "idempotent" }, job: { type: "QUERY_SELECTION" } }, { transport: "websocket" });
  const second = h.relay.submitJob({ requestId: "same-request", operationId: "op-second", target: { sessionId: "idempotent" }, job: { type: "QUERY_SELECTION" } }, { transport: "websocket" });
  assert.equal(second.replayed, true);
  assert.equal(second.operationId, first.operationId);
  await once(figma.socket, "message");
  assert.equal(figma.commands.length, 1);
  assert.throws(() => h.relay.submitJob({ requestId: "same-request", job: { type: "FIGMA_DELETE_NODE" } }, { transport: "websocket" }), /requestId conflict/);
});

async function reportTask(socket, action, payload) {
  const received = once(socket, "message");
  socket.send(JSON.stringify({ type: "relay.request", requestId: `report-${Date.now()}`, action, payload }));
  return JSON.parse(String((await received)[0]));
}

test("reconnected plugin authenticates retained tasks and resolves uncertainty without replay", async (t) => {
  const h = await harness(t);
  const first = await plugin(t, h, "recoverable", () => {});
  const submitted = await runCli(h, ["selection", "--detach", "--request-id", "recover-this"]);
  assert.equal(submitted.code, 0);
  const command = first.commands[0];
  const closed = once(first.socket, "close");
  first.socket.close();
  await closed;
  for (let attempt = 0; attempt < 50 && h.relay.getJobStatus(command.requestId).status === "running"; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(h.relay.getJobStatus(command.requestId).status, "waiting_reconnect");
  const retried = await runCli(h, ["selection", "--detach", "--request-id", "recover-this"]);
  assert.equal(retried.code, 0, retried.stderr);
  assert.equal(retried.json.result.operationId, submitted.json.result.operationId);
  const second = await plugin(t, h, "recoverable", () => {});
  const rejected = await reportTask(second.socket, "job.result", { requestId: command.requestId, resultToken: "wrong", result: { status: "ok" } });
  assert.equal(rejected.ok, false);
  const reconciled = await reportTask(second.socket, "job.reconcile", { requestId: command.requestId, resultToken: command.resultToken, state: "unknown" });
  assert.equal(reconciled.ok, true);
  assert.equal(h.relay.getJobStatus(command.requestId).status, "result_unknown");
  const result = await reportTask(second.socket, "job.result", { requestId: command.requestId, resultToken: command.resultToken, result: { status: "ok", selection: ["recovered"] } });
  assert.equal(result.ok, true);
  const status = await runCli(h, ["task-status", "--task-id", command.requestId]);
  assert.equal(status.json.result.status, "succeeded");
  assert.deepEqual(status.json.result.result.selection, ["recovered"]);
  assert.equal(status.json.result.dispatchAttempts, 1);
  assert.equal(second.commands.length, 0);
  assert.ok(!JSON.stringify(status.json).includes(command.resultToken));
  const logs = await h.logging.store.query({ operationId: command.operationId });
  const recovery = logs.events.filter((event) => event.operationName === "relay.reconcile");
  assert.ok(recovery.some((event) => event.status === "failed"));
  assert.ok(recovery.some((event) => event.status === "succeeded"));
  assert.ok(!JSON.stringify(logs).includes(command.resultToken));
});

test("CLI task wait receives state events and a later result from a separate submission", async (t) => {
  const h = await harness(t);
  const figma = await plugin(t, h, "waiter", () => {});
  const submitted = await runCli(h, ["selection", "--detach"]);
  const taskId = submitted.json.requestId;
  const waiting = runCli(h, ["task-wait", "--task-id", taskId, "--timeout", "2"]);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await reportTask(figma.socket, "job.result", { requestId: taskId, resultToken: figma.commands[0].resultToken, result: { status: "ok", selection: ["later"] } });
  const completed = await waiting;
  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(completed.json.result.status, "succeeded");
  assert.equal(completed.stdout.trim().split("\n").length, 1);
  assert.match(completed.stderr, /task-status/);
  assert.equal(figma.commands.length, 1);
});

test("request retries reject target conflicts and preserve the first result", async (t) => {
  const h = await harness(t);
  const figma = await plugin(t, h);
  const args = ["selection", "--detach", "--request-id", "stable-cli-id"];
  const first = await runCli(h, args);
  const retry = await runCli(h, args);
  assert.equal(retry.code, 0);
  assert.equal(retry.json.result.operationId, first.json.result.operationId);
  const conflict = await runCli(h, [...args, "--session-id", "other"]);
  assert.equal(conflict.json.error.code, "REQUEST_CONFLICT");
  assert.equal(figma.commands.length, 1);
});

test("cancellation while offline is reconciled and running cancellation may still succeed", async (t) => {
  const h = await harness(t);
  const figma = await plugin(t, h, "cancel-recovery", () => {});
  const submitted = await runCli(h, ["selection", "--detach"]);
  const command = figma.commands[0];
  const closed = once(figma.socket, "close");
  figma.socket.close();
  await closed;
  const cancelled = await runCli(h, ["task-cancel", "--task-id", submitted.json.requestId]);
  assert.equal(cancelled.json.result.cancelSent, false);
  assert.notEqual(cancelled.json.result.status, "cancelled");
  const reconnected = await plugin(t, h, "cancel-recovery", () => {});
  const payload = { requestId: command.requestId, resultToken: command.resultToken };
  const report = await reportTask(reconnected.socket, "job.reconcile", { ...payload, state: "running" });
  assert.equal(report.result.cancelRequested, true);
  await reportTask(reconnected.socket, "job.cancel-status", { ...payload, state: "running" });
  assert.equal(h.relay.getJobStatus(command.requestId).cancelOutcome, "running");
  await reportTask(reconnected.socket, "job.result", { ...payload, result: { status: "ok" } });
  assert.equal(h.relay.getJobStatus(command.requestId).status, "succeeded");
  assert.equal(reconnected.commands.length, 0);
});

test("Relay process replacement reports old task IDs as unknown without replay", async (t) => {
  const first = await harness(t);
  await plugin(t, first, "before-restart", () => {});
  const submitted = await runCli(first, ["selection", "--detach"]);
  const replacement = await harness(t);
  const status = await runCli(replacement, ["task-status", "--task-id", submitted.json.requestId]);
  assert.equal(status.json.error.code, "TASK_UNKNOWN");
  assert.equal(typeof replacement.relay.getNextPollingJob, "undefined");
});
