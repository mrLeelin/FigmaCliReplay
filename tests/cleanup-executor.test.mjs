import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildCleanupApplyProcess, validateCleanupExecutionReport } from "../dist/cleanup/cleanupExecutor.js";

test("exact cleanup executor invokes only the thin transaction script", () => {
  const process = buildCleanupApplyProcess({
    pluginRoot: "E:\\relay",
    sessionId: "figma-session",
    planPath: "E:\\run\\cleanup-transaction-plan.json",
    outputPath: "E:\\run\\cleanup-apply-report.json",
  });
  assert.equal(process.command, "python");
  assert.match(process.args[0], /apply_cleanup_plan\.py$/);
  assert.deepEqual(process.args.slice(1), [
    "--session-id", "figma-session",
    "--plan", path.win32.normalize("E:\\run\\cleanup-transaction-plan.json"),
    "--output", path.win32.normalize("E:\\run\\cleanup-apply-report.json"),
    "--timeout", "120",
  ]);
  assert.doesNotMatch(process.args.join(" "), /auto-component|auto-nested|run_cleanup_pipeline/i);
});

test("execution report accepts only explicit terminal transaction states", () => {
  assert.equal(validateCleanupExecutionReport({ status: "completed", state: "succeeded" }).state, "succeeded");
  assert.equal(validateCleanupExecutionReport({ status: "rolled_back", state: "rolled_back" }).state, "rolled_back");
  assert.equal(validateCleanupExecutionReport({ status: "recovery_required", state: "recovery_required" }).state, "recovery_required");
  assert.throws(() => validateCleanupExecutionReport({ status: "completed", state: "rolled_back" }), /cleanup transaction status/i);
  assert.throws(() => validateCleanupExecutionReport({ status: "completed", state: "unknown" }), /invalid cleanup transaction state/i);
  assert.throws(() => validateCleanupExecutionReport({ status: "failed", state: "failed" }), /invalid cleanup transaction state/i);
});
