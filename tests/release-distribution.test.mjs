import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Set this to a freshly extracted archive after running its first-install script.
const releaseRoot = process.env.FIGMA_RELAY_RELEASE_ROOT;
test("extracted distribution installs Bridge with its local token and preserves project references", {
  skip: !releaseRoot,
}, (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "relay-release-project-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const inputRoot = path.resolve(releaseRoot);
  const root = path.join(fixture, 'Relay 副本');
  fs.cpSync(inputRoot, root, { recursive: true, filter: (source) =>
    !/^(node_modules|\.venv|\.local|\.logs)(?:[\\/]|$)/.test(path.relative(inputRoot, source)) });
  fs.symlinkSync(path.join(inputRoot, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  const project = path.join(fixture, "Unity 工程 with spaces");
  fs.mkdirSync(path.join(project, "Assets", "Editor", "FigmaBridge"), { recursive: true });
  fs.mkdirSync(path.join(project, "ProjectSettings"));
  const settingsFile = path.join(project, "ProjectSettings", "FigmaBridgeImportSettings.json");
  fs.writeFileSync(settingsFile, JSON.stringify({ commonFontAsset: "Assets/KeepFont.asset" }));
  const targetMeta = path.join(project, "Assets", "Editor", "FigmaBridge.meta");
  const originalMeta = "fileFormatVersion: 2\nguid: 123456789012345678901234567890ab\n";
  fs.writeFileSync(targetMeta, originalMeta);
  const env = { ...process.env, FIGMA_RELAY_TOKEN: "", FIGMA_RELAY_BRIDGE_TOKEN: "" };
  const installer = path.join(root, "scripts", "install_unity_bridge.ps1");
  const invoke = (target) => spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer, "-ProjectPath", target], {
    cwd: fixture, env, encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  const tokenFile = path.join(root, ".local", "admin-token.txt");
  assert.equal(fs.existsSync(tokenFile), false, 'isolated package starts without a local token');
  const noToken = invoke(project);
  assert.equal(fs.existsSync(tokenFile), false, 'installer must not create a local Relay token');
  assert.notEqual(noToken.status, 0, noToken.stderr || noToken.stdout);
  assert.match(noToken.stderr, /Start this package's Relay first/);
  assert.match(noToken.stderr, /failed/);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile)).relayToken, undefined);
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  const token = "distribution-test-local-token";
  fs.writeFileSync(tokenFile, token);
  const invalid = invoke(fixture);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /must contain Assets and ProjectSettings/);
  const installed = invoke(project);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.match(installed.stderr, /succeeded/);
  assert.equal((installed.stdout + installed.stderr).includes(token), false, "installation logs must not expose the token");
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")), {
    commonFontAsset: "Assets/KeepFont.asset", relayToken: token,
  });
  assert.equal(fs.readFileSync(targetMeta, "utf8"), originalMeta);
  const bridgeRelative = "unity/Assets/Editor/FigmaBridge/FigmaBridgeServer.cs";
  assert.equal(fs.readFileSync(path.join(project, "Assets/Editor/FigmaBridge/FigmaBridgeServer.cs"), "utf8"),
    fs.readFileSync(path.join(root, bridgeRelative), "utf8"));
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const bridgeVersion = fs.readFileSync(path.join(root, bridgeRelative), "utf8").match(/private const string Version = "([^"]+)"/)[1];
  assert.equal(bridgeVersion, version);
});

test("extracted launcher uses its private Python and reports the packaged version over WebSocket", {
  skip: !releaseRoot,
}, async (t) => {
  const root = path.resolve(releaseRoot);
  const requireFromRelease = createRequire(path.join(root, "package.json"));
  assert.ok(requireFromRelease.resolve("ws").startsWith(path.join(root, "node_modules")));
  const WebSocket = requireFromRelease("ws");
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    path.join(root, "scripts", "start_relay.ps1"), "-Port", String(port), "-Foreground"], {
    cwd: os.tmpdir(), windowsHide: true,
    env: { ...process.env, FIGMA_RELAY_TOKEN: "", FIGMA_RELAY_BRIDGE_TOKEN: "", FIGMA_RELAY_PYTHON: "", LOG_LEVEL: "info" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let relayPid;
  t.after(async () => {
    if (child.exitCode === null) {
      const closed = once(child, "close");
      if (relayPid) { try { process.kill(relayPid); } catch { /* Already exited. */ } }
      child.kill();
      await closed;
    }
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const startup = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Packaged launcher timed out: ${stderr}`)), 20_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Packaged launcher exited ${code}: ${stderr}`)); });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (const line of stdout.split(/\r?\n/)) {
        try {
          const value = JSON.parse(line);
          if (value.status === "listening") { clearTimeout(timer); resolve(value); }
        } catch { /* Launcher status text can precede protocol JSON. */ }
      }
    });
  });
  assert.equal(startup.pythonWorker.available, true);
  relayPid = Number(stderr.match(/"pid":(\d+)/)?.[1]);
  assert.ok(relayPid, "capture the test-owned Relay PID for cleanup");
  assert.ok(startup.pythonWorker.command.startsWith(path.join(root, ".venv", "Scripts", "python.exe")));
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const token = fs.readFileSync(path.join(root, ".local", "admin-token.txt"), "utf8").trim();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/relay`, { headers: { Authorization: `Bearer ${token}` } });
  t.after(() => socket.terminate());
  await once(socket, "open");
  const response = once(socket, "message");
  socket.send(JSON.stringify({ type: "relay.hello", role: "cli", protocolVersion: 1, clientVersion: version }));
  const [raw] = await response;
  assert.deepEqual(JSON.parse(String(raw)), { type: "relay.ready", protocolVersion: 1, serverVersion: version });
  assert.equal((stdout + stderr).includes(token), false);
  socket.close();
});
