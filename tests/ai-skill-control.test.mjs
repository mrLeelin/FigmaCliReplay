import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocket } from "ws";

import { createAiSkillService } from "../dist/aiSkillManager.js";
import { createRelayControlHandler } from "../dist/relayControl.js";
import { WebSocketGateway } from "../dist/websocketGateway.js";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "figma-relay-skill-control-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const service = createAiSkillService({ home });
  const control = createRelayControlHandler({ status: () => ({ plugin: { sessions: [] } }) }, {}, undefined, undefined, undefined, undefined, service);
  return { home, control };
}

test("Skill controls check then write only their fixed destinations", async (t) => {
  const { home, control } = fixture(t);
  const initial = await control("ai.skill.status", {});
  assert.ok(initial.installations.every((entry) => entry.status === "missing"));
  assert.deepEqual(fs.readdirSync(home), []);
  const installed = await control("ai.skill.install", { target: "codex", sessionId: "plugin", fileKey: "file", capabilityToken: "" });
  assert.equal(installed.installations[0].status, "installed");
  assert.equal(installed.installations[0].current, true);
  assert.equal(installed.installations[0].directory, path.join(home, ".agents", "skills", "figma-relay"));
  assert.equal(fs.existsSync(path.join(home, ".claude")), false);
  for (const payload of [{ home: "E:/Arbitrary" }, { path: "E:/Arbitrary" }, { target: "other" }, { target: 1 }, { target: null }, { projectRoot: "E:/Arbitrary" }]) {
    await assert.rejects(control("ai.skill.install", payload), /only accept target|target must/);
  }
});

test("authenticated plugin requests roundtrip status, install and fresh status through the production adapter envelope", async (t) => {
  const { home, control } = fixture(t);
  const gateway = new WebSocketGateway();
  const server = createServer();
  gateway.attachServer(server);
  let calls = 0;
  gateway.onClientRequest((request) => {
    calls++;
    // Keep this equal to the adapter in src/index.ts, including empty capabilityToken.
    return control(request.action, { ...request.payload, sessionId: request.sessionId, fileKey: request.fileKey, capabilityToken: request.capabilityToken }, request.operationId);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/figma`);
  t.after(async () => { socket.terminate(); gateway.close(); await new Promise((resolve) => server.close(resolve)); });
  const messages = [];
  socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await once(socket, "open");
  async function request(id, action, payload = {}) {
    socket.send(JSON.stringify({ type: "relay.request", requestId: id, action, payload }));
    const deadline = Date.now() + 2000;
    while (!messages.some((entry) => entry.requestId === id)) {
      if (Date.now() > deadline) throw new Error(`No response for ${id}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return messages.find((entry) => entry.requestId === id);
  }
  const rejected = await request("unauthenticated", "ai.skill.install");
  assert.equal(rejected.ok, false);
  assert.equal(calls, 0);
  assert.deepEqual(fs.readdirSync(home), []);
  const registered = once(socket, "message");
  socket.send(JSON.stringify({ type: "plugin.register", sessionId: "skill-plugin", figma: { fileKey: "skill-file" } }));
  await registered;
  const before = await request("check", "ai.skill.status");
  assert.equal(before.ok, true);
  assert.ok(before.result.installations.every((entry) => entry.status === "missing"));
  const install = await request("install", "ai.skill.install", { target: "claude" });
  assert.equal(install.ok, true);
  assert.equal(install.result.installations[0].current, true);
  const after = await request("check-after", "ai.skill.status");
  assert.deepEqual(after.result.installations.map((entry) => entry.status), ["missing", "installed"]);
  const malicious = await request("reject-path", "ai.skill.install", { target: "codex", home: "E:/Arbitrary" });
  assert.equal(malicious.ok, false);
  assert.equal(fs.existsSync(path.join(home, ".agents")), false);
});
