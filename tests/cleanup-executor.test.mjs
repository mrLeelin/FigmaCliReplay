import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildCleanupPipelineProcess, validateCleanupPipelineReport } from "../dist/cleanup/cleanupExecutor.js";

test("hierarchy cleanup executor disables ComponentSets until final satisfaction", () => {
  const process = buildCleanupPipelineProcess({
    pluginRoot: "E:\\relay",
    sessionId: "figma-session",
    rootNodeId: "42:100",
    fileKey: "file-key",
    workDir: "E:\\run\\skill-pipeline",
    outputPath: "E:\\run\\cleanup-pipeline-report.json",
  });
  assert.equal(process.command, "python");
  assert.match(process.args[0], /run_cleanup_pipeline\.py$/);
  assert.deepEqual(process.args.slice(1), [
    "--node-id", "42:100",
    "--file-key", "file-key",
    "--session-id", "figma-session",
    "--work-dir", path.win32.normalize("E:\\run\\skill-pipeline"),
    "--output", path.win32.normalize("E:\\run\\cleanup-pipeline-report.json"),
    "--apply-confirmed",
    "--auto-nested-generic",
    "--no-auto-component-sets",
    "--detect-psd-prefix-hints",
    "--timeout", "600",
  ]);
});

test("confirmed ComponentSet executor invokes only the variant stage", () => {
  const process = buildCleanupPipelineProcess({
    pluginRoot: "E:\\relay",
    sessionId: "figma-session",
    rootNodeId: "42:100",
    workDir: "E:\\run\\component-sets",
    outputPath: "E:\\run\\cleanup-component-sets-report.json",
    stage: "component-sets",
  });
  assert.ok(process.args.includes("--auto-component-sets-only"));
  assert.ok(!process.args.includes("--auto-nested-generic"));
  assert.ok(!process.args.includes("--no-auto-component-sets"));
});

test("skill report requires a completed status and propagates nested verification failures", () => {
  assert.equal(validateCleanupPipelineReport({ status: "completed", steps: [] }).state, "succeeded");
  assert.equal(validateCleanupPipelineReport({
    status: "completed",
    steps: [{ name: "AutoComponentSet", steps: [{ summary: { allPass: false } }] }],
  }).state, "recovery_required");
  assert.throws(() => validateCleanupPipelineReport({ status: "failed", steps: [] }), /cleanup skill pipeline status/i);
});
