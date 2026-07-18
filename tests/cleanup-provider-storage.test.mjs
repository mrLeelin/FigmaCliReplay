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
  assert.match(ui, /aiRunnerSelect\.value = runnerIdForCleanupProvider\(cleanupProviderSelect\.value\)/);
  assert.match(ui, /syncAiRunnerToCleanupProvider\(\)/);
});

test("provider discovery retries after the Relay WebSocket reconnects", () => {
  const onOpenStart = ui.indexOf("relaySocket.onopen = function");
  const onOpenEnd = ui.indexOf("relaySocket.onmessage = function", onOpenStart);
  assert.ok(onOpenStart >= 0 && onOpenEnd > onOpenStart);
  assert.match(ui.slice(onOpenStart, onOpenEnd), /refreshCleanupProviders\(\)/);
});

test("overlapping provider syncs serialize and apply the latest selection once", async () => {
  const calls = [];
  const resolvers = [];
  const context = {
    aiProviderSyncing: false,
    aiProviderSyncPromise: null,
    aiProviderSyncTargetRunner: "",
    aiRunnerSelect: { value: "" },
    cleanupProviderSelect: { value: "codex" },
    cleanupProviderStatusEl: { textContent: "" },
    refreshAiPromptControls() {},
    renderCleanupProviderStatus() {},
    runnerIdForCleanupProvider(providerId) {
      return providerId === "claude-code" ? "claude" : "codex";
    },
    selectAiRunner() {
      calls.push(context.aiRunnerSelect.value);
      return new Promise((resolve) => resolvers.push(resolve));
    },
  };
  vm.createContext(context);
  vm.runInContext(
    `${extractNamedFunction(ui, "syncAiRunnerToCleanupProvider")}; this.syncProvider = syncAiRunnerToCleanupProvider;`,
    context,
  );

  const first = context.syncProvider();
  const duplicate = context.syncProvider();
  context.cleanupProviderSelect.value = "claude-code";
  const latest = context.syncProvider();

  assert.deepEqual(calls, ["codex"], "duplicate triggers must share the active config request");
  resolvers.shift()(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["codex", "claude"], "only the latest changed selection should run next");

  resolvers.shift()(true);
  assert.equal(await first, true);
  assert.equal(await duplicate, true);
  assert.equal(await latest, true);
  assert.deepEqual(calls, ["codex", "claude"]);
  assert.equal(context.aiProviderSyncing, false);
});
