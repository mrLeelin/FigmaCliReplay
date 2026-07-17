import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  classifyClaudeTerminalEvent,
  codexExecArgs,
  localAiTimeoutPolicy,
} from "../dist/localAiRunner.js";

test("Claude result events end the current turn immediately", () => {
  assert.equal(classifyClaudeTerminalEvent({ type: "result", subtype: "success", is_error: false }), "completed");
  assert.equal(classifyClaudeTerminalEvent({ type: "result", subtype: "error_during_execution", is_error: true }), "failed");
  assert.equal(classifyClaudeTerminalEvent({ type: "assistant" }), null);
});

test("generic AI prompts keep the long-running follow-up timeout", () => {
  assert.deepEqual(localAiTimeoutPolicy("unity"), {
    totalMs: 30 * 60 * 1000,
    idleMs: 5 * 60 * 1000,
  });
});

test("Codex uses the current noninteractive CLI contract", () => {
  const args = codexExecArgs("E:\\relay", "do the task");
  assert.deepEqual(args.slice(0, 4), ["exec", "--json", "--sandbox", "workspace-write"]);
  assert.equal(args.includes("--full-auto"), false);
  assert.equal(args.at(-1), "do the task");

  const source = fs.readFileSync(new URL("../src/localAiRunner.ts", import.meta.url), "utf8");
  assert.match(source, /stdio:\s*\["ignore",\s*"pipe",\s*"pipe"\]/);
  assert.doesNotMatch(source, /launched\.stdin\.end\(\)/);
});
