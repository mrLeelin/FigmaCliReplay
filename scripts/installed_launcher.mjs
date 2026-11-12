import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readInstall, runtimeEnvironment, versionRoot, waitForHealth, relayControl } from "./update_common.mjs";

const defaultRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const startedChildren = new Map();
export function childIsAlive(pid) {
  const child = startedChildren.get(pid);
  if (child) return child.exitCode === null && child.signalCode === null;
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
/** Kill only a child we launched, or an exact journal-owned executable/argv/creation-time match. */
export async function terminateStartedRuntime(root, runtime) {
  const child = startedChildren.get(runtime.pid);
  if (child) {
    if (path.resolve(child.spawnargs[1] ?? "") !== path.resolve(runtime.entry)) throw new Error("The recorded runtime is not the updater-owned child.");
    if (child.exitCode === null && child.signalCode === null) child.kill();
  } else {
    if (!childIsAlive(runtime.pid)) return;
    if (process.platform !== "win32") throw new Error("Cannot independently verify the interrupted update process on this platform.");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "updater", "inspect_update_process.ps1"), "-ProcessId", String(runtime.pid)], { windowsHide: true, encoding: "utf8", timeout: 15000 });
    if (result.status !== 0) throw new Error("Could not verify the interrupted new Relay process; it was not terminated.");
    const identity = JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
    const args = identity.arguments;
    if (identity.pid !== runtime.pid || path.resolve(identity.executablePath).toLowerCase() !== path.resolve(process.execPath).toLowerCase()
      || !Array.isArray(args) || args.length !== 4 || path.resolve(args[1]) !== path.resolve(runtime.entry) || args[2] !== "--port" || args[3] !== String(runtime.port)
      || !Number.isFinite(Date.parse(runtime.startedAt)) || Math.abs(Date.parse(identity.startedAt) - Date.parse(runtime.startedAt)) > 5000) throw new Error("Interrupted Relay process identity changed; it was not terminated.");
    process.kill(runtime.pid);
  }
  const deadline = Date.now() + 10000;
  while (childIsAlive(runtime.pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  if (childIsAlive(runtime.pid)) throw new Error("The updater-owned new Relay did not exit.");
}
export async function runInstalledCli(args, root = defaultRoot()) {
  const record = readInstall(root), release = versionRoot(root, record.currentVersion);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(release, "dist", "cli.js"), ...args], { cwd: release, env: runtimeEnvironment(root, release), stdio: "inherit", windowsHide: true });
    child.once("error", reject); child.once("exit", (value) => resolve(value ?? 1));
  });
  process.exitCode = code;
}
export async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once("error", () => reject(new Error(`Port ${port} is occupied. The updater will not stop another application.`)));
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}
export async function launchRuntime(root, version, port = 32130, options = {}) {
  const releaseRoot = versionRoot(root, version), entry = path.join(releaseRoot, "dist", "index.js");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid Relay port.");
  await assertPortFree(port);
  const environment = runtimeEnvironment(root, releaseRoot);
  if (options.instanceId) environment.FIGMA_RELAY_INSTANCE_ID = options.instanceId;
  const logRoot = path.join(root, "data", ".logs"); fs.mkdirSync(logRoot, { recursive: true });
  const output = fs.openSync(path.join(logRoot, "relay.stdout.log"), "a"), errors = fs.openSync(path.join(logRoot, "relay.stderr.log"), "a");
  let child;
  try {
    child = spawn(process.execPath, [entry, "--port", String(port)], { cwd: releaseRoot, env: environment, detached: true, windowsHide: true, stdio: ["ignore", output, errors] });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }); child.unref();
    startedChildren.set(child.pid, child);
  } finally { fs.closeSync(output); fs.closeSync(errors); }
  return { pid: child.pid, entry, port, tokenFile: path.join(root, "data", ".local", "admin-token.txt"), instanceId: environment.FIGMA_RELAY_INSTANCE_ID, startedAt: new Date().toISOString() };
}
export async function startInstalled(root = defaultRoot(), port = 32130) {
  const record = readInstall(root), releaseRoot = versionRoot(root, record.currentVersion);
  const runtimeFile = path.join(root, "data", ".local", "runtime.json");
  if (fs.existsSync(runtimeFile)) {
    const existing = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
    if (path.resolve(existing.entry ?? "") === path.join(releaseRoot, "dist", "index.js") && existing.port === port) {
      try {
        const activity = await relayControl(root, releaseRoot, record.currentVersion, existing, "relay.update.activity");
        if (activity.pid === existing.pid && activity.instanceId === existing.instanceId && activity.entry === existing.entry) return { ok: true, alreadyRunning: true, version: record.currentVersion, pid: existing.pid };
      } catch { /* A stale record is harmless; the port is checked before starting. */ }
    }
  }
  const runtime = await launchRuntime(root, record.currentVersion, port);
  try { await waitForHealth(root, releaseRoot, record.currentVersion, runtime); }
  catch (error) { await terminateStartedRuntime(root, runtime); throw error; }
  return { ok: true, version: record.currentVersion, pid: runtime.pid };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const command = process.argv[2] || "start";
    const { values } = parseArgs({ args: process.argv.slice(3), options: { port: { type: "string" }, "install-root": { type: "string" } } });
    const root = path.resolve(values["install-root"] ?? defaultRoot());
    if (command === "repair") {
      const { recoverUpdate } = await import("./apply_update.mjs");
      const recovered = await recoverUpdate(root);
      const result = await startInstalled(root, Number(values.port ?? 32130));
      process.stdout.write(JSON.stringify({ ...result, ...(recovered ? { recovered } : {}) }, null, 2) + "\nRelay started. Open the plugin Settings > Version and updates to check for updates.\n");
    } else if (command === "start") process.stdout.write(JSON.stringify(await startInstalled(root, Number(values.port ?? 32130)), null, 2) + "\n");
    else throw new Error("Expected start or repair.");
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
