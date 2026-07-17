import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyClaudeTerminalEvent,
  cleanupPlanReviewRules,
  localAiTimeoutPolicy,
} from "../dist/localAiRunner.js";

test("Claude result events end the current turn immediately", () => {
  assert.equal(classifyClaudeTerminalEvent({ type: "result", subtype: "success", is_error: false }), "completed");
  assert.equal(classifyClaudeTerminalEvent({ type: "result", subtype: "error_during_execution", is_error: true }), "failed");
  assert.equal(classifyClaudeTerminalEvent({ type: "assistant" }), null);
});

test("cleanup PlanReview has bounded total and idle time", () => {
  assert.deepEqual(localAiTimeoutPolicy("cleanup"), {
    totalMs: 5 * 60 * 1000,
    idleMs: 90 * 1000,
  });
});

test("cleanup initial turn is read-only, single-agent, and bounded", () => {
  const rules = cleanupPlanReviewRules().join("\n");
  assert.match(rules, /do not invoke any cleanup apply\/pipeline command/i);
  assert.match(rules, /Do not spawn subagents/i);
  assert.match(rules, /finish PlanReview within 3 minutes/i);
  assert.match(rules, /End the turn immediately/i);
});
