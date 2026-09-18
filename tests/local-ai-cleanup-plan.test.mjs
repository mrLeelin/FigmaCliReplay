import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCleanupPipelineProcess } from "../dist/cleanup/cleanupExecutor.js";

test("cleanup uses a resumable local AI conversation instead of the one-shot planner", () => {
  const source = fs.readFileSync(new URL("../src/localAiRunner.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /CleanupRunPhase|runLocalAiCleanup|buildCleanupPlanReviewTask/);
  assert.doesNotMatch(source, /buildCleanupApplyInstruction|startCleanupApply|validateCleanupApprovalState/);
  assert.doesNotMatch(source, /cleanupPipelinePlanPath/);
  assert.match(source, /CleanupConfirmationDecisionFileName/);
  assert.match(source, /materializeCleanupConfirmationPlanArtifact/);
  assert.match(source, /compileCleanupConfirmationPlanToV3/);
  assert.match(source, /configureLocalAiCleanupDispatcher/);
  assert.match(source, /startRelayOwnedHierarchyExecution/);
  assert.match(source, /startRelayOwnedVariantExecution/);
  assert.match(source, /dispatchConfirmedComponentSets/);
  assert.match(source, /cleanupSnapshotFrom\(payload\.cleanupSnapshot\)/);
  assert.match(source, /beginCleanupAiWriteGuard/);
  assert.match(source, /clientRequestId/);
  assert.match(source, /followupRequests/);
  assert.match(source, /assertCleanupAiPhaseWriteEvidence/);
  assert.match(source, /SupportedPromptTemplates\s*=\s*new Set\(\["cleanup", "unity", "componentVariants"\]\)/);
  assert.match(source, /buildCleanupConversationTask\(/);
  assert.match(source, /initialInputChars/);
  assert.match(source, /inputChars: initialInputChars/);
});

test("cleanup follow-up requests are idempotent and failed synchronous launches roll back phase state", () => {
  const source = fs.readFileSync(new URL("../src/localAiRunner.ts", import.meta.url), "utf8");
  const start = source.indexOf("export function followupAiRun(");
  const end = source.indexOf("export function stopAiRun", start);
  const followup = source.slice(start, end);

  assert.match(followup, /clientRequestId/);
  assert.match(followup, /run\.followupRequests\.get\(clientRequestId\)/);
  assert.match(followup, /reused: true/);
  assert.match(followup, /try \{[\s\S]*startTurn\(run, prompt, true\)/);
  assert.match(followup, /catch \(error\) \{[\s\S]*run\.cleanupPhase = previousCleanupPhase/);
});

test("a satisfied cleanup follow-up dispatches variants through Relay instead of resuming the AI CLI", () => {
  const source = fs.readFileSync(new URL("../src/localAiRunner.ts", import.meta.url), "utf8");
  const start = source.indexOf("export function followupAiRun(");
  const end = source.indexOf("export function stopAiRun", start);
  const followup = source.slice(start, end);

  assert.match(followup, /nextCleanupPhase === "variants"/);
  assert.match(followup, /validatedVariantPlan = compileCleanupConfirmationPlanToV3/);
  assert.match(followup, /if \(validatedVariantPlan\) \{[\s\S]*startRelayOwnedVariantExecution/);
  assert.match(followup, /canDispatchSatisfiedVariantsWithoutCli/);
});

test("Relay records successful cleanup writes only after the Figma result succeeds", () => {
  const source = fs.readFileSync(new URL("../src/runtimeRelay.ts", import.meta.url), "utf8");
  const start = source.indexOf("setResult(requestId: string, result: unknown)");
  const end = source.indexOf("waitResult(", start);
  const setResult = source.slice(start, end);

  assert.match(setResult, /recordCleanupAiJobResult/);
  assert.match(setResult, /!isFailedJobResult\(result\)/);
  assert.match(setResult, /job\.targetSessionId/);
});

test("cleanup conversation treats the Relay as an externally owned CLI client endpoint", () => {
  const source = fs.readFileSync(new URL("../src/localAiRunner.ts", import.meta.url), "utf8");

  assert.match(source, /http:\/\/127\.0\.0\.1:32130/);
  assert.match(source, /never launch, restart, stop, kill, or reconfigure the Relay/i);
  assert.match(source, /never bind or listen on ports 32130 or 32131/i);
  assert.match(source, /WinError 10055/i);
  assert.match(source, /The task-start preflight is authoritative/i);
  assert.match(source, /Do not independently run curl, Invoke-WebRequest, or any direct \/health probe/i);
  assert.doesNotMatch(source, /Run the initial read-only health check exactly/);
});

test("the complete cleanup skill keeps hierarchy approval separate from variant satisfaction", () => {
  const skill = fs.readFileSync(new URL("../ai/skills/figma-hierarchy-cleanup/SKILL.md", import.meta.url), "utf8");

  assert.match(skill, /本次确认只授权层级整理，不授权 ComponentSet\/变体/);
  assert.match(skill, /只有用户明确满意后才允许进入 `AutoComponentSet`/);
  assert.doesNotMatch(skill, /收到确认后必须连续执行层级整理和 AutoComponentSet/);
  assert.doesNotMatch(skill, /确认后我会连续完成层级打组、验证和自动 ComponentSet/);
  assert.match(skill, /插件窗口 AI 整理对话不得追加 health\/端口探测/);
});

test("cleanup prompt keeps the AI read-only and delegates validated execution to Relay", () => {
  const prompt = fs.readFileSync(new URL("../prompts/cleanup.md", import.meta.url), "utf8");
  const skill = fs.readFileSync(new URL("../ai/skills/figma-hierarchy-cleanup/SKILL.md", import.meta.url), "utf8");
  const runner = fs.readFileSync(new URL("../src/localAiRunner.ts", import.meta.url), "utf8");

  for (const source of [skill]) {
    assert.match(source, /原始直接子节点.*ID.*name/);
    assert.match(source, /missing\s*=\s*\[\]/);
    assert.match(source, /duplicate\s*=\s*\[\]/);
    assert.match(source, /extra\s*=\s*\[\]/);
    assert.match(source, /其余节点.*随对应图片移动/);
    assert.match(source, /机器可读/);
    assert.match(source, /本地.*校验/);
    assert.match(source, /不得询问确认/);
  }
  assert.match(prompt, /Relay 会在启动 AI 前生成唯一的执行规则和权威快照/);
  assert.match(runner, /The first turn remains read-only/);
  assert.match(runner, /Relay dispatches the validated safe hierarchy transaction automatically/);
  assert.match(runner, /Only an explicit satisfied response/);
  assert.match(prompt, /\$figma-hierarchy-cleanup/);
});

test("AI controls require a uniquely matched live session over WebSocket", () => {
 const source = fs.readFileSync(new URL("../src/relayControl.ts", import.meta.url), "utf8");
 assert.match(source, /sessions.length !== 1/);
 assert.match(source, /session.authenticated/);
 assert.ok(source.includes("openLocalAiTerminal(payload)"));
 assert.match(source, /cleanup.controller.start/);
});

test("interactive terminal launch waits for a real PowerShell hosted by Windows Terminal", () => {
  const source = fs.readFileSync(new URL("../src/relayControl.ts", import.meta.url), "utf8");
  const runner = fs.readFileSync(new URL("../src/localAiRunner.ts", import.meta.url), "utf8");
  const start = runner.indexOf("export async function openLocalAiTerminal(");
  const end = runner.indexOf("function buildInteractiveTerminalTask", start);
  const terminal = runner.slice(start, end);

  assert.match(source, /await ai.openLocalAiTerminal\(payload\)/);
  assert.match(terminal, /terminal\.pid/);
  assert.match(terminal, /await launchInteractivePowerShell\(/);
  assert.match(runner, /spawn\("wt\.exe", \["-w", "new", "nt"/);
  assert.match(runner, /await waitForTerminalPid\(/);
  assert.doesNotMatch(terminal, /spawn\("powershell\.exe"/);
});

test("interactive terminal resolves the native executable behind an npm cmd shim", async (context) => {
  const runner = await import("../dist/localAiRunner.js");
  assert.equal(typeof runner.resolveInteractiveRunnerCommand, "function");

  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-relay-ai-shim-"));
  context.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
  const nativeCommand = path.join(fixtureDir, "fake-ai.exe");
  const commandShim = path.join(fixtureDir, "fake-ai.cmd");
  fs.writeFileSync(nativeCommand, "", "utf8");
  fs.writeFileSync(commandShim, [
    "@ECHO off",
    "SET dp0=%~dp0",
    '"%dp0%\\fake-ai.exe" %*',
    "",
  ].join("\r\n"), "utf8");

  assert.equal(runner.resolveInteractiveRunnerCommand(commandShim), nativeCommand);
});

test("transient plugin websocket reconnects receive a grace lease before AI cancellation", () => {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /disconnectGraceTimers/);
  assert.match(source, /gateway\.hasLiveSessionId\(sessionId\)/);
  assert.match(source, /setTimeout\([\s\S]*stopAiRunsForSession\(sessionId, reason\)[\s\S]*5000/);
});

test("direct cleanup invokes the hierarchy skill pipeline without premature ComponentSets", () => {
  const process = buildCleanupPipelineProcess({
    pluginRoot: "E:\\relay",
    sessionId: "figma-session",
    rootNodeId: "10:20",
    fileKey: "figma-file",
    workDir: "E:\\run\\pipeline",
    outputPath: "E:\\run\\cleanup-pipeline-report.json",
  });
  const command = [process.command, ...process.args].join(" ");
  assert.match(command, /run_cleanup_pipeline\.py/);
  assert.match(command, /--apply-confirmed/);
  assert.match(command, /--auto-nested-generic/);
  assert.match(command, /--no-auto-component-sets/);
  assert.doesNotMatch(command, /--auto-component-sets(?:\s|$)/);
  assert.match(command, /--session-id figma-session/);
});

test("confirmed satisfaction invokes the ComponentSet-only skill stage", () => {
  const process = buildCleanupPipelineProcess({
    pluginRoot: "E:\\relay",
    sessionId: "figma-session",
    rootNodeId: "10:20",
    workDir: "E:\\run\\component-sets",
    outputPath: "E:\\run\\cleanup-component-sets-report.json",
    stage: "component-sets",
  });
  const command = [process.command, ...process.args].join(" ");
  assert.match(command, /--auto-component-sets-only/);
  assert.doesNotMatch(command, /--auto-nested-generic/);
});

test("cleanup UI opens a resumable conversation instead of auto-applying a transaction", () => {
  const source = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");
  const start = source.indexOf("function startAiRun");
  const end = source.indexOf("function scheduleAiCleanupPoll", start);
  const startAiRun = source.slice(start, end);
  const requestStart = source.indexOf("function requestAiRun");
  const requestEnd = source.indexOf("function requestCleanupSnapshot", requestStart);
  const requestAiRun = source.slice(requestStart, requestEnd);

  assert.match(startAiRun, /postIdempotentAiStartWithRetry\(payload, startOperation\)/);
  assert.match(startAiRun, /cleanupSnapshot:\s*template === "cleanup" \? selection : undefined/);
  assert.match(startAiRun, /clientRequestId:\s*clientRequestId/);
  assert.doesNotMatch(startAiRun, /autoApprove:\s*true/);
  assert.match(requestAiRun, /requestCleanupSnapshot\(\)/);
  assert.match(source, /AI 整理对话/);
});

test("cleanup UI does not request a hierarchy-plan confirmation for new conversation runs", () => {
  const source = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");
  const start = source.indexOf("function cleanupFollowupNeedsFreshSnapshot");
  const end = source.indexOf("function captureCleanupSnapshotForFollowup", start);
  const followupSnapshotRule = source.slice(start, end);

  assert.doesNotMatch(followupSnapshotRule, /awaiting_plan_confirmation/);
  assert.match(source, /Relay 已完成层级整理并等待满意确认/);
  assert.match(source, /ComponentSet 变体已完成/);
});
