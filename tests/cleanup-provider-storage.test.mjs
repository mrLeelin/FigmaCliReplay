import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const handlers = fs.readFileSync(new URL("../code/01_handlers.js", import.meta.url), "utf8");
const ui = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");

function extractNamedFunction(source, name) {
  const functionStart = source.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `${name} should exist`);
  const start = source.slice(Math.max(0, functionStart - 6), functionStart) === "async " ? functionStart - 6 : functionStart;
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`${name} should have a complete body`);
}

test("provider preference uses Figma clientStorage and an allowlist", () => {
  assert.match(handlers, /figma\.clientStorage\.getAsync\("cleanup\.preferredPlanningProvider"\)/);
  assert.match(handlers, /figma\.clientStorage\.setAsync\("cleanup\.preferredPlanningProvider"/);
  assert.match(handlers, /providerId === "codex" \|\| providerId === "claude-code"/);
  assert.match(handlers, /GET_CLEANUP_PROVIDER_PREFERENCE_RESULT/);
  assert.match(handlers, /SET_CLEANUP_PROVIDER_PREFERENCE_RESULT/);
});

test("cleanup provider selector shows availability and never silently falls back", () => {
  assert.match(ui, /id="cleanupProviderSelect"/);
  assert.match(ui, /\/ai-runner\/providers/);
  assert.match(ui, /GET_CLEANUP_PROVIDER_PREFERENCE/);
  assert.match(ui, /SET_CLEANUP_PROVIDER_PREFERENCE/);
  assert.match(ui, /provider\.available/);
  assert.match(ui, /provider\.reason/);
  assert.doesNotMatch(ui, /selectedProvider[\s\S]{0,160}(fallback|find\([^\n]+available)/i);
});

test("one AI selector keeps the generic runner compatible behind the scenes", () => {
  assert.match(ui, /function runnerIdForCleanupProvider\(providerId\)/);
  assert.match(ui, /providerId === "claude-code" \? "claude" : "codex"/);
  assert.match(ui, /function syncAiRunnerToCleanupProvider\(\)/);
  assert.match(ui, /targetRunner = runnerIdForCleanupProvider\(providerId\)/);
  assert.match(ui, /aiRunnerSelect\.value = targetRunner/);
  assert.match(ui, /syncAiRunnerToCleanupProvider\(\)/);
});

test("provider discovery retries after the Relay WebSocket reconnects", () => {
  const onOpenStart = ui.indexOf("socket.onopen = function");
  const onOpenEnd = ui.indexOf("socket.onmessage = function", onOpenStart);
  assert.ok(onOpenStart >= 0 && onOpenEnd > onOpenStart);
  assert.match(ui.slice(onOpenStart, onOpenEnd), /refreshCleanupProviders\(\)/);
});

test("cleanup provider sync pins the per-request runner without a global config write", async () => {
  const calls = [];
  const context = {
    aiProviderSyncing: false,
    aiProviderSyncPromise: null,
    aiProviderSyncTargetRunner: "",
    relaySessionId: "test-session",
    aiRunnerSelect: { value: "" },
    aiRunnerStatusEl: { textContent: "" },
    cleanupProviderSelect: { value: "codex" },
    cleanupProviderStatusEl: { textContent: "" },
    uiLogger: { startOperation() { return { succeed(message, data) { calls.push({ message, data }); } }; } },
    refreshAiPromptControls() {},
    renderCleanupProviderStatus() {},
    runnerIdForCleanupProvider(providerId) {
      return providerId === "claude-code" ? "claude" : "codex";
    },
    selectAiRunner() { throw new Error("global AI config must not be written during provider selection"); },
  };
  vm.createContext(context);
  vm.runInContext(
    `${extractNamedFunction(ui, "syncAiRunnerToCleanupProvider")}; this.syncProvider = syncAiRunnerToCleanupProvider;`,
    context,
  );

  assert.equal(await context.syncProvider(), true);
  assert.equal(context.aiRunnerSelect.value, "codex");
  context.cleanupProviderSelect.value = "claude-code";
  assert.equal(await context.syncProvider(), true);
  assert.equal(context.aiRunnerSelect.value, "claude");
  assert.equal(calls.length, 2);
  assert.equal(context.aiProviderSyncing, false);
});
