import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import { WebSocketGateway } from "../dist/websocketGateway.js";
import { createRelayControlHandler } from "../dist/relayControl.js";
import { notifyRunChanged } from "../dist/runChangeNotifier.js";

test("shared controls reject ambiguous/offline targets and preserve confirmation fields", async () => {
  const sessions = [{ authenticated: true, sessionId: "one", fileKey: "file1" }, { authenticated: true, sessionId: "two", fileKey: "file2" }];
  const calls = [];
  const control = createRelayControlHandler({ status: () => ({ plugin: { sessions } }) }, {
    controller: { confirmComponentSets: (...args) => { calls.push(args); return { ok: true }; } },
  }, { runLocalAiPrompt: (payload) => { calls.push(payload); return { ok: true }; } });
  await assert.rejects(control("ai.run.start", {}), /exactly one/);
  await assert.rejects(control("ai.run.start", { sessionId: "missing" }), /exactly one/);
  await assert.rejects(control("ai.run.start", { sessionId: "one", fileKey: "file2" }), /exactly one/);
  assert.equal(calls.length, 0);
  await control("ai.run.start", { fileKey: "file1", clientRequestId: "stable" });
  assert.equal(calls[0].sessionId, "one");
  await control("cleanup.run.confirm-component-sets", { runId: "run", capabilityToken: "secret", satisfied: false, feedback: "adjust" });
  assert.deepEqual(calls[1], ["run", "secret", { satisfied: false, feedback: "adjust" }]);
});

test("run subscriptions authenticate, push only changes, resume output, and release on disconnect", { timeout: 10000 }, async (t) => {
  const gateway = new WebSocketGateway();
  const server = createServer();
  gateway.attachServer(server);
  t.after(async () => { gateway.close(); await new Promise((resolve) => server.close(resolve)); });
  let reads = 0;
  let state = "running";
  let delayedRead;
  let releaseRead;
  const output = [{ sequence: 1, text: "first" }];
  gateway.onClientRequest((request) => {
    if (request.action === "figma.prefab.get") {
      assert.equal(request.sessionId, "plugin");
      return { ok: true, task: { taskId: "figma-task", status: "running" } };
    }
    if (request.action === "psd.import.get") {
      assert.equal(request.sessionId, "plugin");
      return { ok: true, task: { taskId: "psd-task", status: "running" } };
    }
    if (request.action === "prefab.import.get") {
      assert.equal(request.sessionId, "plugin");
      assert.equal(request.payload.taskId, "import-task");
      return { ok: true, taskId: "import-task", status: "running", percent: 25 };
    }
    reads++;
    assert.equal(request.sessionId, "plugin");
    if (request.capabilityToken !== "secret") throw new Error("invalid capability");
    if (delayedRead) {
      delayedRead = false;
      return new Promise((resolve) => { releaseRead = () => resolve({ ok: true, status: state, output: [] }); });
    }
    return { ok: true, status: state, nextSequence: output.length + 1, output: output.filter((entry) => entry.sequence > (request.payload.afterSequence || 0)) };
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  async function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/figma`);
    socket.on("error", () => {});
    t.after(() => socket.terminate());
    const messages = [];
    socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "plugin.register", sessionId: "plugin", figma: { fileKey: "file" } }));
    await until(() => messages.some((message) => message.type === "plugin.registered"));
    return { socket, messages };
  }
  let { socket, messages } = await connect();
  const send = (id, token, afterSequence = 0) => socket.send(JSON.stringify({ type: "relay.request", requestId: id, action: "ai.run.subscribe", capabilityToken: token, payload: { runId: "run", afterSequence } }));
  send("denied", "bad");
  await until(() => messages.some((message) => message.requestId === "denied"));
  assert.equal(messages.find((message) => message.requestId === "denied").ok, false);
  assert.equal(messages.filter((message) => message.type === "relay.event").length, 0);
  send("sub1", "secret");
  await until(() => messages.some((message) => message.subscriptionId === "sub1"));
  // 变化驱动：没有变化就完全不拉取（取代原先每 250ms 无条件 get）。
  const idleReads = reads;
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(reads, idleReads, "an idle subscription must not poll");
  assert.equal(messages.filter((message) => message.type === "relay.event").length, 1);
  socket.send(JSON.stringify({ type: "relay.request", requestId: "import-sub", action: "prefab.import.subscribe", payload: { taskId: "import-task" } }));
  await until(() => messages.some((message) => message.type === "relay.event" && message.taskId === "import-task"));
  assert.equal(messages.find((message) => message.taskId === "import-task").subscriptionId, "import-sub");
  socket.send(JSON.stringify({ type: "relay.request", requestId: "psd-sub", action: "psd.import.subscribe", payload: { taskId: "psd-task" } }));
  await until(() => messages.some((message) => message.type === "relay.event" && message.taskId === "psd-task"));
  socket.send(JSON.stringify({ type: "relay.request", requestId: "psd-unsubscribe", action: "psd.import.unsubscribe", payload: {} }));
  await until(() => messages.some((message) => message.requestId === "psd-unsubscribe"));
  socket.send(JSON.stringify({ type: "relay.request", requestId: "import-unsubscribe", action: "prefab.import.unsubscribe", payload: {} }));
  await until(() => messages.some((message) => message.requestId === "import-unsubscribe"));
  socket.send(JSON.stringify({ type: "relay.request", requestId: "figma-sub", action: "figma.prefab.subscribe", payload: { taskId: "figma-task" } }));
  await until(() => messages.some((message) => message.type === "relay.event" && message.taskId === "figma-task"));
  socket.send(JSON.stringify({ type: "relay.request", requestId: "figma-unsubscribe", action: "figma.prefab.unsubscribe", payload: {} }));
  await until(() => messages.some((message) => message.requestId === "figma-unsubscribe"));
  const readsBeforePush = reads;
  output.push({ sequence: 2, text: "second" });
  state = "completed";
  notifyRunChanged("run");
  await until(() => messages.some((message) => message.result?.status === "completed"));
  assert.equal(reads, readsBeforePush + 1, "one change must trigger exactly one read");
  assert.deepEqual(messages.filter((message) => message.type === "relay.event").at(-1).result.output, [{ sequence: 2, text: "second" }]);
  assert.equal(messages.filter((message) => message.type === "relay.event" && message.taskId === "import-task").length, 1);
  socket.close();
  await once(socket, "close");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const disconnectedReads = reads;
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(reads, disconnectedReads);
  ({ socket, messages } = await connect());
  send("sub2", "secret", 1);
  await until(() => messages.some((message) => message.type === "relay.event"));
  assert.deepEqual(messages.find((message) => message.type === "relay.event").result.output, [{ sequence: 2, text: "second" }]);
  socket.send(JSON.stringify({ type: "relay.request", requestId: "unsubscribe", action: "ai.run.unsubscribe", payload: {} }));
  await until(() => messages.some((message) => message.requestId === "unsubscribe"));
  const stoppedReads = reads;
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(reads, stoppedReads);
  delayedRead = true;
  send("racing", "secret", 2);
  await until(() => releaseRead);
  socket.send(JSON.stringify({ type: "relay.request", requestId: "cancel-racing", action: "ai.run.unsubscribe", payload: {} }));
  await until(() => messages.some((message) => message.requestId === "cancel-racing"));
  releaseRead();
  await until(() => messages.some((message) => message.requestId === "racing"));
  assert.equal(messages.find((message) => message.requestId === "racing").ok, false);
  assert.equal(messages.filter((message) => message.type === "relay.event" && message.subscriptionId === "racing").length, 0);
});

async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Expected WebSocket message did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
