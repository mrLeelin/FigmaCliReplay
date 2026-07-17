import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCleanupApplyInstruction,
  buildCleanupPlanReviewTask,
  captureCleanupAssistantText,
  cleanupApplyPhaseForOutput,
  persistValidatedCleanupPlanOutput,
  validateCleanupApprovalState,
} from "../dist/localAiRunner.js";

const snapshot = {
  schemaVersion: 1,
  rootNodeId: "R",
  capturedAt: "2026-07-17T06:30:00.000Z",
  limits: { maxNodes: 500, maxDepth: 12, maxTextCharacters: 256, maxBytes: 262144 },
  nodes: [
    { id: "R", parentId: "", type: "FRAME", name: "Root", siblingIndex: 0, depth: 0 },
    { id: "A", parentId: "R", type: "FRAME", name: "A", siblingIndex: 0, depth: 1 },
    { id: "B", parentId: "R", type: "FRAME", name: "B", siblingIndex: 1, depth: 1 },
  ],
};

const plan = {
  schemaVersion: 1,
  rootNodeId: "R",
  groups: [{ name: "HUD", parentNodeId: "R", sourceNodeIds: ["A", "B"], preserveSiblingOrder: true }],
  componentCandidates: [{ name: "HUD", sourceNodeIds: ["A", "B"], reason: "Repeated layout" }],
  warnings: [],
};

test("builds a compact read-only PlanReview task without the full skill", () => {
  const task = buildCleanupPlanReviewTask(snapshot);
  assert.match(task, /\[CLEANUP_PLAN_JSON\]/);
  assert.match(task, /Use only the supplied snapshot/i);
  assert.match(task, /do not call tools/i);
  assert.match(task, /do not.*subagents/i);
  assert.match(task, /preserve.*sibling order/i);
  assert.match(task, /PSD SharedPluginData/i);
  assert.match(task, /finish PlanReview within 3 minutes/i);
  assert.match(task, /"rootNodeId":"R"/);
  assert.doesNotMatch(task, /figma-hierarchy-cleanup-mcp[\\/]SKILL\.md/i);
  assert.doesNotMatch(task, /run_cleanup_pipeline\.py/i);
  assert.doesNotMatch(task, /query-selection|interactive traversal/i);
});

test("captures only assistant text from Claude and Codex stream events", () => {
  assert.equal(captureCleanupAssistantText("claude", { type: "result", result: "final plan" }), "final plan");
  assert.equal(captureCleanupAssistantText("claude", {
    type: "assistant",
    message: { content: [{ type: "text", text: "draft" }, { type: "tool_use", name: "bad" }] },
  }), "draft");
  assert.equal(captureCleanupAssistantText("codex", {
    type: "item.completed",
    item: { type: "agent_message", text: "codex final" },
  }), "codex final");
  assert.equal(captureCleanupAssistantText("codex", { type: "item.completed", item: { type: "command_execution", text: "ignore" } }), "");
});

test("approved cleanup enters verification when the pipeline emits verification evidence", () => {
  assert.equal(cleanupApplyPhaseForOutput("applying group changes", "applying"), "applying");
  assert.equal(cleanupApplyPhaseForOutput("Verifying hierarchy invariants", "applying"), "verifying");
  assert.equal(cleanupApplyPhaseForOutput("[SUMMARY_JSON] {\"ok\":true}", "applying"), "verifying");
  assert.equal(cleanupApplyPhaseForOutput("late apply log", "verifying"), "verifying");
});

test("persists one validated public plan and one pipeline adapter plan", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-cleanup-plan-"));
  try {
    const result = persistValidatedCleanupPlanOutput(
      `[CLEANUP_PLAN_JSON]\n${JSON.stringify(plan)}`,
      snapshot,
      runDir,
    );
    assert.equal(result.planReady, true);
    assert.equal(result.planPath, path.join(runDir, "cleanup-plan.json"));
    assert.equal(result.pipelinePlanPath, path.join(runDir, "cleanup-pipeline-plan.json"));
    assert.deepEqual(JSON.parse(fs.readFileSync(result.planPath, "utf8")), plan);
    assert.equal(JSON.parse(fs.readFileSync(result.pipelinePlanPath, "utf8")).groups[0].name, "[HUD]");
    assert.deepEqual(result.summary, {
      groupCount: 1,
      groups: [{ name: "HUD", sourceNodeCount: 2 }],
      componentCandidateCount: 1,
      componentCandidates: [{ name: "HUD", sourceNodeCount: 2 }],
      warningCount: 0,
      warnings: [],
    });
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("invalid output writes no plan artifacts and is not repaired", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-cleanup-invalid-"));
  try {
    assert.throws(
      () => persistValidatedCleanupPlanOutput("prose without marker", snapshot, runDir),
      /missing cleanup plan marker/i,
    );
    assert.equal(fs.existsSync(path.join(runDir, "cleanup-plan.json")), false);
    assert.equal(fs.existsSync(path.join(runDir, "cleanup-pipeline-plan.json")), false);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("runner source requires a compact snapshot and exposes validated plan state", () => {
  const source = fs.readFileSync(new URL("../src/localAiRunner.ts", import.meta.url), "utf8");
  const httpSource = fs.readFileSync(new URL("../src/httpServer.ts", import.meta.url), "utf8");
  assert.match(source, /isRecord\(payload\.snapshot\)/);
  assert.match(source, /cleanupSnapshot/);
  assert.match(source, /phase/);
  assert.match(source, /planSummary/);
  assert.match(source, /planReady/);
  assert.match(httpSource, /runLocalAiCleanup\(payload\)/);
});

test("cleanup approval requires a completed validated resumable run", () => {
  const ready = {
    status: "completed",
    phase: "awaiting-approval",
    planReady: true,
    cliSessionId: "session-12345678",
    cleanupPipelinePlanPath: "C:\\run\\cleanup-pipeline-plan.json",
  };
  assert.doesNotThrow(() => validateCleanupApprovalState(ready, { approval: true }));
  assert.throws(() => validateCleanupApprovalState(ready, { text: "确认" }), /explicit cleanup approval is required/i);
  assert.throws(() => validateCleanupApprovalState({ ...ready, status: "failed" }, { approval: true }), /completed PlanReview/i);
  assert.throws(() => validateCleanupApprovalState({ ...ready, phase: "planning" }, { approval: true }), /awaiting approval/i);
  assert.throws(() => validateCleanupApprovalState({ ...ready, planReady: false }, { approval: true }), /validated cleanup plan/i);
  assert.throws(() => validateCleanupApprovalState({ ...ready, cliSessionId: undefined }, { approval: true }), /resumable CLI session/i);
});

test("approved cleanup runs the persisted plan through the bundled deterministic pipeline", () => {
  const instruction = buildCleanupApplyInstruction({
    pluginRoot: "E:\\relay",
    rootNodeId: "R",
    sessionId: "figma-session",
    pipelinePlanPath: "E:\\run\\cleanup-pipeline-plan.json",
    runDir: "E:\\run",
  });
  assert.match(instruction, /figma-hierarchy-cleanup-mcp[\\/]SKILL\.md/i);
  assert.match(instruction, /run_cleanup_pipeline\.py/i);
  assert.match(instruction, /--node-id "R"/);
  assert.match(instruction, /--session-id "figma-session"/);
  assert.match(instruction, /--plan "E:\\run\\cleanup-pipeline-plan\.json"/);
  assert.match(instruction, /--apply-confirmed/);
  assert.match(instruction, /--auto-nested-generic/);
  assert.match(instruction, /--auto-component-sets/);
  assert.match(instruction, /do not recompute/i);
});

test("HTTP follow-up passes explicit approval instead of interpreting prose", () => {
  const source = fs.readFileSync(new URL("../src/httpServer.ts", import.meta.url), "utf8");
  assert.match(source, /followupAiRun\(runAction\[1\], token, payload\)/);
});
