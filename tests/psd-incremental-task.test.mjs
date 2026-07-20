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

test("gateway preserves all preview terminal states", () => {
  for (const status of [
    "preview-ready", "preview-blocked", "preview-no-changes", "preview-baseline-required",
  ]) {
    assert.match(taskSource, new RegExp(status));
  }
  assert.match(taskSource, /const previewStatus = stringValue\(result\.status\)/);
});

test("baseline adoption reuses artifacts but cannot call apply", () => {
  assert.match(taskSource, /adoptPsdImportBaseline/);
  assert.match(taskSource, /incremental-baseline-adopt/);
  assert.match(httpSource, /\/adopt-baseline/);
  assert.match(submitSource, /baseline-adopted/);
});

test("only preview-ready can enter incremental apply", () => {
  const applyStart = taskSource.indexOf("export function applyPsdImportTask(");
  const adoptStart = taskSource.indexOf("export function adoptPsdImportBaseline(", applyStart);
  const applySource = taskSource.slice(applyStart, adoptStart);
  assert.match(applySource, /task\.status !== "preview-ready"/);
  assert.doesNotMatch(applySource, /preview-baseline-required/);

  const adoptionSource = taskSource.slice(adoptStart);
  assert.match(adoptionSource, /task\.status !== "preview-baseline-required"/);
});
