import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { buildCleanupApplyProcess } from "../dist/cleanup/cleanupExecutor.js";

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

test("approved cleanup invokes only the exact transaction adapter", () => {
  const process = buildCleanupApplyProcess({
    pluginRoot: "E:\\relay",
    sessionId: "figma-session",
    planPath: "E:\\run\\cleanup-transaction-plan.json",
    outputPath: "E:\\run\\cleanup-apply-report.json",
  });
  const command = [process.command, ...process.args].join(" ");
  assert.match(command, /apply_cleanup_plan\.py/);
  assert.doesNotMatch(command, /run_cleanup_pipeline|auto-component|auto-nested/i);
});

test("cleanup UI approval is state-based and has no component-candidate preview", () => {
  const source = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");
  const previewStart = source.indexOf("function renderCleanupPlanPreview");
  const previewEnd = source.indexOf("function invalidateTerminalCleanupRun", previewStart);
  const preview = source.slice(previewStart, previewEnd);
  assert.match(preview, /planSummary\.operations/);
  assert.doesNotMatch(preview, /componentCandidate/i);

  const approvalStart = source.indexOf("async function continueAiCleanup");
  const approvalEnd = source.indexOf("async function stopActiveAiCleanup", approvalStart);
  const approval = source.slice(approvalStart, approvalEnd);
  assert.match(approval, /run\.state !== "review"/);
  assert.match(approval, /approval:\s*true,\s*snapshotHash/);
  assert.doesNotMatch(approval.split("if \(!isCleanupApproval")[0], /sessionAvailable|cliSessionId/);
});
