import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const handlers = fs.readFileSync(new URL("../code/01_handlers.js", import.meta.url), "utf8");
const ui = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");

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
