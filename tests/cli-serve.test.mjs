import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../dist/config.js";
import { createLoggingRuntime } from "../dist/logging/loggingRuntime.js";
import { createRelayControlHandler } from "../dist/relayControl.js";
import { RuntimeRelay } from "../dist/runtimeRelay.js";
import { WebSocketGateway } from "../dist/websocketGateway.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

async function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-relay-serve-"));
  const logging = createLoggingRuntime({ directory: path.join(root, "logs"), level: "silent" });
  const config = { ...parseArgs([]), adminToken: "" };
  const gateway = new WebSocketGateway();
  const relay = new RuntimeRelay(config, gateway, { status: () => ({ enabled: false }) }, logging);
  let connections = 0;
  const server = createServer((_request, response) => { response.writeHead(404).end(); });
  server.on("connection", () => { connections += 1; });
  t.after(async () => {
    relay.dispose();
    gateway.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await logging.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { RelayCliEndpoint } = await import("../dist/relayCliEndpoint.js");
  gateway.attachServer(server, new RelayCliEndpoint(config, relay, logging, createRelayControlHandler({ status: () => ({ status: "ok" }) }, {})));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `ws://127.0.0.1:${server.address().port}`, connectionCount: () => connections };
}

async function until(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

test("serve mode reuses one process and one Relay connection for many requests", { timeout: 30000 }, async (t) => {
  const h = await harness(t);
  const child = spawn(process.execPath, [cliPath, "serve", "--url", `${h.base}/relay`], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { try { child.kill(); } catch { /* 已退出 */ } });
  const lines = [];
  let stderr = "";
  createInterface({ input: child.stdout }).on("line", (line) => lines.push(line));
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  assert.ok(await until(() => lines.some((line) => JSON.parse(line).type === "serve.ready")), "serve 应先报告就绪: " + stderr);

  const statusLine = JSON.stringify({ action: "relay.control", payload: { controlAction: "relay.status", controlPayload: {} } });
  child.stdin.write(statusLine + "\n");
  assert.ok(await until(() => lines.filter((line) => !JSON.parse(line).type).length >= 1), "第一条请求应有响应");
  child.stdin.write(statusLine + "\n");
  assert.ok(await until(() => lines.filter((line) => !JSON.parse(line).type).length >= 2), "第二条请求应有响应");
  child.stdin.write("{ this is not json }\n");
  assert.ok(await until(() => lines.filter((line) => !JSON.parse(line).type).length >= 3), "非法行也应有响应");

  const responses = lines.map((line) => JSON.parse(line)).filter((message) => !message.type);
  assert.equal(responses.length, 3);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[0].result.status, "ok");
  assert.equal(responses[1].ok, true, "同一条连接上的第二轮请求必须可用");
  assert.equal(responses[1].result.status, "ok");
  assert.equal(responses[2].ok, false);
  assert.equal(responses[2].error.code, "USAGE");
  assert.ok(responses[0].requestId && responses[0].requestId !== responses[1].requestId);

  assert.equal(h.connectionCount(), 1, "三轮请求只应建立一条连接（不再每命令一次进程+握手）");

  // stdin EOF → 正常收尾并退出
  child.stdin.end();
  const exitCode = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(exitCode, 0, "stdin 结束后应以 0 退出");
  const closed = lines.map((line) => JSON.parse(line)).find((message) => message.type === "serve.closed");
  assert.ok(closed, "应报告 serve.closed");
  assert.equal(closed.requests, 3);
});
