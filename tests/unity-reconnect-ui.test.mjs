import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const html = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");
function source(name) {
  const match = html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n    \\}`));
  assert.ok(match, name);
  return match[0];
}
function node() {
  const classes = new Set();
  return { textContent: "", title: "", className: "", disabled: false, value: "", innerHTML: "",
    classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); }, contains(name) { return classes.has(name); } },
    setAttribute(name, value) { this[name] = value; } };
}
function harness(send = async () => ({ ok: true })) {
  const project = { id: "last-project", name: "Saved Unity", path: "E:/Saved/Unity" };
  const context = vm.createContext({
    selectedUnityProject: project, unityProjects: [project], relaySocketRegistered: true, relayConnected: true,
    unityConnected: false, unityConnectionState: "restoring", unityConnectionAttempt: 0,
    unityProjectRefreshSequence: 0, unityAutoConnectPending: true, unityAutoReconnectEnabled: true,
    unityBridgeVersionMismatch: null, unityGatewayProjectPath: "", pluginReleaseVersion: "0.1.48",
    settingsTabBtn: node(), unityBadge: node(), unityProjectStatus: node(), unityUrlInput: node(),
    captureRelayRequestContext: () => ({ generation: 1 }), relayRequestIsCurrent: value => value.generation === 1,
    sendRelaySocketRequest: send, setBridgeVersionBadge() {}, refreshUnityControls() {}, appendLog() {},
    setSelectedFolder() {}, setSelectedImageTargetInfo() {}, setSelectedTextTarget() {}, setUnityPrefabPath() {},
    startSelectedFolderRefresh() {}, stopSelectedFolderRefresh() {},
    setUnityStatus(value) { context.status = value; },
    normalizeBaseUrl: value => String(value || "").replace(/\/+$/, ""),
    normalizeUnityProjectPath: value => String(value || "").replace(/\\/g, "/").toLowerCase(),
    evaluateBridgeVersion: (expected, actual) => ({ matches: expected === actual }),
    waitForUnityConnectionRetry: async () => {},
    createBridgeVersionMismatchError: () => Object.assign(new Error("version mismatch"), { bridgeVersionMismatch: true }),
    renderUnityProjects(data) { context.selectedUnityProject = data.projects.find(item => item.id === data.lastSelectedProjectId) || null; },
  });
  for (const name of ["unityConnectionIsPending", "unityConnectionRequestIsCurrent", "refreshSettingsConnectionAlert", "setUnityBadge",
    "resetUnityForRelayDisconnect", "readSelectedUnityGatewayConfig", "probeUnityUrl", "connectUnity", "disconnectUnity", "refreshUnityProjects"]) {
    vm.runInContext(source(name), context);
  }
  return context;
}

test("startup restores the saved project before connecting and keeps pending state until health completes", async () => {
  let finish;
  const c = harness(async action => {
    assert.equal(action, "unity.projects.list");
    return { ok: true, lastSelectedProjectId: "last-project", projects: [c.selectedUnityProject] };
  });
  c.readSelectedUnityGatewayConfig = async () => "relay-session://inbound";
  c.requestUnityCommand = async () => new Promise(resolve => { finish = resolve; });
  const pending = c.refreshUnityProjects();
  await new Promise(setImmediate);
  assert.equal(c.unityConnectionState, "connecting");
  assert.equal(c.unityConnected, false);
  assert.equal(c.unityBadge.textContent, "连接中");
  assert.equal(c.settingsTabBtn.classList.contains("connection-error"), false);
  finish({ projectPath: "E:/Saved/Unity", version: "0.1.48" });
  await pending;
  assert.equal(c.unityConnectionState, "connected");
  assert.equal(c.unityBadge.textContent, "已连接");
});

test("failed automatic connection is shown offline only after the actual attempt fails", async () => {
  let fail;
  let calls = 0;
  const c = harness();
  c.readSelectedUnityGatewayConfig = () => ++calls === 1 ? new Promise((_, reject) => { fail = reject; }) : Promise.reject(new Error("offline"));
  const pending = c.connectUnity();
  assert.equal(c.unityBadge.textContent, "连接中");
  assert.equal(c.settingsTabBtn.classList.contains("connection-error"), false);
  fail(new Error("offline")); await pending;
  assert.equal(calls, 3);
  assert.equal(c.unityBadge.textContent, "未连接");
  assert.equal(c.settingsTabBtn.classList.contains("connection-error"), true);
});

test("a transient Bridge disconnect retries only connection reads and then restores the saved project", async () => {
  let lookups = 0;
  let healthChecks = 0;
  const c = harness();
  c.readSelectedUnityGatewayConfig = async () => ++lookups === 1 ? "" : "relay-session://inbound";
  c.requestUnityCommand = async action => {
    assert.equal(action, "unity.health");
    healthChecks++;
    return { projectPath: "E:/Saved/Unity", version: "0.1.48" };
  };
  await c.connectUnity();
  assert.equal(lookups, 2);
  assert.equal(healthChecks, 1);
  assert.equal(c.unityConnected, true);
});

test("startup waits for Relay registration and does not invent a different project", async () => {
  let calls = 0;
  const c = harness(async () => { calls++; return { ok: true, projects: [], lastSelectedProjectId: "gone" }; });
  c.relaySocketRegistered = false;
  await c.refreshUnityProjects();
  assert.equal(calls, 0);
  assert.equal(c.unityConnectionState, "restoring");
  c.relaySocketRegistered = true;
  await c.refreshUnityProjects();
  assert.equal(calls, 1);
  assert.equal(c.unityConnected, false);
  assert.equal(c.unityConnectionState, "disconnected");
  assert.match(c.status, /没有可恢复/);
});

test("manual disconnect invalidates an in-flight health reply and suppresses automatic reconnect", async () => {
  let finish;
  const c = harness();
  c.readSelectedUnityGatewayConfig = async () => "relay-session://inbound";
  c.probeUnityUrl = async () => new Promise(resolve => { finish = resolve; });
  const pending = c.connectUnity(); await new Promise(setImmediate);
  c.disconnectUnity();
  finish({ url: "relay-session://inbound", data: { projectPath: "E:/Saved/Unity", version: "0.1.48" } });
  await pending;
  assert.equal(c.unityConnected, false);
  assert.equal(c.unityAutoReconnectEnabled, false);
  c.resetUnityForRelayDisconnect(true);
  assert.equal(c.unityAutoConnectPending, false);
});

test("a changed Relay or project cannot be marked connected by a stale result", async () => {
  for (const change of [c => { c.selectedUnityProject = { id: "other-project" }; }, c => { c.relayRequestIsCurrent = () => false; }]) {
    let finish;
    const c = harness();
    c.readSelectedUnityGatewayConfig = () => new Promise(resolve => { finish = resolve; });
    const pending = c.connectUnity(); change(c); finish("relay-session://inbound"); await pending;
    assert.equal(c.unityConnected, false);
  }
});

test("wrong project identity and Bridge version remain failures", async () => {
  for (const response of [{ projectPath: "E:/Other/Unity", version: "0.1.48" }, { projectPath: "E:/Saved/Unity", version: "old" }]) {
    const c = harness();
    c.readSelectedUnityGatewayConfig = async () => "relay-session://inbound";
    c.requestUnityCommand = async () => response;
    await c.connectUnity();
    assert.equal(c.unityConnected, false);
    assert.equal(c.unityConnectionState, "disconnected");
  }
});

test("Relay reconnection restarts restoration while duplicate connect clicks send only one lookup", async () => {
  let finish;
  let calls = 0;
  const c = harness();
  c.readSelectedUnityGatewayConfig = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const pending = c.connectUnity(); await c.connectUnity();
  assert.equal(calls, 1);
  c.resetUnityForRelayDisconnect(true);
  assert.equal(c.unityConnectionState, "restoring");
  assert.equal(c.unityAutoConnectPending, true);
  finish(""); await pending;
  assert.equal(c.unityConnectionState, "restoring");
});

test("header pending state never includes the offline label", () => {
  const match = html.match(/function syncChip\([^]*?\n      \}/);
  assert.ok(match);
  const c = vm.createContext({});
  vm.runInContext(match[0], c);
  const chip = node(); const badge = node(); badge.className = "badge pending"; badge.textContent = "连接中";
  c.syncChip(chip, badge, "Unity 已连接", "Unity 未连接", "Unity 连接中");
  assert.match(chip.innerHTML, /Unity 连接中/);
  assert.doesNotMatch(chip.innerHTML, /未连接/);
  assert.equal(chip.classList.contains("offline"), false);
});
