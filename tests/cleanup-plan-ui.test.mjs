import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const ui = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");

test("cleanup requests one compact snapshot and posts it to the runner", () => {
  assert.match(ui, /type: "QUERY_CLEANUP_SNAPSHOT"/);
  assert.match(ui, /QUERY_CLEANUP_SNAPSHOT_RESULT/);
  assert.match(ui, /function handleCleanupSnapshotResult/);
  assert.match(ui, /\{ snapshot: selection, sessionId: relaySessionId \}/);
  assert.match(ui, /\/ai-runner\/run-cleanup/);
  const requestStart = ui.indexOf("function requestCleanupSnapshot()");
  const requestEnd = ui.indexOf("function handleCleanupSnapshotResult", requestStart);
  assert.match(ui.slice(requestStart, requestEnd), /setTimeout/);
});

test("execution UI renders structured cleanup phases and plan preview", () => {
  assert.match(ui, /id="aiCleanupPlanPreview"/);
  for (const phase of ["capturing", "planning", "validating", "awaiting-approval", "applying", "verifying"]) {
    assert.match(ui, new RegExp(`phase === "${phase}"`));
  }
  assert.match(ui, /function renderCleanupPlanPreview/);
  assert.match(ui, /planSummary\.groups/);
  assert.match(ui, /planSummary\.componentCandidates/);
  assert.match(ui, /planSummary\.warnings/);
});

test("cleanup approval is enabled only for a validated resumable plan", () => {
  assert.match(ui, /run\.status === "completed"/);
  assert.match(ui, /run\.planReady === true/);
  assert.match(ui, /run\.sessionAvailable === true/);
  assert.match(ui, /JSON\.stringify\(\{ approval: true \}\)/);
  assert.match(ui, /确认并执行整理/);
  assert.match(ui, /JSON\.stringify\(\{ text: text \}\)/);
});

test("updated plugin UI script remains syntactically valid", () => {
  const script = ui.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
  assert.ok(script.length > 0);
  assert.doesNotThrow(() => new Function(script));
});
