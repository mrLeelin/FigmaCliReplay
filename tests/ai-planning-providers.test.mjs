import assert from "node:assert/strict";
import test from "node:test";

import { claudeCodeCliProvider } from "../dist/ai/claudeCodeCliProvider.js";
import { codexCliProvider } from "../dist/ai/codexCliProvider.js";
import { createPlanningProviderRegistry } from "../dist/ai/providerRegistry.js";

test("registry exposes Codex and Claude Code without silently falling back", async () => {
  const registry = createPlanningProviderRegistry({
    commandAvailable: (command) => command === "codex",
    commandVersion: (command) => command === "codex" ? "codex 1.2.3" : undefined,
  });
  assert.deepEqual((await registry.list()).map((item) => [item.id, item.available, item.version]), [
    ["codex", true, "codex 1.2.3"],
    ["claude-code", false, undefined],
  ]);
  assert.equal((await registry.resolve("codex")).id, "codex");
  await assert.rejects(registry.resolve("missing"), /unknown planning provider/i);
  await assert.rejects(registry.resolve("claude-code"), /planning provider.*not available/i);
});

test("Codex provider produces cleanup-safe arguments and final text", () => {
  const args = codexCliProvider.buildArgs("E:\\relay");
  assert.deepEqual(args.slice(0, 5), ["exec", "--json", "--sandbox", "workspace-write", "--disable"]);
  assert.match(args.join(" "), /--cd E:\\relay/);
  assert.equal(args.at(-1), "-");
  assert.doesNotMatch(args.join(" "), /prompt/);
  assert.doesNotMatch(args.join(" "), /resume|full-auto/i);
  assert.equal(codexCliProvider.buildStdin("prompt"), "prompt");
  assert.equal(codexCliProvider.extractAssistantText({
    type: "item.completed",
    item: { type: "agent_message", text: "codex plan" },
  }), "codex plan");
  assert.equal(codexCliProvider.extractAssistantText({
    type: "item.completed",
    item: { type: "command_execution", text: "ignore" },
  }), "");
});

test("Claude Code provider produces cleanup-safe arguments and final text", () => {
  const args = claudeCodeCliProvider.buildArgs("E:\\relay");
  assert.deepEqual(args, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"]);
  assert.doesNotMatch(args.join(" "), /prompt/);
  assert.doesNotMatch(args.join(" "), /resume/i);
  assert.deepEqual(JSON.parse(claudeCodeCliProvider.buildStdin("prompt")), {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "prompt" }] },
  });
  assert.equal(claudeCodeCliProvider.extractAssistantText({ type: "result", result: "claude plan" }), "claude plan");
  assert.equal(claudeCodeCliProvider.extractAssistantText({
    type: "assistant",
    message: { content: [{ type: "text", text: "draft plan" }, { type: "tool_use", name: "ignored" }] },
  }), "draft plan");
  assert.equal(claudeCodeCliProvider.isTerminalEvent({ type: "result", is_error: false }), "completed");
  assert.equal(claudeCodeCliProvider.isTerminalEvent({ type: "result", is_error: true }), "failed");
});
