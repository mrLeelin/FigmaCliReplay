import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const ui = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");
function section(start, end) {
  return ui.slice(ui.indexOf(start), ui.indexOf(end, ui.indexOf(start)));
}

function harness({ transport = "websocket", socketSend } = {}) {
  const calls = { socket: [], http: [], logs: [] };
  const result = { status: "success", nodes: ["12:34"] };
  const context = vm.createContext({
    isExecuting: false,
    relaySocketJobQueue: [{ requestId: "job-1", operationId: "op-1", resultTransport: transport, resultToken: "token", job: { type: "GET_SELECTION" } }],
    relaySocketResultRequests: Object.create(null),
    relayOperations: {}, relaySocket: null,
    lastResultPayload: { requestId: "job-1", result },
    uiLogger: { startOperation(name, message, options) {
      calls.logs.push({ name, options });
      return Object.fromEntries(["step", "succeed", "fail"].map(method => [method, (...args) => calls.logs.push({ method, args })]));
    } },
    appendLog() {}, setAiStatus() {}, startExecutionWatchdog() {},
    executeJob: async () => {},
    sendRelaySocketRequest: async (...args) => {
      calls.socket.push(args);
      return socketSend ? socketSend(...args) : { accepted: true };
    },
    fetchWithTimeout: async (...args) => { calls.http.push(args); return { ok: true }; },
    relayEndpoint: path => path,
    relayRuntimeHeaders: headers => headers,
  });
  vm.runInContext(section("function rememberRelaySocketTask(", "function clearExecutionWatchdog()"), context);
  vm.runInContext(section("async function postResult(", "function reconnect()"), context);
  if (transport === null) delete context.relaySocketJobQueue[0].resultTransport;
  context.processRelaySocketQueue();
  return { context, calls, result };
}

test("CLI plugin results wait for WebSocket acknowledgement before clearing retry state", async () => {
  let acknowledge;
  const { context, calls, result } = harness({ socketSend: () => new Promise(resolve => { acknowledge = resolve; }) });
  const pending = context.postResult("job-1", result);
  assert.equal(calls.socket.length, 1);
  assert.equal(calls.socket[0][0], "job.result");
  assert.equal(calls.socket[0][1].requestId, "job-1");
  assert.equal(calls.socket[0][1].result, result);
  assert.deepEqual(calls.socket[0].slice(2), ["", 8000]);
  assert.ok(context.lastResultPayload);
  assert.ok(context.relaySocketResultRequests["job-1"]);
  acknowledge({ accepted: true });
  await pending;
  assert.equal(context.lastResultPayload, null);
  assert.ok(context.relaySocketResultRequests["job-1"]);
  assert.equal(calls.http.length, 0);
  assert.ok(calls.logs.some(log => log.name === "ui.result" && log.options.operationId === "op-1"));
  assert.ok(calls.logs.some(log => log.method === "succeed"));
});

test("failed CLI result delivery preserves retry routing and never falls back to HTTP", async () => {
  const { context, calls, result } = harness({ socketSend: () => { throw new Error("socket closed"); } });
  await assert.rejects(context.postResult("job-1", result), /socket closed/);
  assert.ok(context.lastResultPayload);
  assert.ok(context.relaySocketResultRequests["job-1"]);
  await assert.rejects(context.postResult("job-1", result), /socket closed/);
  assert.equal(calls.socket.length, 2);
  assert.equal(calls.http.length, 0);
  assert.ok(calls.logs.some(log => log.method === "fail"));
});

test("legacy plugin tasks are rejected without executing or posting HTTP results", async () => {
  const { context, calls, result } = harness({ transport: null });
  await assert.rejects(context.postResult("job-1", result), /Unknown WebSocket task/);
  assert.equal(calls.socket.length, 0);
  assert.equal(calls.http.length, 0);
});

test("plugin registration advertises WebSocket job result support", () => {
  const messages = [];
  const context = vm.createContext({
    relaySocket: { readyState: 1, send: message => messages.push(JSON.parse(message)) },
    WebSocket: { OPEN: 1 },
    relaySessionId: "session-1",
    currentFigmaSessionInfo: () => ({ fileKey: "file-1" }),
  });
  vm.runInContext(section("function registerRelaySocket()", "function sendRelaySocketHeartbeat()"), context);
  context.registerRelaySocket();
  assert.equal(messages[0].type, "plugin.register");
  assert.deepEqual(messages[0].capabilities, ["job.result", "job.reconcile", "job.cancel"]);
});

test("missing or negative result acknowledgement preserves retry state", async () => {
  for (const response of [undefined, {}, { accepted: false }]) {
    const { context, calls, result } = harness({ socketSend: () => response });
    await assert.rejects(context.postResult("job-1", result), /not accepted/);
    assert.ok(context.lastResultPayload);
    assert.ok(context.relaySocketResultRequests["job-1"]);
    assert.equal(calls.http.length, 0);
    assert.ok(calls.logs.some(log => log.method === "fail"));
  }
});

test("duplicate plugin results keep WebSocket routing after acknowledgement clears the payload", async () => {
  const { context, calls, result } = harness();
  await context.postResult("job-1", result);
  assert.equal(context.lastResultPayload, null);
  await context.postResult("job-1", result);
  assert.equal(context.lastResultPayload, null);
  assert.equal(calls.socket.length, 2);
  assert.equal(calls.http.length, 0);
  assert.equal(context.relaySocketResultRequests["job-1"].state, "completed");
  assert.equal(context.relaySocketResultRequests["job-1"].result, result);
  assert.equal(context.relaySocketResultRequests["job-1"].acknowledged, true);
});
