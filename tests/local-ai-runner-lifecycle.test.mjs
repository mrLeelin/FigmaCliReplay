import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  buildCleanupConversationTask,
  cleanupInitialUserRequest,
  classifyClaudeTerminalEvent,
  classifyCleanupFollowup,
  codexExecArgs,
  findProviderSessionId,
  formatCodexStreamEvent,
  localAiTimeoutPolicy,
} from "../dist/localAiRunner.js";

test("cleanup UI template is normalized into one user request instead of duplicating Relay policy", () => {
  const uiTemplate = "# Relay-owned cleanup execution\n\nWrite cleanup-plan-decision.json with subgroups: [].";
  const source = fs.readFileSync(new URL("../src/localAiRunner.ts", import.meta.url), "utf8");
  const task = buildCleanupConversationTask("\u6574\u7406\u5f53\u524d\u9009\u4e2d\u7684 Figma \u8282\u70b9\u3002");

  assert.equal(cleanupInitialUserRequest(uiTemplate), "\u6574\u7406\u5f53\u524d\u9009\u4e2d\u7684 Figma \u8282\u70b9\u3002");
  assert.equal(cleanupInitialUserRequest("\u4f7f\u7528 Relay \u5185\u7f6e\u6574\u7406\u6280\u80fd\uff1a$figma-hierarchy-cleanup-mcp\u3002"), "\u6574\u7406\u5f53\u524d\u9009\u4e2d\u7684 Figma \u8282\u70b9\u3002");
  assert.equal(cleanupInitialUserRequest("\u6309\u94ae\u533a\u548c\u80cc\u666f\u9700\u5206\u5f00\u3002"), "\u6309\u94ae\u533a\u548c\u80cc\u666f\u9700\u5206\u5f00\u3002");
  assert.match(task, /\$figma-hierarchy-cleanup-mcp/);
  assert.match(source, /Cleanup prompt normalized/);
  assert.match(source, /embeddedPolicyRemoved/);
});

test("cleanup conversation begins with Relay-managed provider-neutral analysis and automatic safe dispatch", () => {
  const task = buildCleanupConversationTask("整理当前选中的 Figma 节点");

  assert.match(task, /Relay-managed cleanup policy/);
  assert.match(task, /所有面向用户的回复、进度摘要和错误说明必须使用简体中文/);
  assert.match(task, /Do not call Skill\(\) or ToolSearch to discover this skill/i);
  assert.match(task, /figma-hierarchy-cleanup-mcp\/SKILL\.md/);
  assert.match(task, /figma_hierarchy_cleanup_mcp_client\.py/);
  assert.match(task, /analyze.*plan.*apply/i);
  assert.match(task, /Relay is the only Figma write authority/i);
  assert.doesNotMatch(task, /no external Skill installation, lookup, or terminal setup is required/i);
  assert.doesNotMatch(task, /do not independently load, install, or execute a skill script/i);
  assert.match(task, /read-only/i);
  assert.match(task, /must not write/i);
  assert.match(task, /Relay dispatches the validated safe hierarchy transaction automatically/i);
  assert.doesNotMatch(task, /End the turn by asking the user for explicit confirmation/i);
  assert.match(task, /满意/);
});

test("cleanup conversation treats duplicate PSD names as normal input and always emits a Relay decision", () => {
  const task = buildCleanupConversationTask("整理当前选中的 Figma 节点", {
    schemaVersion: 1,
    rootNodeId: "ROOT",
    nodes: [
      { id: "ROOT", parentId: "", type: "FRAME", name: "Root", siblingIndex: 0, depth: 0 },
      { id: "A", parentId: "ROOT", type: "RECTANGLE", name: "图层", siblingIndex: 0, depth: 1 },
      { id: "B", parentId: "ROOT", type: "RECTANGLE", name: "图层", siblingIndex: 1, depth: 1 },
    ],
  });

  assert.match(task, /Duplicate PSD layer names are expected input/i);
  assert.match(task, /node IDs, sibling order, type, geometry, and hierarchy are authoritative/i);
  assert.match(task, /Do not ask the user to resolve duplicate layer names/i);
  assert.match(task, /write cleanup-plan-decision\.json before ending this initial turn/i);
  assert.match(task, /figma-hierarchy-cleanup-mcp\/SKILL\.md/);
});

test("cleanup conversation requires an explicit machine-validated mapping before Relay dispatch", () => {
  const task = buildCleanupConversationTask("整理当前选中的 Figma 节点");

  assert.match(task, /every original direct child/i);
  assert.match(task, /exactly once/i);
  assert.match(task, /original ID and name/i);
  assert.match(task, /missing \[\]/i);
  assert.match(task, /duplicate \[\]/i);
  assert.match(task, /extra \[\]/i);
  assert.match(task, /do not use ellipses/i);
  assert.match(task, /其余节点/);
  assert.match(task, /compact count-based semantic decision/i);
  assert.match(task, /do not ask for hierarchy confirmation/i);
});

test("Relay-owned cleanup progress messages are Chinese for the plugin window", () => {
  const runner = fs.readFileSync(new URL("../src/localAiRunner.ts", import.meta.url), "utf8");
  const executor = fs.readFileSync(new URL("../src/cleanup/cleanupExecutor.ts", import.meta.url), "utf8");
  const applyScript = fs.readFileSync(new URL("../ai/skills/figma-hierarchy-cleanup-mcp/scripts/apply_cleanup_plan.py", import.meta.url), "utf8");

  assert.match(runner, /Relay 正在执行已验证的层级整理事务/);
  assert.match(runner, /层级整理已完成并验证，是否满意？/);
  assert.match(runner, /ComponentSet 变体阶段已完成/);
  assert.match(executor, /已验证的整理事务已完成/);
  assert.match(applyScript, /正在提交已验证的整理事务/);
  assert.doesNotMatch(runner, /Relay is applying the validated hierarchy transaction/);
  assert.doesNotMatch(applyScript, /Submitting the approved cleanup transaction/);
});

test("cleanup snapshot is persisted beside the task instead of embedded in the prompt", () => {
  const snapshot = {
    schemaVersion: 1,
    rootNodeId: "ROOT",
    nodes: [{ id: "ROOT", parentId: "", type: "FRAME", name: "Root", siblingIndex: 0, depth: 0 }],
  };
  const task = buildCleanupConversationTask("整理当前选中的 Figma 节点", snapshot);
  const source = fs.readFileSync(new URL("../src/localAiRunner.ts", import.meta.url), "utf8");

  assert.match(task, /cleanup-snapshot\.json/);
  assert.doesNotMatch(task, /"rootNodeId":"ROOT"/);
  assert.match(source, /path\.join\(runDir, "cleanup-snapshot\.json"\)/);
  assert.match(source, /snapshot-persisted/);
  assert.match(source, /replaceAll\("\\\\", "\/"\)/);
  assert.match(source, /Do not create a helper script to re-encode or parse the supplied snapshot/i);
  assert.doesNotMatch(source, /首轮限定为只读 Skill 分析/);
});

test("Relay materializes a fixed confirmation artifact from a compact decision and auto-repairs rejection", () => {
  const task = buildCleanupConversationTask("整理当前选中的 Figma 节点");
  const source = fs.readFileSync(new URL("../src/localAiRunner.ts", import.meta.url), "utf8");

  assert.match(task, /cleanup-plan-decision\.json/);
  assert.match(task, /cleanup-plan-for-confirmation\.json/);
  assert.match(task, /do not write cleanup-plan-for-confirmation\.json/i);
  assert.match(task, /count-based/i);
  assert.match(task, /startNodeId/);
  assert.match(task, /endNodeId/);
  assert.match(task, /subgroups/);
  assert.match(source, /materializeCleanupConfirmationPlanArtifact/);
  assert.match(source, /confirmation-plan-materialized/);
  assert.match(source, /validateCleanupConfirmationPlanArtifact/);
  assert.match(source, /plan-validation-failed/);
  assert.match(source, /auto-plan-repair/);
  assert.match(source, /MaxCleanupPlanRepairAttempts/);
  assert.match(source, /cleanupConfirmationPlanValidated/);
});

test("cleanup adjustment follow-ups replace the stale authoritative snapshot", () => {
  const source = fs.readFileSync(new URL("../src/localAiRunner.ts", import.meta.url), "utf8");

  assert.match(source, /freshCleanupSnapshot/);
  assert.match(source, /snapshot-refreshed/);
  assert.match(source, /fs\.writeFileSync\(run\.cleanupSnapshotFile/);
  assert.match(source, /fresh cleanup snapshot is required for cleanup plan adjustments/i);
});

test("Claude cleanup turns ignore unrelated global MCP servers", () => {
  const source = fs.readFileSync(new URL("../src/localAiRunner.ts", import.meta.url), "utf8");
  const start = source.indexOf("function commandArgs(");
  const end = source.indexOf("export function codexExecArgs", start);
  const commandArgs = source.slice(start, end);

  assert.match(commandArgs, /run\.taskKind === "cleanup"[\s\S]*--strict-mcp-config/);
});

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

test("Relay client connection failures are recorded before an AI turn can exit successfully", () => {
  const source = fs.readFileSync(new URL("../src/localAiRunner.ts", import.meta.url), "utf8");

  assert.match(source, /relay-client-connection-failed/);
  assert.match(source, /curl:\\s\*\\\(7\\\)\\s\+Failed to connect/i);
  assert.match(source, /ENOBUFS/);
  assert.match(source, /relayClientFailureLogged/);
  assert.match(source, /status === "completed" && run\.relayClientFailureLogged/);
});

test("a recovered follow-up turn is not permanently failed by an earlier connection error", () => {
  const source = fs.readFileSync(new URL("../src/localAiRunner.ts", import.meta.url), "utf8");
  const followupStart = source.indexOf("export function followupAiRun");
  const followupEnd = source.indexOf("export function stopAiRun", followupStart);
  const followup = source.slice(followupStart, followupEnd);

  assert.match(followup, /run\.relayClientFailureLogged = false/);
});

test("resumable CLI session discovery ignores generic tool and message ids", () => {
  assert.equal(findProviderSessionId("claude", {
    type: "system",
    subtype: "init",
    session_id: "claude-session-1234",
    tool_result: { sessionId: "figma-relay-session-1234" },
  }), "claude-session-1234");
  assert.equal(findProviderSessionId("codex", {
    type: "thread.started",
    thread_id: "codex-thread-1234",
    item: { sessionId: "figma-relay-session-1234" },
  }), "codex-thread-1234");
  assert.equal(findProviderSessionId("codex", {
    type: "item.completed",
    item: { sessionId: "figma-relay-session-1234", thread_id: "nested-thread-1234" },
  }), undefined);
});

test("cleanup follow-up text advances only the matching server-side phase", () => {
  assert.equal(classifyCleanupFollowup("awaiting_plan_confirmation", "确认执行"), "hierarchy");
  assert.equal(classifyCleanupFollowup("awaiting_plan_confirmation", "按钮区域需要再细分"), "analysis");
  assert.equal(classifyCleanupFollowup("awaiting_satisfaction", "满意"), "variants");
  assert.equal(classifyCleanupFollowup("awaiting_satisfaction", "Tab 还需要调整"), "analysis");
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

test("Codex stream JSON is rendered as readable conversation output", () => {
  assert.deepEqual(formatCodexStreamEvent({ type: "thread.started", thread_id: "thread-1234" }), ["Codex 会话已初始化。"]) ;
  assert.deepEqual(formatCodexStreamEvent({
    type: "item.completed",
    item: { type: "agent_message", text: "层级计划已生成" },
  }), ["层级计划已生成"]);
  assert.deepEqual(formatCodexStreamEvent({
    type: "item.completed",
    item: { type: "command_execution", command: "python scripts/run_cleanup_pipeline.py", exit_code: 0 },
  }), ["命令执行完成（exit 0）：python scripts/run_cleanup_pipeline.py"]);
});
