import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const html = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");
const block = html.split("// RELAY_UPDATE_SETTINGS_BEGIN")[1].split("// RELAY_UPDATE_SETTINGS_END")[0];
const ids = ["relayUpdateNoticeBtn", "relayUpdateCheckBtn", "relayUpdateInstallBtn", "relayUpdateAutoCheck",
  "relayUpdateBridgeCheck", "relayUpdateBridgeLabel", "relayUpdateBadge", "relayUpdateCurrentVersion",
  "relayUpdateRelayVersion", "relayUpdateLatestVersion", "relayUpdateNotes", "relayUpdateProgress", "relayUpdateStatus"];
const status = (extra = {}) => ({
  ok: true, currentVersion: "0.1.49", installed: true, configured: true, autoCheck: true,
  phase: "idle", message: "等待检查。", canInstall: false, ...extra,
});
const available = (extra = {}) => status({ phase: "available", canInstall: true,
  latest: { version: "0.1.50", publishedAt: "2026-11-12T00:00:00Z", notes: ["修复导入", "改善连接"] }, ...extra });

function harness(responder = async () => status()) {
  const nodes = Object.fromEntries(ids.map(id => [id, {
    textContent: "", disabled: true, checked: id === "relayUpdateAutoCheck", hidden: true, listeners: {}, attributes: {},
    addEventListener(event, listener) { this.listeners[event] = listener; },
    setAttribute(key, value) { this.attributes[key] = String(value); },
    removeAttribute(key) { delete this.attributes[key]; delete this[key]; },
  }]));
  const calls = [];
  const timers = new Map();
  let timerId = 0;
  let generation = 0;
  const context = vm.createContext({
    document: { getElementById: id => nodes[id] }, pluginReleaseVersion: "0.1.49", relayConnected: true,
    selectedUnityProject: null, unityProjectSelect: { value: "" },
    captureRelayRequestContext: () => ({ generation }),
    relayRequestIsCurrent: c => c.generation === generation,
    sendRelaySocketRequest: async (...args) => { calls.push(args); return responder(...args); },
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
    fetch() { throw new Error("Updates must use authenticated Relay WebSocket controls"); },
  });
  vm.runInContext(block, context);
  return {
    nodes, calls, timers, context,
    async tick() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      timer.callback();
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    },
    disconnect() { context.relayConnected = false; context.resetRelayUpdateSettings("本地 Relay 未连接。"); },
    reconnect() { context.relayConnected = true; },
    changeRelay() { generation += 1; context.resetRelayUpdateSettings("Relay 地址已切换。"); },
    selectProject(project, explicit = true) {
      context.selectedUnityProject = project;
      context.unityProjectSelect.value = project?.id || "";
      context.explicitId = explicit ? project?.id || "" : "";
      vm.runInContext("relayUpdateExplicitProjectId = explicitId; refreshRelayUpdateControls();", context);
    },
  };
}

test("version card, automatic-check default and header shortcut are wired into existing connection lifecycle", () => {
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /id="relayUpdateAutoCheck" type="checkbox" checked disabled/);
  assert.doesNotMatch(html, /id="relayUpdateBridgeCheck"[^>]* checked/);
  assert.ok(html.indexOf('id="relay-update-settings-section"') < html.indexOf('id="ai-skill-settings-section"'));
  const registered = html.slice(html.indexOf('message.type === "plugin.registered"'), html.indexOf('message.type === "command.cancel"'));
  assert.match(registered, /startRelayUpdateConnection\(\)/);
  assert.match(html.slice(html.indexOf("function setAiBadge"), html.indexOf("function setUnityBadge")), /resetRelayUpdateSettings/);
  assert.match(html.slice(html.indexOf("function syncRelayUrlInput"), html.indexOf("function renderUnityProjects")), /resetRelayUpdateSettings/);
  assert.match(html.slice(html.indexOf("function switchTab(tabId)"), html.indexOf("function switchSyncTab")), /refreshRelayUpdateStatus/);
  assert.match(block, /更新修复\.bat/);
});

test("initial unverified and disconnected states never enable install or make network requests", async () => {
  const h = harness();
  assert.equal(h.nodes.relayUpdateCurrentVersion.textContent, "v0.1.49");
  assert.equal(h.nodes.relayUpdateInstallBtn.disabled, true);
  await h.context.installRelayUpdate();
  assert.equal(h.calls.length, 0);
  h.disconnect();
  await h.context.checkRelayUpdate();
  await h.context.startRelayUpdateConnection();
  assert.equal(h.calls.length, 0);
  assert.equal(h.nodes.relayUpdateCheckBtn.disabled, true);
  assert.equal(h.nodes.relayUpdateAutoCheck.disabled, true);
});

test("connected status shows real latest version and release notes as text", async () => {
  const h = harness(async () => available({ latest: { version: "0.1.50", notes: ["<img onerror=alert(1)>"] } }));
  await h.context.refreshRelayUpdateStatus();
  assert.equal(h.calls[0][0], "relay.update.status");
  assert.equal(JSON.stringify(h.calls[0][1]), "{}");
  assert.equal(h.nodes.relayUpdateLatestVersion.textContent, "v0.1.50");
  assert.equal(h.nodes.relayUpdateNoticeBtn.hidden, false);
  assert.equal(h.nodes.relayUpdateBadge.textContent, "有更新");
  assert.equal(h.nodes.relayUpdateNotes.textContent, "· <img onerror=alert(1)>");
  assert.equal(h.nodes.relayUpdateInstallBtn.disabled, false);
});

test("missing publisher feed is explicit and never appears current", async () => {
  const h = harness(async () => status({ configured: false, phase: "up-to-date", message: "" }));
  await h.context.startRelayUpdateConnection();
  assert.deepEqual(h.calls.map(c => c[0]), ["relay.update.status"]);
  assert.equal(h.nodes.relayUpdateBadge.textContent, "未配置更新源");
  assert.equal(h.nodes.relayUpdateLatestVersion.textContent, "未配置");
  assert.match(h.nodes.relayUpdateStatus.textContent, /发布者尚未配置更新源/);
  assert.equal(h.nodes.relayUpdateInstallBtn.disabled, true);
});

test("automatic checks occur once per registration and respect persisted preference", async () => {
  const h = harness(async action => action === "relay.update.check" ? available() : status());
  await h.context.startRelayUpdateConnection();
  await h.context.startRelayUpdateConnection();
  assert.deepEqual(h.calls.map(c => c[0]), ["relay.update.status", "relay.update.check"]);
  const off = harness(async () => status({ autoCheck: false }));
  await off.context.startRelayUpdateConnection();
  assert.deepEqual(off.calls.map(c => c[0]), ["relay.update.status"]);
  assert.equal(off.nodes.relayUpdateAutoCheck.checked, false);
  off.disconnect();
  off.reconnect();
  await off.context.startRelayUpdateConnection();
  assert.equal(off.calls.length, 2);
});

test("automatic-check preference is explicitly persisted without installing", async () => {
  const h = harness(async (action, payload) => status({ autoCheck: action === "relay.update.settings" ? payload.autoCheck : true }));
  await h.context.refreshRelayUpdateStatus();
  h.nodes.relayUpdateAutoCheck.checked = false;
  await h.context.saveRelayUpdateSettings();
  assert.deepEqual(h.calls.map(c => c[0]), ["relay.update.status", "relay.update.settings"]);
  assert.equal(JSON.stringify(h.calls[1][1]), '{"autoCheck":false}');
  assert.equal(h.nodes.relayUpdateAutoCheck.checked, false);
});

test("Bridge update is opt-in and bound to explicit current valid project", async () => {
  const h = harness(async action => action === "relay.update.install" ? status({ phase: "preparing" }) : available());
  await h.context.refreshRelayUpdateStatus();
  h.selectProject({ id: "project-a", name: "示例工程", valid: true }, false);
  assert.equal(h.nodes.relayUpdateBridgeCheck.disabled, true, "first-list fallback is not an explicit target");
  h.selectProject({ id: "project-a", name: "示例工程", valid: true });
  assert.equal(h.nodes.relayUpdateBridgeCheck.disabled, false);
  assert.equal(h.nodes.relayUpdateBridgeCheck.checked, false);
  h.nodes.relayUpdateBridgeCheck.checked = true;
  await h.context.installRelayUpdate();
  assert.equal(JSON.stringify(h.calls[1][1]), '{"updateBridge":true,"projectId":"project-a"}');
  assert.equal(h.nodes.relayUpdateBridgeCheck.disabled, true);
  const plain = harness(async () => available());
  await plain.context.refreshRelayUpdateStatus();
  await plain.context.installRelayUpdate();
  assert.equal(JSON.stringify(plain.calls[1][1]), '{"updateBridge":false}');
});

test("changing selected project invalidates Bridge checkbox before update submission", async () => {
  const h = harness(async () => available());
  await h.context.refreshRelayUpdateStatus();
  h.selectProject({ id: "project-a", name: "A", valid: true });
  h.nodes.relayUpdateBridgeCheck.checked = true;
  h.context.unityProjectSelect.value = "project-b";
  await h.context.installRelayUpdate();
  assert.equal(JSON.stringify(h.calls[1][1]), '{"updateBridge":false}');
  assert.equal(h.nodes.relayUpdateBridgeCheck.checked, false);
});

test("only one poll timer runs while active and progress is clamped", async () => {
  let reads = 0;
  const h = harness(async () => ++reads < 3 ? status({ phase: "downloading", progress: 120 }) : status({ phase: "restart-required", currentVersion: "0.1.50" }));
  await h.context.refreshRelayUpdateStatus();
  assert.equal(h.nodes.relayUpdateProgress.hidden, false);
  assert.equal(h.nodes.relayUpdateProgress.value, 100);
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].delay, 1000);
  assert.equal(h.nodes.relayUpdateInstallBtn.disabled, true);
  await h.context.checkRelayUpdate();
  assert.equal(h.timers.size, 1);
  assert.equal(h.calls[1][0], "relay.update.status", "active check only reads progress");
  await h.tick();
  assert.equal(h.timers.size, 0);
  assert.equal(h.nodes.relayUpdateProgress.hidden, true);
  assert.match(h.nodes.relayUpdateStatus.textContent, /关闭并重新打开/);
});

test("unknown progress remains indeterminate and rollback has explicit result", async () => {
  const h = harness(async () => status({ phase: "preparing" }));
  await h.context.refreshRelayUpdateStatus();
  assert.equal(h.nodes.relayUpdateProgress.hidden, false);
  assert.equal(Object.hasOwn(h.nodes.relayUpdateProgress, "value"), false);
  h.context.renderRelayUpdateStatus(status({ phase: "rolled-back", error: "新版本启动失败", message: "旧版本继续可用。" }));
  assert.equal(h.nodes.relayUpdateBadge.textContent, "已恢复原版本");
  assert.match(h.nodes.relayUpdateStatus.textContent, /旧版本继续可用/);
  assert.match(h.nodes.relayUpdateStatus.textContent, /新版本启动失败/);
});

test("install request is single-shot; timeout requires status reconciliation before retry", async () => {
  let reads = 0;
  const h = harness(async action => {
    if (action === "relay.update.install") throw new Error("timeout");
    return ++reads === 1 ? available() : status({ phase: "downloading", progress: 42 });
  });
  await h.context.refreshRelayUpdateStatus();
  await h.context.installRelayUpdate();
  assert.match(h.nodes.relayUpdateStatus.textContent, /结果未确认/);
  assert.equal(h.nodes.relayUpdateCheckBtn.textContent, "核对更新状态");
  assert.equal(h.nodes.relayUpdateInstallBtn.disabled, true);
  await h.context.installRelayUpdate();
  assert.equal(h.calls.filter(c => c[0] === "relay.update.install").length, 1);
  await h.context.checkRelayUpdate();
  assert.equal(h.calls.at(-1)[0], "relay.update.status");
  assert.equal(h.nodes.relayUpdateBadge.textContent, "下载中");
});

test("duplicate check and installation clicks do not submit concurrent operations", async () => {
  let resolve;
  const h = harness(async action => action === "relay.update.install" ? new Promise(done => { resolve = done; }) : available());
  await h.context.refreshRelayUpdateStatus();
  const pending = h.context.installRelayUpdate();
  assert.equal(h.nodes.relayUpdateCheckBtn.disabled, true);
  assert.equal(h.nodes.relayUpdateInstallBtn.disabled, true);
  await h.context.installRelayUpdate();
  await h.context.refreshRelayUpdateStatus();
  assert.equal(h.calls.length, 2);
  resolve(status({ phase: "waiting", message: "正在等待当前导入完成。" }));
  await pending;
  assert.equal(h.nodes.relayUpdateBadge.textContent, "等待任务结束");
  assert.equal(h.nodes.relayUpdateCheckBtn.disabled, false);
});

test("Relay URL switch discards old responses without clearing a newer request's busy state", async () => {
  const resolvers = [];
  const h = harness(() => new Promise(resolve => resolvers.push(resolve)));
  const previous = h.context.refreshRelayUpdateStatus();
  h.changeRelay();
  const current = h.context.refreshRelayUpdateStatus();
  resolvers[0](available());
  await previous;
  assert.equal(h.nodes.relayUpdateLatestVersion.textContent, "未检查");
  assert.equal(h.nodes.relayUpdateCheckBtn.disabled, true);
  resolvers[1](status({ configured: false }));
  await current;
  assert.equal(h.nodes.relayUpdateLatestVersion.textContent, "未配置");
  assert.equal(h.nodes.relayUpdateCheckBtn.disabled, false);
});

test("disconnect during install stops polling and stale write completion cannot overwrite reconnect status", async () => {
  let resolve;
  let reads = 0;
  const h = harness(async action => action === "relay.update.install" ? new Promise(done => { resolve = done; })
    : ++reads === 1 ? available() : status({ currentVersion: "0.1.50", phase: "up-to-date", message: "新版本已启动。" }));
  await h.context.refreshRelayUpdateStatus();
  const installing = h.context.installRelayUpdate();
  h.disconnect();
  assert.equal(h.timers.size, 0);
  assert.match(h.nodes.relayUpdateStatus.textContent, /独立更新器继续执行/);
  h.reconnect();
  await h.context.refreshRelayUpdateStatus();
  const message = h.nodes.relayUpdateStatus.textContent;
  resolve(status({ phase: "preparing" }));
  await installing;
  assert.equal(h.nodes.relayUpdateStatus.textContent, message);
  assert.equal(h.nodes.relayUpdateBadge.textContent, "请重新打开插件");
  assert.equal(h.nodes.relayUpdateNoticeBtn.hidden, false);
  assert.equal(h.calls.filter(c => c[0] === "relay.update.install").length, 1);
});

test("unsupported and malformed backends clear verification and offer standalone recovery", async () => {
  const old = harness(async () => { throw new Error("Unsupported Relay control action: relay.update.status"); });
  await old.context.refreshRelayUpdateStatus();
  assert.match(old.nodes.relayUpdateStatus.textContent, /当前 Relay 不支持在线更新/);
  assert.match(old.nodes.relayUpdateStatus.textContent, /更新修复\.bat/);
  const malformed = harness(async () => available({ autoCheck: undefined }));
  await malformed.context.refreshRelayUpdateStatus();
  assert.match(malformed.nodes.relayUpdateStatus.textContent, /状态返回不完整/);
  assert.equal(malformed.nodes.relayUpdateInstallBtn.disabled, true);
  assert.equal(malformed.nodes.relayUpdateLatestVersion.textContent, "未检查");
});

test("reopening the matching plugin clears the reopen prompt even while durable update record remains", async () => {
  const h = harness(async action => action === "relay.update.check" ? status({ phase: "up-to-date", message: "已是最新版本。" })
    : status({ phase: "restart-required", message: "已更新。" }));
  await h.context.refreshRelayUpdateStatus();
  assert.equal(h.nodes.relayUpdateBadge.textContent, "已更新");
  assert.equal(h.nodes.relayUpdateNoticeBtn.hidden, true);
  assert.doesNotMatch(h.nodes.relayUpdateStatus.textContent, /请关闭并重新打开/);
  await h.context.startRelayUpdateConnection();
  assert.deepEqual(h.calls.map(c => c[0]), ["relay.update.status", "relay.update.status", "relay.update.check"]);
  assert.equal(h.nodes.relayUpdateBadge.textContent, "已是最新");
});

test("Bridge compilation after Relay update keeps a status poll until the new Bridge is verified", async () => {
  let reads = 0;
  const h = harness(async () => status({ phase: "restart-required", message: "已更新。",
    bridge: ++reads < 3 ? { projectId: "project-a", phase: "waiting-for-unity", message: "等待 Unity 编译。" }
      : { projectId: "project-a", phase: "succeeded", message: "新 Bridge 已重连。" } }));
  await h.context.refreshRelayUpdateStatus();
  assert.equal(h.nodes.relayUpdateBadge.textContent, "已更新");
  assert.equal(h.nodes.relayUpdateCheckBtn.textContent, "刷新进度");
  assert.match(h.nodes.relayUpdateStatus.textContent, /等待 Unity 编译/);
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].delay, 1000);
  await h.context.checkRelayUpdate();
  assert.equal(h.calls.at(-1)[0], "relay.update.status");
  await h.tick();
  assert.equal(h.timers.size, 0);
  assert.match(h.nodes.relayUpdateStatus.textContent, /新 Bridge 已重连/);
});

test("Bridge pending reconnect uses a slower single poll and stops on disconnect", async () => {
  const h = harness(async () => status({ phase: "restart-required", message: "已更新。",
    bridge: { projectId: "project-a", phase: "pending-reconnect", message: "工程尚未打开，可稍后打开 Unity。" } }));
  await h.context.refreshRelayUpdateStatus();
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].delay, 5000);
  await h.tick();
  assert.equal(h.timers.size, 1);
  h.disconnect();
  assert.equal(h.timers.size, 0);
});

test("Bridge queued and installing phases keep polling after the application switch", async () => {
  for (const phase of ["pending", "installing"]) {
    const h = harness(async () => status({ phase: "restart-required", message: "已更新。",
      bridge: { projectId: "project-a", phase, message: "Bridge 更新处理中。" } }));
    await h.context.refreshRelayUpdateStatus();
    assert.equal(h.timers.size, 1);
    assert.equal([...h.timers.values()][0].delay, 1000);
  }
});
