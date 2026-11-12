import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const html = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");
const block = html.split("// AI_SKILL_SETTINGS_BEGIN")[1].split("// AI_SKILL_SETTINGS_END")[0];
const ids = ["aiSkillCheckBtn", "aiSkillStatus", ...["Codex", "Claude"].flatMap(agent => [
  `aiSkill${agent}Badge`, `aiSkill${agent}Path`, `aiSkill${agent}Message`, `aiSkill${agent}InstallBtn`,
])];

function record(agent, status = "missing", extra = {}) {
  return {
    agent, directory: `C:/Users/Recipient/.${agent === "codex" ? "agents" : "claude"}/skills/figma-relay`,
    status, installed: ["installed", "outdated", "modified"].includes(status), current: status === "installed",
    canInstall: status !== "modified" && status !== "error", message: `${agent} ${status}`, ...extra,
  };
}

function status(codex = "missing", claude = "missing", extra = {}) {
  return { ok: true, sourceAvailable: true, installations: [record("codex", codex), record("claude", claude)], ...extra };
}

function harness(responder = async () => status()) {
  const nodes = Object.fromEntries(ids.map(id => [id, {
    textContent: id.endsWith("Badge") ? "未检查" : "", disabled: true, className: "badge pending", listeners: {},
    addEventListener(name, listener) { this.listeners[name] = listener; },
  }]));
  const calls = [];
  let generation = 0;
  const context = vm.createContext({
    document: { getElementById: id => nodes[id] }, relayConnected: true,
    captureRelayRequestContext: () => ({ generation }),
    relayRequestIsCurrent: value => value.generation === generation,
    sendRelaySocketRequest: async (...args) => { calls.push(args); return responder(...args); },
    fetch() { throw new Error("Skill management must use the authenticated Relay WebSocket"); },
  });
  vm.runInContext(block, context);
  return {
    nodes, calls, context,
    disconnect() { context.relayConnected = false; context.resetAiSkillSettingsForRelay("本地 Relay 未连接，连接后重新检查 Skill。"); },
    reconnect() { context.relayConnected = true; context.refreshAiSkillControls(); },
    changeRelay() { generation += 1; context.resetAiSkillSettingsForRelay("Relay 地址已切换，连接后重新检查 Skill。"); },
  };
}

test("AI Skill controls are in settings before DXX with explicit per-agent actions", () => {
  const settings = html.indexOf('class="tab-page" id="settings-tab"');
  const section = html.indexOf('id="ai-skill-settings-section"');
  const dxx = html.indexOf('id="dxx-settings-section"');
  assert.ok(settings < section && section < dxx);
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html.slice(section, dxx), /本机当前用户/);
  assert.match(html.slice(section, dxx), /重新打开 AI 会话/);
});

test("status checks are read-only and show each agent's actual file status and location", async () => {
  const h = harness(async () => status("installed", "missing"));
  await h.context.refreshAiSkillStatus();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], "ai.skill.status");
  assert.equal(JSON.stringify(h.calls[0][1]), "{}");
  assert.equal(h.nodes.aiSkillCodexBadge.textContent, "已写入");
  assert.match(h.nodes.aiSkillCodexBadge.className, /online/);
  assert.equal(h.nodes.aiSkillCodexInstallBtn.textContent, "更新 Skill");
  assert.equal(h.nodes.aiSkillClaudeBadge.textContent, "未写入");
  assert.equal(h.nodes.aiSkillClaudeInstallBtn.textContent, "写入 Skill");
  assert.match(h.nodes.aiSkillClaudePath.textContent, /Recipient/);
  assert.equal(h.nodes.aiSkillClaudeInstallBtn.disabled, false);
});

test("offline and unverified initial state disable writes and do not issue requests", async () => {
  const h = harness();
  h.context.refreshAiSkillControls();
  assert.equal(h.nodes.aiSkillCodexInstallBtn.disabled, true);
  await h.context.installAiSkillFromSettings("codex");
  assert.equal(h.calls.length, 0);
  h.disconnect();
  await h.context.refreshAiSkillStatus();
  assert.equal(h.calls.length, 0);
  assert.equal(h.nodes.aiSkillCheckBtn.disabled, true);
});

test("install writes only the chosen agent and verifies files with a fresh status request", async () => {
  let written = false;
  const h = harness(async action => {
    if (action === "ai.skill.install") { written = true; return { ok: true }; }
    return status(written ? "installed" : "missing", "missing");
  });
  await h.context.refreshAiSkillStatus();
  await h.context.installAiSkillFromSettings("codex");
  assert.deepEqual(h.calls.map(call => call[0]), ["ai.skill.status", "ai.skill.install", "ai.skill.status"]);
  assert.equal(h.calls[1][1].target, "codex");
  assert.equal(h.nodes.aiSkillCodexBadge.textContent, "已写入");
  assert.match(h.nodes.aiSkillStatus.textContent, /已写入并检查通过/);
  assert.equal(h.nodes.aiSkillClaudeBadge.textContent, "未写入");
});

test("successful install response cannot claim success when readback files remain missing", async () => {
  const h = harness(async action => action === "ai.skill.install" ? { ok: true } : status());
  await h.context.refreshAiSkillStatus();
  await h.context.installAiSkillFromSettings("claude");
  assert.equal(h.nodes.aiSkillClaudeBadge.textContent, "未写入");
  assert.match(h.nodes.aiSkillStatus.textContent, /写入后检查尚未通过/);
  assert.doesNotMatch(h.nodes.aiSkillStatus.textContent, /已写入并检查通过/);
});

test("readback failure is reported separately from the completed write and allows checking again", async () => {
  let wrote = false;
  const h = harness(async action => {
    if (action === "ai.skill.install") { wrote = true; return { ok: true }; }
    if (wrote) throw new Error("read interrupted");
    return status();
  });
  await h.context.refreshAiSkillStatus();
  await h.context.installAiSkillFromSettings("codex");
  assert.match(h.nodes.aiSkillStatus.textContent, /写入请求已完成，但状态检查失败/);
  assert.equal(h.nodes.aiSkillCodexBadge.textContent, "未检查");
  assert.equal(h.nodes.aiSkillCheckBtn.disabled, false);
  assert.equal(h.nodes.aiSkillCodexInstallBtn.disabled, true);
});

test("local edits block writes while outdated managed copies offer an update", async () => {
  const h = harness(async () => status("modified", "outdated", {
    installations: [record("codex", "modified", { canInstall: true }), record("claude", "outdated")],
  }));
  await h.context.refreshAiSkillStatus();
  assert.equal(h.nodes.aiSkillCodexBadge.textContent, "本地已修改");
  assert.equal(h.nodes.aiSkillCodexInstallBtn.disabled, true);
  assert.equal(h.nodes.aiSkillClaudeBadge.textContent, "需要更新");
  assert.equal(h.nodes.aiSkillClaudeInstallBtn.textContent, "更新 Skill");
  assert.equal(h.nodes.aiSkillClaudeInstallBtn.disabled, false);
  await h.context.installAiSkillFromSettings("codex");
  assert.equal(h.calls.length, 1);
});

test("write conflicts and transport failures preserve uncertainty without automatic retries", async () => {
  const h = harness(async action => {
    if (action === "ai.skill.install") throw new Error("Preserving locally edited skill");
    return status();
  });
  await h.context.refreshAiSkillStatus();
  await h.context.installAiSkillFromSettings("codex");
  assert.equal(h.calls.length, 2);
  assert.match(h.nodes.aiSkillStatus.textContent, /写入结果未确认/);
  assert.match(h.nodes.aiSkillStatus.textContent, /locally edited/);
  assert.equal(h.nodes.aiSkillCodexBadge.textContent, "未检查");
  assert.equal(h.nodes.aiSkillCheckBtn.disabled, false);
});

test("missing source files and older Relay versions cannot appear installed", async () => {
  const h = harness(async () => status("missing", "missing", { sourceAvailable: false }));
  await h.context.refreshAiSkillStatus();
  assert.equal(h.nodes.aiSkillCodexInstallBtn.disabled, true);
  assert.match(h.nodes.aiSkillStatus.textContent, /缺少 Skill 源文件/);
  const old = harness(async () => { throw new Error("Unsupported Relay control action: ai.skill.status"); });
  await old.context.refreshAiSkillStatus();
  assert.match(old.nodes.aiSkillStatus.textContent, /当前 Relay 不支持 AI Skill 管理/);
  assert.equal(old.nodes.aiSkillCodexBadge.textContent, "未检查");
  assert.equal(old.nodes.aiSkillCheckBtn.disabled, false);
});

test("status loading and install/readback disable duplicate actions", async () => {
  let resolve;
  let pendingMode = true;
  const h = harness(async action => {
    if (pendingMode) return new Promise(done => { resolve = done; });
    return action === "ai.skill.install" ? { ok: true } : status();
  });
  const checking = h.context.refreshAiSkillStatus();
  assert.equal(h.nodes.aiSkillCheckBtn.disabled, true);
  await h.context.refreshAiSkillStatus();
  assert.equal(h.calls.length, 1);
  resolve(status());
  await checking;
  pendingMode = true;
  const installing = h.context.installAiSkillFromSettings("codex");
  assert.equal(h.nodes.aiSkillCodexInstallBtn.disabled, true);
  assert.equal(h.nodes.aiSkillClaudeInstallBtn.disabled, true);
  assert.equal(h.nodes.aiSkillCheckBtn.disabled, true);
  await h.context.installAiSkillFromSettings("codex");
  await h.context.refreshAiSkillStatus();
  assert.equal(h.calls.length, 2);
  pendingMode = false;
  resolve({ ok: true });
  await installing;
  assert.equal(h.calls.length, 3);
  assert.equal(h.nodes.aiSkillCheckBtn.disabled, false);
});

test("Relay changes discard old responses without releasing a newer request's busy state", async () => {
  const resolvers = [];
  const h = harness(() => new Promise(resolve => resolvers.push(resolve)));
  const old = h.context.refreshAiSkillStatus();
  h.changeRelay();
  const current = h.context.refreshAiSkillStatus();
  resolvers[0](status("installed", "installed"));
  await old;
  assert.equal(h.nodes.aiSkillCodexBadge.textContent, "未检查");
  assert.equal(h.nodes.aiSkillCheckBtn.disabled, true);
  resolvers[1](status("missing", "outdated"));
  await current;
  assert.equal(h.nodes.aiSkillCodexBadge.textContent, "未写入");
  assert.equal(h.nodes.aiSkillClaudeBadge.textContent, "需要更新");
  assert.equal(h.nodes.aiSkillCheckBtn.disabled, false);
});

test("disconnect/reconnect invalidates an in-flight write even at the same Relay URL", async () => {
  let resolveWrite;
  let checks = 0;
  const h = harness(async action => {
    if (action === "ai.skill.install") return new Promise(resolve => { resolveWrite = resolve; });
    checks += 1;
    return status(checks > 1 ? "installed" : "missing", "missing");
  });
  await h.context.refreshAiSkillStatus();
  const writing = h.context.installAiSkillFromSettings("codex");
  h.disconnect();
  assert.equal(h.nodes.aiSkillCodexBadge.textContent, "未检查");
  h.reconnect();
  await h.context.refreshAiSkillStatus();
  const refreshed = h.nodes.aiSkillStatus.textContent;
  resolveWrite({ ok: true });
  await writing;
  assert.equal(h.calls.filter(call => call[0] === "ai.skill.install").length, 1);
  assert.equal(checks, 2, "stale write completion must not trigger another status read");
  assert.equal(h.nodes.aiSkillStatus.textContent, refreshed);
  assert.doesNotMatch(refreshed, /已写入并检查通过/);
});

test("malformed status clears verified badges and paths/errors are rendered as text", async () => {
  let malformed = false;
  const h = harness(async () => malformed ? { ok: true, installations: [] } : status("installed", "missing", {
    installations: [record("codex", "installed", { directory: "<img src=x onerror=alert(1)>" }), record("claude")],
  }));
  await h.context.refreshAiSkillStatus();
  assert.equal(h.nodes.aiSkillCodexPath.textContent, "<img src=x onerror=alert(1)>");
  malformed = true;
  await h.context.refreshAiSkillStatus();
  assert.equal(h.nodes.aiSkillCodexBadge.textContent, "未检查");
  assert.match(h.nodes.aiSkillStatus.textContent, /状态返回不完整/);
});

test("settings entry, registration, disconnect and URL switching invoke the status lifecycle", () => {
  const switchTab = html.slice(html.indexOf("function switchTab(tabId)"), html.indexOf("function switchSyncTab"));
  assert.match(switchTab, /tabId === "settings-tab"\) refreshAiSkillStatus\(\)/);
  const registered = html.slice(html.indexOf('message.type === "plugin.registered"'), html.indexOf('message.type === "command.cancel"'));
  assert.match(registered, /refreshAiSkillStatus\(\)/);
  const badge = html.slice(html.indexOf("function setAiBadge"), html.indexOf("function setUnityBadge"));
  assert.match(badge, /!online\) resetAiSkillSettingsForRelay/);
  const urlSwitch = html.slice(html.indexOf("function syncRelayUrlInput"), html.indexOf("function renderUnityProjects"));
  assert.match(urlSwitch, /resetAiSkillSettingsForRelay/);
});
