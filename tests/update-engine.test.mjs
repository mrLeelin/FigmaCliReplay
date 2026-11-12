import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { acquireLock, compareVersions, downloadFile, hashFile, parseSignedManifest, readInstall, relayControl, versionRoot, waitForHealth, writeJsonAtomic } from "../scripts/update_common.mjs";
import { installRelease, removeTree } from "../scripts/install_release.mjs";
import { applyUpdate, extractArchive, recoverUpdate, stopOwnedRuntime } from "../scripts/apply_update.mjs";
import { launchRuntime, terminateStartedRuntime } from "../scripts/installed_launcher.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keys = crypto.generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
const config = { schemaVersion: 1, publicKey, manifestUrl: "https://updates.example.test/latest.json" };
const sign = (payload) => { const bytes = Buffer.from(JSON.stringify(payload)); return { schemaVersion: 1, payload: bytes.toString("base64"), signature: crypto.sign(null, bytes, keys.privateKey).toString("base64") }; };
const payload = (extra = {}) => ({ schemaVersion: 1, version: "1.1.0", publishedAt: new Date().toISOString(), notes: ["Fixture release"], archiveUrl: "https://updates.example.test/app.zip", sha256: "a".repeat(64), size: 1, ...extra });
const temporary = (t, cleanup = true) => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "Relay 更新 with spaces-")); if (cleanup) t.after(() => removeTree(root, os.tmpdir())); return root; };
async function freePort() { const server = net.createServer(); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port; }
function fixturePackage(root, version, { broken = false, hang = false } = {}) {
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true }); fs.mkdirSync(path.join(root, "dist")); fs.mkdirSync(path.join(root, "server"));
  for (const name of ["update_common.mjs", "apply_update.mjs", "install_release.mjs", "installed_launcher.mjs", "installed_bootstrap.mjs", "extract_update.ps1", "inspect_update_process.ps1"]) fs.copyFileSync(path.join(projectRoot, "scripts", name), path.join(root, "scripts", name));
  writeJsonAtomic(path.join(root, "package.json"), { type: "module", version }); writeJsonAtomic(path.join(root, "release-config.json"), config);
  writeJsonAtomic(path.join(root, "manifest.json"), { name: "fixture", id: "fixture", main: "code.js", ui: "ui.html" });
  fs.writeFileSync(path.join(root, "code.js"), version); fs.writeFileSync(path.join(root, "ui.html"), version); fs.writeFileSync(path.join(root, "server", "requirements.txt"), "");
  fs.writeFileSync(path.join(root, "dist", "cli.js"), "console.log('fixture cli ' + process.env.FIGMA_RELAY_DATA_ROOT);\n");
  fs.writeFileSync(path.join(root, "dist", "index.js"), broken ? "process.exit(42);\n" : hang ? "import net from 'node:net'; const port=Number(process.argv[process.argv.indexOf('--port')+1]);net.createServer(()=>{}).listen(port,'127.0.0.1');\n" : `
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import {createRequire} from 'node:module';
const {WebSocketServer} = createRequire(import.meta.url)('ws');
const version = ${JSON.stringify(version)}, entry = process.argv[1], port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const data = process.env.FIGMA_RELAY_DATA_ROOT, token = process.env.FIGMA_RELAY_TOKEN, instanceId = process.env.FIGMA_RELAY_INSTANCE_ID;
const runtime = {schemaVersion:1,pid:process.pid,entry,port,instanceId,tokenFile:path.join(data,'.local','admin-token.txt'),startedAt:new Date().toISOString()};
fs.mkdirSync(path.join(data,'.local'),{recursive:true});fs.writeFileSync(path.join(data,'.local','runtime.json'),JSON.stringify(runtime));
const server = http.createServer(), wss = new WebSocketServer({noServer:true});
server.on('upgrade',(req,sock,head)=> {if(req.headers.authorization!=='Bearer '+token) return sock.destroy();wss.handleUpgrade(req,sock,head,ws=>wss.emit('connection',ws));});
wss.on('connection',ws=>ws.on('message',raw=>{const msg=JSON.parse(String(raw));if(msg.type==='relay.hello')return ws.send(JSON.stringify({type:'relay.ready',protocolVersion:1,serverVersion:version}));
const action=msg.payload.controlAction;const result=action==='relay.update.activity'?{ok:true,busy:false,activeCount:0,pid:process.pid,entry,instanceId,version}:{ok:true};
ws.send(JSON.stringify({type:'relay.response',requestId:msg.requestId,ok:true,result}));
if(action==='relay.update.shutdown')setTimeout(()=>{for(const client of wss.clients)client.terminate();server.close(()=>process.exit(0));},50);
}));server.listen(port,'127.0.0.1');
`);
}
function fixtureSetup(root) {
  // Real dependency setup invokes CLI --help; it creates root/.logs before returning.
  // Verify these are already persistent links, then reproduce that write.
  for (const name of [".local", ".logs", ".tmp"]) assert.equal(fs.lstatSync(path.join(root, name)).isSymbolicLink(), true, `${name} must be linked before dependency setup`);
  fs.mkdirSync(path.join(root, ".logs"), { recursive: true }); fs.writeFileSync(path.join(root, ".logs", "setup-help.log"), "CLI --help setup fixture\n");
  fs.symlinkSync(path.join(projectRoot, "node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
}
function zipPackage(root, source, archive, unsafe = false) {
  const script = path.join(root, "zip-fixture.py");
  fs.writeFileSync(script, "import sys, os, zipfile\nwith zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED) as z:\n if len(sys.argv)>3: z.writestr('../escaped.txt', 'bad')\n else:\n  for base, dirs, files in os.walk(sys.argv[1]):\n   for name in files:\n    p=os.path.join(base,name); z.write(p, 'figma-relay/' + os.path.relpath(p,sys.argv[1]).replace(os.sep,'/'))\n");
  const result = spawnSync("python", [script, source, archive, ...(unsafe ? ["unsafe"] : [])], { encoding: "utf8", windowsHide: true }); assert.equal(result.status, 0, result.stderr);
}
async function setupUpdate(t, options = {}) {
  const root = temporary(t, false), source = path.join(root, "source"), installRoot = path.join(root, "fixed"), newer = path.join(root, "newer");
  fixturePackage(source, "1.0.0"); fixturePackage(newer, "1.1.0", options);
  await installRelease({ source, installRoot, setup: fixtureSetup });
  const port = await freePort(); const oldRuntime = await launchRuntime(installRoot, "1.0.0", port);
  t.after(async () => {
    const file = path.join(installRoot, "data", ".local", "runtime.json");
    if (fs.existsSync(file)) { const runtime = JSON.parse(fs.readFileSync(file)); await terminateStartedRuntime(installRoot, runtime); }
    removeTree(root, os.tmpdir());
  });
  await waitForHealth(installRoot, versionRoot(installRoot, "1.0.0"), "1.0.0", oldRuntime);
  const archive = path.join(installRoot, "data", "updates", "fixture.zip"); fs.mkdirSync(path.dirname(archive), { recursive: true }); zipPackage(root, newer, archive);
  const signed = sign(payload({ size: fs.statSync(archive).size, sha256: await hashFile(archive) }));
  const planPath = path.join(path.dirname(archive), "plan.json"), planId = crypto.randomUUID();
  writeJsonAtomic(planPath, { schemaVersion: 1, installRoot, planId, runtime: oldRuntime, envelope: signed, archivePath: archive });
  writeJsonAtomic(path.join(path.dirname(archive), "status.json"), { latest: payload(), bridge: { projectId: "keep", phase: "pending" } });
  return { root, source, installRoot, newer, archive, oldRuntime, planPath, planId };
}

test("signed release manifests reject tampering, untrusted keys, downgrade ordering and unsafe URLs", () => {
  const envelope = sign(payload()); assert.equal(parseSignedManifest(envelope, publicKey).version, "1.1.0");
  assert.throws(() => parseSignedManifest({ ...envelope, payload: Buffer.from(JSON.stringify(payload({ version: "9.0.0" }))).toString("base64") }, publicKey), /signature/);
  assert.throws(() => parseSignedManifest(sign(payload({ archiveUrl: "http://example.test/app.zip" })), publicKey), /HTTPS/);
  assert.throws(() => parseSignedManifest(sign(payload({ size: 1024 ** 3 })), publicKey), /payload/);
  const other = crypto.generateKeyPairSync("ed25519"); assert.throws(() => parseSignedManifest(envelope, other.publicKey.export({type:"spki",format:"pem"})), /signature/);
  assert.equal(compareVersions("1.0.10", "1.0.9"), 1); assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.11"), -1); assert.equal(compareVersions("1.0.0", "1.0.0-beta"), 1);
});
test("first installation keeps fixed paths, migrates only permitted settings and preserves existing data", async (t) => {
  const root = temporary(t), source = path.join(root, "source"), installed = path.join(root, "fixed"); fixturePackage(source, "1.0.0");
  fs.mkdirSync(path.join(source, ".local", "release-signing"), { recursive: true }); fs.writeFileSync(path.join(source, ".local", "dxx-config.json"), '{"key":"private"}'); fs.writeFileSync(path.join(source, ".local", "release-signing", "private.pem"), "must not migrate");
  const result = await installRelease({ source, installRoot: installed, setup: fixtureSetup });
  assert.deepEqual(result.migrated, ["dxx-config.json"]); assert.equal(fs.readFileSync(path.join(installed, "data", ".local", "dxx-config.json"), "utf8"), '{"key":"private"}');
  assert.equal(fs.existsSync(path.join(installed, "data", ".local", "release-signing")), false);
  assert.equal(fs.realpathSync(path.join(versionRoot(installed, "1.0.0"), ".local")), fs.realpathSync(path.join(installed, "data", ".local")));
  assert.equal(fs.readFileSync(path.join(installed, "plugin", "code.js"), "utf8"), "1.0.0");
  const cli = spawnSync(process.execPath, [path.join(installed, "dist", "cli.js"), "--help"], { encoding: "utf8", windowsHide: true }); assert.equal(cli.status, 0, cli.stderr); assert.ok(cli.stdout.includes(path.join(installed, "data")));
  fs.writeFileSync(path.join(installed, "data", ".local", "dxx-config.json"), "preserved");
  await installRelease({ source, installRoot: installed, setup: fixtureSetup }); assert.equal(fs.readFileSync(path.join(installed, "data", ".local", "dxx-config.json"), "utf8"), "preserved");
  const changed = { ...config, manifestUrl: "https://other.example.test/latest.json" }; writeJsonAtomic(path.join(source, "release-config.json"), changed);
  await assert.rejects(installRelease({ source, installRoot: installed, setup: fixtureSetup }), /different update source/);
});
test("update lock refuses a live owner and recovers an abandoned owner", (t) => {
  const root = temporary(t), file = path.join(root, "lock"); const release = acquireLock(file); assert.throws(() => acquireLock(file), /running/); release();
  fs.writeFileSync(file, JSON.stringify({ pid: 2147483647, identity: "dead" })); const recovered = acquireLock(file); recovered(); assert.equal(fs.existsSync(file), false);
});
test("stable CLI keeps serving the installed version while a live updater prepares dependencies", async (t) => {
  const root = temporary(t), source = path.join(root, "source"), installRoot = path.join(root, "fixed"); fixturePackage(source, "1.0.0");
  await installRelease({ source, installRoot, setup: fixtureSetup });
  const lock = path.join(installRoot, "data", "updates", "install.lock"); const release = acquireLock(lock);
  try {
    writeJsonAtomic(path.join(installRoot, "data", "updates", "journal.json"), { phase: "preparing" });
    const result = spawnSync(process.execPath, [path.join(installRoot, "dist", "cli.js"), "--help"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || result.stdout); assert.match(result.stdout, /fixture cli/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(installRoot, "data", "updates", "journal.json"))).phase, "preparing");
  } finally { release(); }
});
test("safe archive extraction rejects zip traversal before installed paths change", { skip: process.platform !== "win32" }, async (t) => {
  const root = temporary(t), archive = path.join(root, "bad.zip"); zipPackage(root, root, archive, true);
  await assert.rejects(extractArchive(archive, path.join(root, "unpacked")), /extraction/); assert.equal(fs.existsSync(path.join(root, "escaped.txt")), false);
});
test("signed update switches fixed plugin and real authenticated Relay while preserving user data", { skip: process.platform !== "win32", timeout: 45000 }, async (t) => {
  const fixture = await setupUpdate(t), { installRoot } = fixture;
  fs.appendFileSync(path.join(fixture.newer, "scripts", "installed_launcher.mjs"), "\n// New signed updater fixture\n");
  // Re-sign after changing the new updater so the test proves the fixed updater upgrades too.
  zipPackage(fixture.root, fixture.newer, fixture.archive);
  const newPlan = JSON.parse(fs.readFileSync(fixture.planPath)); newPlan.envelope = sign(payload({ size: fs.statSync(fixture.archive).size, sha256: await hashFile(fixture.archive) })); writeJsonAtomic(fixture.planPath, newPlan);
  fs.writeFileSync(path.join(installRoot, "data", ".local", "dxx-config.json"), "keep");
  const result = await applyUpdate(fixture.planPath, { setup: fixtureSetup }); assert.equal(result.version, "1.1.0");
  assert.match(fs.readFileSync(path.join(installRoot, "updater", "installed_launcher.mjs"), "utf8"), /New signed updater fixture/);
  assert.equal(readInstall(installRoot).currentVersion, "1.1.0"); assert.equal(readInstall(installRoot).previousVersion, "1.0.0");
  assert.equal(fs.readFileSync(path.join(installRoot, "plugin", "code.js"), "utf8"), "1.1.0"); assert.equal(fs.readFileSync(path.join(installRoot, "data", ".local", "dxx-config.json"), "utf8"), "keep");
  const runtime = JSON.parse(fs.readFileSync(path.join(installRoot, "data", ".local", "runtime.json")));
  const activity = await relayControl(installRoot, versionRoot(installRoot, "1.1.0"), "1.1.0", runtime, "relay.update.activity"); assert.equal(activity.pid, runtime.pid);
  const state = JSON.parse(fs.readFileSync(path.join(installRoot, "data", "updates", "status.json"))); assert.equal(state.phase, "restart-required"); assert.equal(state.bridge.projectId, "keep"); assert.equal(state.latest.version, "1.1.0");
});
test("bad archive hash cannot stop the old Relay or change fixed plugin files", { skip: process.platform !== "win32", timeout: 20000 }, async (t) => {
  const fixture = await setupUpdate(t); fs.appendFileSync(fixture.archive, "tampered");
  await assert.rejects(applyUpdate(fixture.planPath, { setup: fixtureSetup }), /integrity/);
  assert.equal(readInstall(fixture.installRoot).currentVersion, "1.0.0");
  const activity = await relayControl(fixture.installRoot, versionRoot(fixture.installRoot, "1.0.0"), "1.0.0", fixture.oldRuntime, "relay.update.activity"); assert.equal(activity.pid, fixture.oldRuntime.pid);
});
test("failed new Relay startup restores old plugin, record and authenticated runtime", { skip: process.platform !== "win32", timeout: 45000 }, async (t) => {
  const fixture = await setupUpdate(t, { broken: true });
  await assert.rejects(applyUpdate(fixture.planPath, { setup: fixtureSetup, healthTimeoutMs: 1500 }), /health check/);
  const failureState = JSON.parse(fs.readFileSync(path.join(fixture.installRoot, "data", "updates", "status.json")));
  assert.equal(readInstall(fixture.installRoot).currentVersion, "1.0.0", JSON.stringify(failureState)); assert.equal(fs.readFileSync(path.join(fixture.installRoot, "plugin", "code.js"), "utf8"), "1.0.0");
  const state = JSON.parse(fs.readFileSync(path.join(fixture.installRoot, "data", "updates", "status.json"))); assert.equal(state.phase, "rolled-back"); assert.equal(fs.existsSync(path.join(fixture.installRoot, "data", "updates", "journal.json")), false);
});
test("dependency failure clears only the owned inactive version and the same release can be retried", { skip: process.platform !== "win32", timeout: 30000 }, async (t) => {
  const fixture = await setupUpdate(t);
  await assert.rejects(applyUpdate(fixture.planPath, { setup: async () => { throw new Error("fixture dependency unavailable"); } }), /dependency unavailable/);
  assert.equal(fs.existsSync(versionRoot(fixture.installRoot, "1.1.0")), false);
  const activity = await relayControl(fixture.installRoot, versionRoot(fixture.installRoot, "1.0.0"), "1.0.0", fixture.oldRuntime, "relay.update.activity"); assert.equal(activity.pid, fixture.oldRuntime.pid);
  const result = await applyUpdate(fixture.planPath, { setup: fixtureSetup }); assert.equal(result.version, "1.1.0");
});
test("recovery removes an interrupted preparing version without restarting or stopping the active old Relay", { skip: process.platform !== "win32", timeout: 20000 }, async (t) => {
  const fixture = await setupUpdate(t), { installRoot, planId } = fixture;
  fs.mkdirSync(versionRoot(installRoot, "1.1.0"), { recursive: true }); fs.writeFileSync(path.join(versionRoot(installRoot, "1.1.0"), "partial.txt"), "partial setup");
  const stagedPlugin = path.join(installRoot, `.plugin-${planId}`); fs.mkdirSync(stagedPlugin); fs.writeFileSync(path.join(stagedPlugin, "partial.txt"), "partial plugin");
  writeJsonAtomic(path.join(installRoot, "data", "updates", "journal.json"), { schemaVersion: 1, planId, phase: "preparing", oldRecord: readInstall(installRoot), oldRuntime: fixture.oldRuntime, targetVersion: "1.1.0", ownedVersion: true,
    pluginBackup: path.join(installRoot, `.plugin-backup-${planId}`), stagedPlugin, updaterBackup: path.join(installRoot, `.updater-backup-${planId}`), stagedUpdater: path.join(installRoot, `.updater-${planId}`), oldStopped: false });
  const result = await recoverUpdate(installRoot); assert.equal(result.rolledBack, true); assert.equal(fs.existsSync(versionRoot(installRoot, "1.1.0")), false); assert.equal(fs.existsSync(stagedPlugin), false);
  const activity = await relayControl(installRoot, versionRoot(installRoot, "1.0.0"), "1.0.0", fixture.oldRuntime, "relay.update.activity"); assert.equal(activity.pid, fixture.oldRuntime.pid);
});
test("a live but unresponsive new child is terminated by owned handle before rollback", { skip: process.platform !== "win32", timeout: 30000 }, async (t) => {
  const fixture = await setupUpdate(t, { hang: true });
  await assert.rejects(applyUpdate(fixture.planPath, { setup: fixtureSetup, healthTimeoutMs: 1000 }), /health check/);
  const state = JSON.parse(fs.readFileSync(path.join(fixture.installRoot, "data", "updates", "status.json"))); assert.equal(state.phase, "rolled-back", JSON.stringify(state)); assert.equal(readInstall(fixture.installRoot).currentVersion, "1.0.0");
});
test("independent bootstrap repairs the updater-directory rename gap and starts the restored Relay", { skip: process.platform !== "win32", timeout: 30000 }, async (t) => {
  const fixture = await setupUpdate(t), { installRoot, planId, oldRuntime } = fixture;
  const oldRecord = readInstall(installRoot);
  await stopOwnedRuntime(installRoot, "1.0.0", oldRuntime, planId);
  const pluginBackup = path.join(installRoot, `.plugin-backup-${planId}`), updaterBackup = path.join(installRoot, `.updater-backup-${planId}`);
  fs.renameSync(path.join(installRoot, "plugin"), pluginBackup);
  fs.mkdirSync(path.join(installRoot, "plugin")); fs.writeFileSync(path.join(installRoot, "plugin", "code.js"), "partially switched");
  writeJsonAtomic(path.join(installRoot, "data", "updates", "journal.json"), { schemaVersion: 1, planId, phase: "stopped", oldRecord, oldRuntime, oldStopped: true, targetVersion: "1.1.0", ownedVersion: true,
    pluginBackup, updaterBackup, stagedPlugin: path.join(installRoot, `.plugin-${planId}`), stagedUpdater: path.join(installRoot, `.updater-${planId}`) });
  fs.renameSync(path.join(installRoot, "updater"), updaterBackup);
  const result = spawnSync(process.execPath, [path.join(installRoot, "bootstrap.mjs"), "repair", "--install-root", installRoot, "--port", String(oldRuntime.port)], { encoding: "utf8", windowsHide: true, timeout: 25000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(installRoot, "updater", "installed_launcher.mjs")), true);
  assert.equal(fs.readFileSync(path.join(installRoot, "plugin", "code.js"), "utf8"), "1.0.0");
  const runtime = JSON.parse(fs.readFileSync(path.join(installRoot, "data", ".local", "runtime.json")));
  const activity = await relayControl(installRoot, versionRoot(installRoot, "1.0.0"), "1.0.0", runtime, "relay.update.activity"); assert.equal(activity.pid, runtime.pid);
  assert.equal(fs.existsSync(path.join(installRoot, "data", "updates", "journal.json")), false);
});
test("committed-journal repair starts an exited runtime and finishes the durable success status", { skip: process.platform !== "win32", timeout: 30000 }, async (t) => {
  const fixture = await setupUpdate(t), { installRoot, planId, oldRuntime } = fixture;
  await stopOwnedRuntime(installRoot, "1.0.0", oldRuntime, planId);
  writeJsonAtomic(path.join(installRoot, "data", "updates", "journal.json"), { schemaVersion: 1, planId, phase: "committed", oldRecord: readInstall(installRoot), oldRuntime, newRuntime: oldRuntime, oldStopped: true, targetVersion: "1.0.0",
    pluginBackup: path.join(installRoot, `.plugin-backup-${planId}`), updaterBackup: path.join(installRoot, `.updater-backup-${planId}`) });
  writeJsonAtomic(path.join(installRoot, "data", "updates", "status.json"), { phase: "installing", latest: { version: "1.0.0" }, bridge: { projectId: "keep", phase: "pending" } });
  const result = spawnSync(process.execPath, [path.join(installRoot, "bootstrap.mjs"), "repair", "--install-root", installRoot, "--port", String(oldRuntime.port)], { encoding: "utf8", windowsHide: true, timeout: 25000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const runtime = JSON.parse(fs.readFileSync(path.join(installRoot, "data", ".local", "runtime.json")));
  const activity = await relayControl(installRoot, versionRoot(installRoot, "1.0.0"), "1.0.0", runtime, "relay.update.activity"); assert.equal(activity.pid, runtime.pid);
  const state = JSON.parse(fs.readFileSync(path.join(installRoot, "data", "updates", "status.json"))); assert.equal(state.phase, "restart-required"); assert.equal(state.bridge.projectId, "keep");
  assert.equal(fs.existsSync(path.join(installRoot, "data", "updates", "journal.json")), false);
});
test("bounded downloads reject oversize responses and insecure non-loopback URLs", async (t) => {
  const root = temporary(t); const server = http.createServer((req, res) => { res.writeHead(200, {"Content-Length":"100"}); res.end("x".repeat(100)); }); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const target = path.join(root, "archive.zip"), url = `http://127.0.0.1:${server.address().port}/app.zip`;
  await assert.rejects(downloadFile(url, target, { allowLoopbackHttp: true, maxBytes: 10 }), /exceeds/); assert.equal(fs.existsSync(target), false);
  await assert.rejects(downloadFile("http://example.test/archive.zip", target, { allowLoopbackHttp: true }), /HTTPS/);
  await downloadFile(url, target, { allowLoopbackHttp: true, maxBytes: 100, expectedBytes: 100 }); assert.equal(fs.statSync(target).size, 100);
});
