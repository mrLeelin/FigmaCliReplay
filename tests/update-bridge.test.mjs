import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import { resumeRequestedBridgeUpdate } from "../dist/updateBridge.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bridge-update-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "Unity 工程");
  const source = path.join(root, "release");
  const data = path.join(root, "data");
  const updates = path.join(data, "updates");
  const bridge = path.join(project, "Assets", "Editor", "FigmaBridge");
  const settings = path.join(project, "ProjectSettings", "FigmaBridgeImportSettings.json");
  fs.mkdirSync(bridge, { recursive: true });
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.mkdirSync(path.join(source, "unity", "Assets", "Editor", "FigmaBridge"), { recursive: true });
  fs.mkdirSync(updates, { recursive: true });
  const oldMeta = "fileFormatVersion: 2\nguid: 012345678901234567890123456789ab\n";
  fs.writeFileSync(bridge + ".meta", oldMeta);
  fs.writeFileSync(path.join(bridge, "Bridge.cs"), "old bridge");
  fs.writeFileSync(settings, JSON.stringify({ commonFontAsset: "Assets/KeepFont.asset", relayToken: "old-token" }));
  const template = path.join(source, "unity", "Assets", "Editor", "FigmaBridge");
  fs.writeFileSync(path.join(template, "Bridge.cs"), "new bridge");
  fs.writeFileSync(template + ".meta", "fileFormatVersion: 2\nguid: 11111111111111111111111111111111\n");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, version: "1.2.3", publishedAt: new Date().toISOString(), notes: ["Bridge fixture"], archiveUrl: "https://updates.example.com/relay.zip", sha256: "a".repeat(64), size: 123 }));
  const envelope = { schemaVersion: 1, payload: payload.toString("base64"), signature: crypto.sign(null, payload, privateKey).toString("base64") };
  const plan = { schemaVersion: 1, installRoot: root, planId: "bridge-plan-1", envelope, updateBridgeProjectId: "current-project", updateBridgeProjectPath: project };
  fs.writeFileSync(path.join(root, "install.json"), JSON.stringify({ schemaVersion: 1, currentVersion: "1.2.3", manifestUrl: "https://updates.example.com/latest.json", publicKey: publicKey.export({ type: "spki", format: "pem" }) }));
  fs.writeFileSync(path.join(updates, "plan.json"), JSON.stringify(plan));
  const statusFile = path.join(updates, "status.json");
  const initial = { schemaVersion: 1, planId: plan.planId, phase: "restart-required", message: "Reopen plugin", latest: { version: "1.2.3", notes: ["keep release notes"] }, bridge: { projectId: "current-project", phase: "pending", message: "waiting" } };
  fs.writeFileSync(statusFile, JSON.stringify(initial));
  const options = { installRoot: root, dataRoot: data, projectRoot: source, currentVersion: "1.2.3", bridgeToken: "new-token", timeoutMs: 0, pollMs: 1, registry: { list: () => ({ lastSelectedProjectId: "current-project", projects: [{ id: "current-project", path: project, valid: true }] }) } };
  return { root, project, source, data, updates, bridge, settings, plan, envelope, initial, options, oldMeta, statusFile, status: () => JSON.parse(fs.readFileSync(statusFile, "utf8")) };
}

test("requested Bridge update preserves GUID/settings and requires an actual successful health probe", async (t) => {
  const f = fixture(t);
  let probes = 0;
  await resumeRequestedBridgeUpdate({ ...f.options, probe: async (project, version) => { probes++; assert.equal(project, fs.realpathSync(f.project)); assert.equal(version, "1.2.3"); return true; } });
  assert.equal(fs.readFileSync(path.join(f.bridge, "Bridge.cs"), "utf8"), "new bridge");
  assert.equal(fs.readFileSync(f.bridge + ".meta", "utf8"), f.oldMeta);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.settings, "utf8")), { commonFontAsset: "Assets/KeepFont.asset", relayToken: "new-token" });
  assert.equal(f.status().phase, "restart-required");
  assert.equal(f.status().bridge.phase, "completed");
  assert.equal(probes, 1);
  assert.deepEqual(f.status().latest, f.initial.latest);
  const backup = path.join(f.updates, "bridge-backups", f.plan.planId);
  assert.equal(fs.readFileSync(path.join(backup, "Assets/Editor/FigmaBridge/Bridge.cs"), "utf8"), "old bridge");
});

test("changing the selected Unity project refuses writes to the previously requested project", async (t) => {
  const f = fixture(t);
  let calls = 0;
  await resumeRequestedBridgeUpdate({ ...f.options, registry: { list: () => ({ lastSelectedProjectId: "other-project", projects: [{ id: "current-project", path: f.project, valid: true }] }) }, install: () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal(f.status().bridge.phase, "rejected");
  assert.equal(fs.readFileSync(path.join(f.bridge, "Bridge.cs"), "utf8"), "old bridge");
  assert.equal(fs.existsSync(path.join(f.updates, "bridge-backups")), false);
});

test("a partially failed Bridge installation restores files, GUID and exact project settings", async (t) => {
  const f = fixture(t);
  const originalSettings = fs.readFileSync(f.settings, "utf8");
  await resumeRequestedBridgeUpdate({ ...f.options, install: () => {
    fs.writeFileSync(path.join(f.bridge, "Bridge.cs"), "partial");
    fs.writeFileSync(path.join(f.bridge, "New.cs"), "new file");
    fs.writeFileSync(f.bridge + ".meta", "invalid guid");
    fs.writeFileSync(f.settings, "broken settings");
    throw new Error("fixture install failure");
  } });
  assert.equal(f.status().bridge.phase, "rolled-back", f.status().bridge.message);
  assert.equal(f.status().phase, "restart-required");
  assert.equal(fs.readFileSync(path.join(f.bridge, "Bridge.cs"), "utf8"), "old bridge");
  assert.equal(fs.readFileSync(f.bridge + ".meta", "utf8"), f.oldMeta);
  assert.equal(fs.readFileSync(f.settings, "utf8"), originalSettings);
  assert.equal(fs.existsSync(path.join(f.bridge, "New.cs")), false);
});

test("offline Unity remains pending; resuming checks health without reinstalling Bridge files", async (t) => {
  const f = fixture(t);
  let installs = 0;
  const install = () => { installs++; };
  await resumeRequestedBridgeUpdate({ ...f.options, install, probe: async () => false });
  assert.equal(installs, 1);
  assert.equal(f.status().bridge.phase, "pending-reconnect");
  assert.match(f.status().bridge.message, /尚未验证/);
  await resumeRequestedBridgeUpdate({ ...f.options, install, probe: async () => true });
  assert.equal(installs, 1);
  assert.equal(f.status().bridge.phase, "completed");
});

test("tampering with the signed plan cannot write to a Unity project", async (t) => {
  const f = fixture(t);
  f.plan.envelope = { ...f.envelope, payload: Buffer.from(JSON.stringify({ version: "1.2.3" })).toString("base64") };
  fs.writeFileSync(path.join(f.updates, "plan.json"), JSON.stringify(f.plan));
  let installs = 0;
  await resumeRequestedBridgeUpdate({ ...f.options, install: () => { installs++; } });
  assert.equal(installs, 0);
  assert.equal(f.status().bridge.phase, "failed");
  assert.equal(fs.readFileSync(path.join(f.bridge, "Bridge.cs"), "utf8"), "old bridge");
});

test("an interrupted Bridge transaction restores its durable backup without replaying installation", async (t) => {
  const f = fixture(t);
  // Complete one offline installation to produce the same backup/journal a real transaction uses.
  await resumeRequestedBridgeUpdate({ ...f.options, probe: async () => false });
  const status = f.status();
  status.bridge.phase = "installing";
  fs.writeFileSync(f.statusFile, JSON.stringify(status));
  fs.writeFileSync(path.join(f.bridge, "Interrupted.cs"), "partial new file");
  let installs = 0;
  await resumeRequestedBridgeUpdate({ ...f.options, install: () => { installs++; } });
  assert.equal(installs, 0);
  assert.equal(f.status().bridge.phase, "rolled-back", f.status().bridge.message);
  assert.equal(fs.readFileSync(path.join(f.bridge, "Bridge.cs"), "utf8"), "old bridge");
  assert.equal(fs.existsSync(path.join(f.bridge, "Interrupted.cs")), false);
});

test("plans without the optional current-project request do not install any Bridge", async (t) => {
  const f = fixture(t);
  delete f.plan.updateBridgeProjectId;
  delete f.plan.updateBridgeProjectPath;
  fs.writeFileSync(path.join(f.updates, "plan.json"), JSON.stringify(f.plan));
  let installs = 0;
  await resumeRequestedBridgeUpdate({ ...f.options, install: () => { installs++; } });
  assert.equal(installs, 0);
  assert.deepEqual(f.status(), f.initial);
});

test("Bridge backup refuses a junction that could escape the selected Unity project", async (t) => {
  const f = fixture(t);
  const external = path.join(f.root, "External");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "Keep.cs"), "keep external");
  fs.symlinkSync(external, path.join(f.bridge, "External"), process.platform === "win32" ? "junction" : "dir");
  let installs = 0;
  await resumeRequestedBridgeUpdate({ ...f.options, install: () => { installs++; } });
  assert.equal(installs, 0);
  assert.equal(f.status().bridge.phase, "failed");
  assert.equal(fs.readFileSync(path.join(external, "Keep.cs"), "utf8"), "keep external");
});
