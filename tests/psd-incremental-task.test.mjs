import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const taskSource = fs.readFileSync(new URL("../src/psdImportTask.ts", import.meta.url), "utf8");
const httpSource = fs.readFileSync(new URL("../src/httpServer.ts", import.meta.url), "utf8");
const submitSource = fs.readFileSync(new URL("../ai/skills/psd-layer-to-figma/scripts/submit_psd_import_job.py", import.meta.url), "utf8");

test("PSD task supports preview followed by apply using the same artifacts", () => {
  assert.match(taskSource, /mode: PsdImportMode/);
  assert.match(taskSource, /applyPsdImportTask/);
  assert.match(taskSource, /baselineFingerprint/);
  assert.match(taskSource, /readResultSummary/);
  assert.match(httpSource, /const psdApplyMatch/);
  assert.match(httpSource, /applyPsdImportTask\(config, taskId, payload\)/);
  assert.match(submitSource, /--import-mode/);
});
