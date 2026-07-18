import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { buildCleanupPipelineProcess } from "../dist/cleanup/cleanupExecutor.js";

test("generic local AI runner no longer owns cleanup planning or approval state", () => {
  const source = fs.readFileSync(new URL("../src/localAiRunner.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /CleanupRunPhase|runLocalAiCleanup|buildCleanupPlanReviewTask/);
  assert.doesNotMatch(source, /buildCleanupApplyInstruction|startCleanupApply|validateCleanupApprovalState/);
  assert.doesNotMatch(source, /cleanupSnapshot|cleanupPipelinePlanPath|componentCandidates/);
  assert.doesNotMatch(source, /taskKind\s*===\s*["']cleanup["']/);
});

test("legacy cleanup HTTP entrypoint forwards into the single V2 controller", () => {
  const source = fs.readFileSync(new URL("../src/httpServer.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /runLocalAiCleanup/);
  assert.match(source, /startLegacyCleanup\(cleanupRuntime, payload\)/);
  assert.match(source, /cleanupRuntime\.controller\.start\(/);
  const genericActions = source.slice(
    source.indexOf('if (pathname === "/ai-runner/config"'),
    source.indexOf('if (pathname === "/open-plugin-folder"'),
  );
  assert.doesNotMatch(genericActions, /cleanupRuntime\.controller\.(approve|cancel)/);
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

test("cleanup UI treats the initiating click as authorization and keeps final feedback in-page", () => {
  const source = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");
  const previewStart = source.indexOf("function renderCleanupPlanPreview");
  const previewEnd = source.indexOf("function invalidateTerminalCleanupRun", previewStart);
  const preview = source.slice(previewStart, previewEnd);
  assert.match(preview, /skill pipeline/i);
  assert.doesNotMatch(preview, /planSummary\.operations/);
  assert.doesNotMatch(preview, /componentCandidate/i);

  assert.match(source, /autoApprove:\s*true/);
  assert.match(source, /id="aiCleanupSatisfaction"/);
  assert.match(source, /confirm-component-sets/);
  assert.match(source, /awaiting_component_confirmation/);
  assert.doesNotMatch(source, /cleanupRunDialog/);
  assert.doesNotMatch(source, /approval:\s*true,\s*snapshotHash/);
});
