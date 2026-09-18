import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const ui = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");
function section(start, end) {
  const offset = ui.indexOf(start);
  assert.notEqual(offset, -1, start);
  return ui.slice(offset, ui.indexOf(end, offset));
}
function harness() {
  const calls = [];
  const context = vm.createContext({
    relaySocketResultRequests: Object.create(null), relaySocketJobQueue: [],
    relayOperations: {}, relaySocket: null, isExecuting: true, lastResultPayload: null,
    uiLogger: { startOperation: () => ({ step() {}, succeed() {}, fail() {} }) },
    sendRelaySocketRequest: async (action, payload) => { calls.push({ action, payload }); return { accepted: true }; },
    executeJob: async () => { throw new Error("must not execute"); },
    appendLog() {}, setAiStatus() {}, startExecutionWatchdog() {},
  });
  vm.runInContext(section("function rememberRelaySocketTask(", "function clearExecutionWatchdog()"), context);
  vm.runInContext(section("async function postResult(", "function reconnect()"), context);
  const message = { requestId: "task-1", operationId: "op-1", resultTransport: "websocket", resultToken: "secret-token", job: {} };
  context.rememberRelaySocketTask(message);
  context.relaySocketJobQueue.push(message);
  return { context, calls, message };
}

test("queued cancellation removes execution and acknowledges cancelled result with token", async () => {
  const { context, calls, message } = harness();
  await context.cancelRelaySocketTask(message);
  assert.equal(context.relaySocketJobQueue.length, 0);
  context.isExecuting = false;
  context.processRelaySocketQueue();
  assert.equal(calls[0].action, "job.result");
  assert.equal(calls[0].payload.result.status, "cancelled");
  assert.equal(calls[0].payload.resultToken, "secret-token");
});

test("running cancellation reports actual running state without inventing a result", async () => {
  const { context, calls, message } = harness();
  context.relaySocketResultRequests[message.requestId].state = "running";
  await context.cancelRelaySocketTask(message);
  assert.equal(calls[0].action, "job.cancel-status");
  assert.equal(calls[0].payload.state, "running");
  assert.equal(context.relaySocketResultRequests[message.requestId].result, undefined);
});

test("reconnection retransmits first cached result without executing again", async () => {
  const { context, calls, message } = harness();
  const result = { status: "success", value: 1 };
  await context.postResult(message.requestId, result);
  await context.postResult(message.requestId, { status: "error" });
  await context.reconcileRelayTasks();
  assert.equal(calls[2].action, "job.reconcile");
  assert.equal(calls[3].action, "job.result");
  assert.equal(calls[1].payload.result, result);
  assert.equal(calls[3].payload.result, result);
  assert.equal(calls[3].payload.resultToken, "secret-token");
});

test("failed reconciliation preserves result cache for the next connection", async () => {
  const { context, message } = harness();
  await context.postResult(message.requestId, { status: "success" });
  context.sendRelaySocketRequest = async () => { throw new Error("closed"); };
  await context.reconcileRelayTasks();
  assert.equal(context.relaySocketResultRequests[message.requestId].result.status, "success");
});

test("starting an already remembered queued job preserves its result token", async () => {
  const { context, calls, message } = harness();
  let executions = 0;
  context.executeJob = async () => { executions += 1; };
  context.isExecuting = false;
  context.processRelaySocketQueue();
  assert.equal(executions, 1);
  assert.equal(context.relaySocketResultRequests[message.requestId].state, "running");
  await context.cancelRelaySocketTask(message);
  assert.equal(calls[0].payload.resultToken, "secret-token");
});

test("reconciliation honors cancellation requested while disconnected", async () => {
  const { context, calls, message } = harness();
  context.sendRelaySocketRequest = async (action, payload) => {
    calls.push({ action, payload });
    return { accepted: true, cancelRequested: action === "job.reconcile" };
  };
  await context.reconcileRelayTasks();
  assert.equal(context.relaySocketJobQueue.length, 0);
  assert.equal(calls[1].payload.result.status, "cancelled");
  assert.equal(context.relaySocketResultRequests[message.requestId].state, "completed");
});

test("unknown cancellation reports unknown state with request token", async () => {
  const { context, calls } = harness();
  await context.cancelRelaySocketTask({ requestId: "unknown", resultToken: "other-token" });
  assert.equal(calls[0].action, "job.cancel-status");
  assert.equal(calls[0].payload.state, "unknown");
  assert.equal(calls[0].payload.resultToken, "other-token");
});

test("expired acknowledged results release payload but retain WebSocket routing", async () => {
  const { context, calls, message } = harness();
  await context.postResult(message.requestId, { status: "success", data: "large" });
  const record = context.relaySocketResultRequests[message.requestId];
  record.updatedAt = Date.now() - 600001;
  await context.reconcileRelayTasks();
  assert.equal(record.result, undefined);
  assert.equal(record.expired, true);
  assert.equal(record.resultToken, "secret-token");
  await context.postResult(message.requestId, { status: "error" });
  assert.equal(calls.length, 1);
});

test("unacknowledged results survive beyond the acknowledgement retention window", async () => {
  const { context, message } = harness();
  context.sendRelaySocketRequest = async () => { throw new Error("closed"); };
  await assert.rejects(context.postResult(message.requestId, { status: "success" }), /closed/);
  const record = context.relaySocketResultRequests[message.requestId];
  record.updatedAt = Date.now() - 600001;
  await context.reconcileRelayTasks();
  assert.equal(record.result.status, "success");
  assert.equal(record.expired, undefined);
});

test("WebSocket watchdog reports unknown without completing or releasing the running task", async () => {
  const { context, calls, message } = harness();
  let watchdog;
  Object.assign(context, {
    executionWatchdogTimer: null, executingRequestId: "", executingJobType: "",
    clearTimeout() {}, setTimeout(callback) { watchdog = callback; return 1; }
  });
  vm.runInContext(section("function clearExecutionWatchdog()", "async function postResult("), context);
  context.relaySocketResultRequests[message.requestId].state = "running";
  context.startExecutionWatchdog(message.requestId, "GET_SELECTION");
  watchdog();
  assert.equal(calls[0].action, "job.reconcile");
  assert.equal(calls[0].payload.state, "unknown");
  assert.equal(context.isExecuting, true);
  assert.equal(context.executingRequestId, message.requestId);
  assert.equal(context.relaySocketResultRequests[message.requestId].state, "running");
  assert.equal(context.relaySocketResultRequests[message.requestId].result, undefined);
  await context.postResult(message.requestId, { status: "success" });
  assert.equal(calls[1].payload.result.status, "success");
});
