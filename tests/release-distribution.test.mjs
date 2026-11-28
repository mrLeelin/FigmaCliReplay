import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { removeTree } from "../scripts/install_release.mjs";
import { terminateStartedRuntime } from "../scripts/installed_launcher.mjs";
import { relayControl, versionRoot } from "../scripts/update_common.mjs";

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
  const localAppData = path.join(fixture, "User Data");
  const env = { ...process.env, LOCALAPPDATA: localAppData, FIGMA_RELAY_TOKEN: "", FIGMA_RELAY_BRIDGE_TOKEN: "" };
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
    commonFontAsset: "Assets/KeepFont.asset",
  });
  const credentialDir = path.join(localAppData, "FigmaRelay", "unity-bridge");
  const credentialNames = fs.readdirSync(credentialDir);
  assert.equal(credentialNames.length, 1);
  assert.equal(fs.readFileSync(path.join(credentialDir, credentialNames[0]), "utf8"), token);
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
  const pythonPath = fs.existsSync(path.join(root, "runtime", "windows-x64.json"))
    ? path.join(root, "runtime", "python", "python.exe") : path.join(root, ".venv", "Scripts", "python.exe");
  assert.ok(startup.pythonWorker.command.startsWith(pythonPath));
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

test("Windows release starts from its ZIP entry with no Node, Python, npm or pip on PATH", {
  skip: !process.env.FIGMA_RELAY_RELEASE_ZIP || process.platform !== "win32",
  timeout: 120_000,
}, async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "relay-clean-distribution-"));
  const extracted = path.join(fixture, "解压 with spaces");
  const root = path.join(fixture, "安装 with spaces");
  const archive = path.resolve(process.env.FIGMA_RELAY_RELEASE_ZIP);
  const runtimeFile = path.join(root, "data", ".local", "runtime.json");
  t.after(async () => {
    if (fs.existsSync(runtimeFile)) await terminateStartedRuntime(root, JSON.parse(fs.readFileSync(runtimeFile)));
    removeTree(fixture, os.tmpdir());
  });

  const systemRoot = process.env.SystemRoot;
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const system = [path.join(systemRoot, "System32"), systemRoot, path.dirname(powershell)].join(path.delimiter);
  const extract = spawnSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    fileURLToPath(new URL("../scripts/extract_update.ps1", import.meta.url)), "-Archive", archive, "-Destination", extracted], {
    encoding: "utf8", windowsHide: true, timeout: 45_000,
  });
  assert.equal(extract.status, 0, extract.stderr || extract.error?.message);

  const reserved = createServer();
  await new Promise((resolve) => reserved.listen(0, "127.0.0.1", resolve));
  const port = reserved.address().port;
  await new Promise((resolve) => reserved.close(resolve));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|python.*|figma_relay_.*|node_options)$/i.test(key))),
    Path: system, NPM_CONFIG_OFFLINE: "true", PIP_NO_INDEX: "1",
    RELAY_TEST_LAUNCHER: path.join(extracted, "Open Figma Relay.bat"), RELAY_TEST_INSTALL: root, RELAY_TEST_PORT: String(port),
  };
  const firstUse = () => spawnSync(powershell, ["-NoProfile", "-Command",
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); & $env:RELAY_TEST_LAUNCHER -InstallRoot $env:RELAY_TEST_INSTALL -Port $env:RELAY_TEST_PORT -SkipAutostart -NoExplorer; exit $LASTEXITCODE"], {
    cwd: fixture, env, encoding: "utf8", windowsHide: true, timeout: 60_000,
  });
  const installed = firstUse();
  assert.equal(installed.status, 0, installed.stderr || installed.error?.message);
  assert.match(installed.stdout, /Ready \(v/);
  assert.ok(installed.stdout.includes(path.join(root, "plugin", "manifest.json")), installed.stdout);
  assert.match(installed.stderr, /dependencies\.verify-bundle/);
  assert.doesNotMatch(installed.stderr, /npm\.install|python\.pip/);

  const { currentVersion } = JSON.parse(fs.readFileSync(path.join(root, "install.json")));
  const release = versionRoot(root, currentVersion);
  const runtime = JSON.parse(fs.readFileSync(runtimeFile));
  const activity = await relayControl(root, release, currentVersion, runtime, "relay.update.activity");
  assert.equal(activity.pid, runtime.pid);
  assert.equal(activity.entry, path.join(release, "dist", "index.js"));
  assert.ok(fs.existsSync(path.join(root, "plugin", "manifest.json")));
  const startup = fs.readFileSync(path.join(root, "data", ".logs", "relay.stdout.log"), "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.equal(startup.find((entry) => entry.status === "listening")?.pythonWorker?.available, true);

  const WebSocket = createRequire(path.join(release, "package.json"))("ws");
  const plugin = new WebSocket(`ws://127.0.0.1:${port}/figma`, { origin: "https://www.figma.com" });
  t.after(() => plugin.terminate());
  await once(plugin, "open");
  const registered = once(plugin, "message");
  plugin.send(JSON.stringify({ type: "plugin.register", sessionId: "distribution-figma-fixture", figma: { fileName: "Fixture" } }));
  assert.equal(JSON.parse(String((await registered)[0])).type, "plugin.registered");
  const sessions = spawnSync(powershell, ["-NoProfile", "-Command",
    "& $env:RELAY_TEST_CLI sessions --url ('ws://127.0.0.1:' + $env:RELAY_TEST_PORT + '/relay'); exit $LASTEXITCODE"], {
    cwd: fixture, env: { ...env, RELAY_TEST_CLI: path.join(root, "figma-relay.cmd") }, encoding: "utf8", windowsHide: true, timeout: 20_000,
  });
  assert.equal(sessions.status, 0, sessions.stderr || sessions.error?.message);
  assert.equal(JSON.parse(sessions.stdout).result.sessions[0].sessionId, "distribution-figma-fixture");
  plugin.terminate();

  const python = path.join(release, "runtime", "python", "python.exe");
  const psd = spawnSync(python, ["-I", "-B", "-c", [
    "import os, sys", "from psd_tools import PSDImage",
    "assert os.path.normcase(sys.prefix) == os.path.normcase(os.path.dirname(sys.executable))",
    "file = sys.argv[1]", "PSDImage.new('RGB', (12, 8), color=(0, 1, 0)).save(file)",
    "assert PSDImage.open(file).composite().size == (12, 8)", "os.remove(file)",
  ].join("\n"), path.join(fixture, "fixture.psd")], { cwd: fixture, env, encoding: "utf8", windowsHide: true, timeout: 20_000 });
  assert.equal(psd.status, 0, psd.stderr || psd.error?.message);

  const repeated = firstUse();
  assert.equal(repeated.status, 0, repeated.stderr || repeated.error?.message);
  assert.equal(JSON.parse(fs.readFileSync(runtimeFile)).pid, runtime.pid);
  await terminateStartedRuntime(root, runtime);
  const restarted = spawnSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "start_installed.ps1"), "-Port", String(port)], {
    cwd: fixture, env, encoding: "utf8", windowsHide: true, timeout: 25_000,
  });
  assert.equal(restarted.status, 0, restarted.stderr || restarted.error?.message);
  const newRuntime = JSON.parse(fs.readFileSync(runtimeFile));
  assert.notEqual(newRuntime.pid, runtime.pid);
  assert.equal((await relayControl(root, release, currentVersion, newRuntime, "relay.update.activity")).pid, newRuntime.pid);
});
