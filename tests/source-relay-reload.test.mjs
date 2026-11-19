import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WebSocket from "ws";
import { writeRelayBuild } from "../scripts/relay_build_stamp.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));

async function waitFor(f, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await f();
    if (result) return result;
    await sleep(50);
  } while (Date.now() < deadline);
  throw new Error(message);
}

test("opening the plugin only switches a complete idle local build, once, and the launcher recovers after a crash", { timeout: 25000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-relay-reload-"));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  const data = path.join(root, "data");
  const busyFile = path.join(root, "fixture-busy");
  fs.cpSync(path.join(repo, "dist"), path.join(root, "dist"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"));
  for (const name of ["relay_supervisor.mjs", "relay_build_stamp.mjs", "update_common.mjs"]) {
    fs.copyFileSync(path.join(repo, "scripts", name), path.join(root, "scripts", name));
  }
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(root, "node_modules"), "junction");
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  const version = pkg.version;
  const [major, minor, patch] = version.split(".");
  const newer = `${major}.${minor}.${Number.parseInt(patch, 10) + 1}`;
  const configFile = path.join(root, "dist", "config.js");
  const builtConfig = fs.readFileSync(configFile, "utf8");
  const entry = path.join(root, "dist", "index.js");
  const holdActivity = `import { existsSync as fixtureExists } from "node:fs";
import { beginRuntimeControl as holdFixtureActivity } from "./updateActivity.js";
const fixtureBusyFile = ${JSON.stringify(busyFile)};
if (fixtureExists(fixtureBusyFile)) {
  const release = holdFixtureActivity();
  const timer = setInterval(() => {
    if (!fixtureExists(fixtureBusyFile)) { clearInterval(timer); release(); }
  }, 25);
  timer.unref();
}
`;
  fs.writeFileSync(entry, holdActivity + fs.readFileSync(entry, "utf8"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
  fs.writeFileSync(busyFile, "hold");
  writeRelayBuild(root);

  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  const token = "isolated-relay-reload-token";
  const launcher = spawn(process.execPath, [path.join(root, "scripts", "relay_supervisor.mjs"), "--port", String(port), "--no-python-worker"], {
    cwd: root,
    env: { ...process.env, FIGMA_RELAY_DATA_ROOT: data, FIGMA_RELAY_INSTALL_ROOT: "", FIGMA_RELAY_TOKEN: token, FIGMA_RELAY_BRIDGE_TOKEN: token },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  launcher.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const sockets = [];
  t.after(async () => {
    sockets.forEach(socket => socket.terminate());
    if (launcher.exitCode === null) {
      launcher.kill();
      await once(launcher, "exit");
    }
    const launchedPids = [...stderr.matchAll(/"step":"spawn"[^\n]+?"pid":(\d+)/g)].map(match => Number(match[1]));
    for (const pid of new Set(launchedPids)) {
      try { process.kill(pid); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function exchange(endpoint, headers, ...messages) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/${endpoint}`, { headers, handshakeTimeout: 1000 });
    sockets.push(socket);
    await once(socket, "open");
    try {
      let response;
      for (const message of messages) {
        const received = once(socket, "message", { signal: AbortSignal.timeout(1200) });
        socket.send(JSON.stringify(message));
        response = JSON.parse(String((await received)[0]));
        if (response.type === "relay.error") return response;
      }
      return response;
    } finally {
      if (endpoint === "relay") socket.terminate();
    }
  }
  const requestActivity = async clientVersion => {
    try {
      const response = await exchange("relay", { Authorization: `Bearer ${token}` },
        { type: "relay.hello", role: "cli", protocolVersion: 1, clientVersion },
        { type: "relay.request", requestId: "activity", operationId: "activity", action: "relay.control", payload: { controlAction: "relay.update.activity", controlPayload: {} } });
      return response?.result;
    } catch { return undefined; }
  };
  const openPlugin = async sessionId => {
    const response = await exchange("figma", { Origin: "https://www.figma.com" },
      { type: "plugin.register", sessionId, figma: { editorType: "figma" } });
    assert.equal(response.type, "plugin.registered");
  };
  const existing = await waitFor(() => requestActivity(version), "old Relay did not start").catch(error => {
    throw new Error(`${error.message}\n${stderr.slice(-4500)}`);
  });
  assert.equal(existing.activeCount, 1);
  await openPlugin("complete-current-build");
  assert.equal((await requestActivity(version)).pid, existing.pid);

  fs.writeFileSync(configFile, builtConfig.replace(`SERVER_VERSION = "${version}"`, `SERVER_VERSION = "${newer}"`));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ ...pkg, version: newer }));
  await openPlugin("build-in-progress");
  assert.equal((await requestActivity(version)).pid, existing.pid);
  writeRelayBuild(root);

  await Promise.all([openPlugin("first-window"), openPlugin("second-window")]);
  await waitFor(() => /"step":"activity".*"activeCount":1/.test(stderr), "old Relay did not wait for work");
  assert.equal((await requestActivity(version)).pid, existing.pid);
  fs.unlinkSync(busyFile);
  const updated = await waitFor(() => requestActivity(newer), "new Relay did not start");
  assert.notEqual(updated.pid, existing.pid);
  assert.equal(updated.version, newer);
  await openPlugin("reconnected-window");
  assert.equal((await requestActivity(newer)).pid, updated.pid);
  assert.equal((stderr.match(/"signal":"source-reload"/g) ?? []).length, 1);

  process.kill(updated.pid, "SIGKILL");
  const recovered = await waitFor(async () => {
    const next = await requestActivity(newer);
    return next?.pid !== updated.pid && next;
  }, "supervisor did not recover its Relay");
  assert.equal(recovered.version, newer);
  assert.notEqual(recovered.pid, updated.pid);
});
