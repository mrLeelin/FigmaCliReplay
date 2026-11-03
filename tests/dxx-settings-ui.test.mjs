import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const html = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");
const block = html.split("// DXX_SETTINGS_BEGIN")[1].split("// DXX_SETTINGS_END")[0];

function harness(responder = async (action) => ({ ok: true, config: { apiBase: "https://canvas.dxx.cn", hasKey: true, keySource: "project", ...(action === "dxx.config.read" ? { apiKey: "test-key" } : {}) } })) {
  const nodes = Object.fromEntries(["dxxApiBaseInput", "dxxApiKeyInput", "dxxSaveConfigBtn", "dxxTestConnectionBtn", "dxxConfigStatus"].map(id => [id, {
    value: id === "dxxApiBaseInput" ? "https://canvas.dxx.cn" : "", textContent: "", disabled: false, placeholder: "", listeners: {},
    addEventListener(name, callback) { this.listeners[name] = callback; },
  }]));
  const calls = [];
  let generation = 0;
  const context = vm.createContext({
    document: { getElementById: id => nodes[id] }, relayConnected: true,
    captureRelayRequestContext: () => ({ generation }),
    relayRequestIsCurrent: value => value.generation === generation,
    waitForRelaySocketRegistration: async () => true,
    sendRelaySocketRequest: async (...args) => { calls.push(args); return responder(...args); },
    fetch() { throw new Error("DXX settings must use the authenticated Relay socket"); },
  });
  vm.runInContext(block, context);
  return { nodes, calls, context, changeRelay() { generation += 1; context.resetDxxConfigForRelay(); } };
}

test("DXX credentials live in settings with a plaintext field and save/test actions", () => {
  const start = html.indexOf('class="tab-page" id="settings-tab"');
  const end = html.indexOf("<!-- SETTINGS_TAB_END -->", start);
  const section = html.slice(start, end);
  assert.match(section, /id="dxx-settings-section"/);
  assert.match(section, /id="dxxApiKeyInput" type="text"/);
  assert.match(section, /id="dxxSaveConfigBtn"/);
  assert.match(section, /id="dxxTestConnectionBtn"/);
});

test("the settings-specific read restores the actual key in the plaintext field", async () => {
  const h = harness(async () => ({ ok: true, config: { hasKey: true, keySource: "environment", apiBase: "https://canvas.dxx.cn", apiKey: "saved-key" } }));
  await h.context.refreshDxxConfig();
  assert.equal(h.calls[0][0], "dxx.config.read");
  assert.equal(h.nodes.dxxApiKeyInput.value, "saved-key");
  assert.match(h.nodes.dxxConfigStatus.textContent, /环境变量/);
  assert.equal(h.nodes.dxxConfigStatus.textContent.includes("saved-key"), false);
  assert.equal(h.nodes.dxxTestConnectionBtn.disabled, false);
});

test("save writes the key once then restores the persisted plaintext value", async () => {
  const h = harness();
  h.nodes.dxxApiKeyInput.value = "test-key";
  h.nodes.dxxApiKeyInput.listeners.input();
  await h.context.submitDxxConfig(false);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0][0], "dxx.config.set");
  assert.equal(h.calls[0][1].apiKey, "test-key");
  assert.equal(h.calls[1][0], "dxx.config.read");
  assert.equal(h.nodes.dxxApiKeyInput.value, "test-key");
  assert.match(h.nodes.dxxConfigStatus.textContent, /已保存/);
});

test("closing and reopening the UI restores the saved key without re-entry", async () => {
  const stored = { apiBase: "https://canvas.dxx.cn", apiKey: "" };
  const backend = async (action, payload) => {
    if (action === "dxx.config.set") {
      Object.assign(stored, payload);
      return { ok: true, config: { apiBase: stored.apiBase, hasKey: true, keySource: "project" } };
    }
    return { ok: true, config: { ...stored, hasKey: true, keySource: "project" } };
  };
  const first = harness(backend);
  first.nodes.dxxApiKeyInput.value = "persist-across-plugin-instances";
  await first.context.submitDxxConfig(false);
  const reopened = harness(backend);
  await reopened.context.refreshDxxConfig();
  assert.equal(reopened.nodes.dxxApiKeyInput.value, "persist-across-plugin-instances");
  assert.equal(reopened.nodes.dxxApiBaseInput.value, stored.apiBase);
});

test("a failed read after save does not report lost data or clear the input", async () => {
  const h = harness(async (action) => {
    if (action === "dxx.config.read") throw new Error("connection interrupted");
    return { ok: true, config: { hasKey: true, keySource: "project" } };
  });
  h.nodes.dxxApiKeyInput.value = "saved-before-read-failed";
  await h.context.submitDxxConfig(false);
  assert.equal(h.nodes.dxxApiKeyInput.value, "saved-before-read-failed");
  assert.match(h.nodes.dxxConfigStatus.textContent, /配置已保存/);
  assert.doesNotMatch(h.nodes.dxxConfigStatus.textContent, /保存失败/);
});

test("test uses draft key without saving, uploading, or clearing the draft", async () => {
  const h = harness(async () => ({ ok: true, enabled: true }));
  h.nodes.dxxApiKeyInput.value = "unsaved-key";
  h.nodes.dxxApiKeyInput.listeners.input();
  await h.context.submitDxxConfig(true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], "dxx.config.test");
  assert.equal(h.calls[0][1].apiKey, "unsaved-key");
  assert.equal(h.nodes.dxxApiKeyInput.value, "unsaved-key");
  assert.match(h.nodes.dxxConfigStatus.textContent, /尚未保存/);
});

test("blank key preserves the saved key and rejected saves retain editable input", async () => {
  const h = harness(async () => { throw new Error("保存失败"); });
  await h.context.submitDxxConfig(false);
  assert.equal(Object.hasOwn(h.calls[0][1], "apiKey"), false);
  h.nodes.dxxApiKeyInput.value = "keep-for-correction";
  await h.context.submitDxxConfig(false);
  assert.equal(h.nodes.dxxApiKeyInput.value, "keep-for-correction");
  assert.equal(h.nodes.dxxApiKeyInput.disabled, false);
  assert.match(h.nodes.dxxConfigStatus.textContent, /保存失败/);
});

test("a busy test ignores a second click and disabled capability is not reported as success", async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  h.nodes.dxxApiKeyInput.value = "draft";
  const pending = h.context.submitDxxConfig(true);
  await Promise.resolve();
  await h.context.submitDxxConfig(true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.nodes.dxxSaveConfigBtn.disabled, true);
  resolve({ ok: true, enabled: false });
  await pending;
  assert.match(h.nodes.dxxConfigStatus.textContent, /未启用/);
});

test("switching Relay clears draft credentials and ignores the old response", async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  const pending = h.context.refreshDxxConfig();
  h.nodes.dxxApiKeyInput.value = "old-relay-draft";
  h.changeRelay();
  resolve({ ok: true, config: { hasKey: true, apiBase: "https://previous.example" } });
  await pending;
  assert.equal(h.nodes.dxxApiKeyInput.value, "");
  assert.equal(h.nodes.dxxApiBaseInput.value, "https://canvas.dxx.cn");
  assert.match(h.nodes.dxxConfigStatus.textContent, /地址已切换/);
});

test("late configuration reads preserve current user edits", async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  const pending = h.context.refreshDxxConfig();
  h.nodes.dxxApiBaseInput.value = "https://draft.example";
  h.nodes.dxxApiBaseInput.listeners.input();
  resolve({ ok: true, config: { hasKey: true, apiBase: "https://saved.example" } });
  await pending;
  assert.equal(h.nodes.dxxApiBaseInput.value, "https://draft.example");
});
