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

test("PSD task exposes the uploaded file fingerprint and detects byte-identical reuploads", () => {
  assert.match(taskSource, /sourceFile:\s*\{/);
  assert.match(taskSource, /sha256:\s*string/);
  assert.match(taskSource, /lastModified:\s*number/);
  assert.match(taskSource, /identicalToPreviousUpload:\s*boolean/);
  assert.match(taskSource, /createHash\("sha256"\)/);
  assert.match(taskSource, /findPreviousIdenticalPsdUpload/);
});

test("byte-identical reupload detection checks prior PSD bytes even when the file name changed", () => {
  const helperStart = taskSource.indexOf("function findPreviousIdenticalPsdUpload(");
  const helperEnd = taskSource.indexOf("function rootNameFromFile(", helperStart);
  const helperSource = taskSource.slice(helperStart, helperEnd);
  assert.match(helperSource, /readdirSync\(taskDirPath/);
  assert.match(helperSource, /candidateSha256 === sha256/);
  assert.doesNotMatch(helperSource, /return candidateSha256 === sha256/);
});
