import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const taskSource = fs.readFileSync(new URL("../src/figmaPrefabImportTask.ts", import.meta.url), "utf8");
const serverSource = fs.readFileSync(new URL("../src/httpServer.ts", import.meta.url), "utf8");

test("HTTP cannot execute deterministic imports", () => {
  assert.doesNotMatch(serverSource, /startFigmaPrefabImportTask|proxyLegacy/);
  assert.match(serverSource, /410/);
  assert.match(serverSource, /UPGRADE_REQUIRED/);
});

test("deterministic task invokes the fixed split pipeline with session-bound arguments", () => {
  assert.match(taskSource, /run_full_import\.py/);
  for (const flag of [
    "--unity-project",
    "--figma-url",
    "--target-prefab",
    "--target-image-dir",
    "--file-key",
    "--session-id",
    "--infer-formal-names",
    "--formal-layout",
    "--formal-output-dir",
    "--overwrite",
    "--manifest-dir",
    "--wall-clock-report",
    "--yes"
  ]) {
    assert.match(taskSource, new RegExp(`['\"]${flag}['\"]`), `missing ${flag}`);
  }
  assert.match(taskSource, /create-new-only/);
  assert.match(taskSource, /formal-layout[\s\S]{0,80}split/);
  assert.match(taskSource, /--unity-project-id/);
  assert.doesNotMatch(taskSource, /--unity-gateway-url|unityGatewayCandidates/);
});

test("task enforces project and target authority plus success summary", () => {
  assert.match(taskSource, /UnityProjectRegistry|registry/);
  assert.match(taskSource, /Assets/);
  assert.match(taskSource, /\.\./);
  assert.match(taskSource, /realpathSync|symlink|junction/i);
  assert.match(taskSource, /lock|mutex|inFlight/i);
  assert.match(taskSource, /verifyAllPass/);
  assert.match(taskSource, /status.*completed/);
  assert.match(taskSource, /outputs|target folder|beneath/i);
});

test("task has bounded output and explicit error transitions", () => {
  assert.match(taskSource, /slice\(-\d+\)/);
  assert.match(taskSource, /status\s*=\s*["']error["']/);
  assert.match(taskSource, /SUMMARY_JSON/);
  assert.match(taskSource, /nonzero|exit code|exited with code/i);
});
