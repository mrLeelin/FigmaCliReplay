import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const ui = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");

test("cleanup requests one compact snapshot and posts it to the dedicated controller", () => {
  assert.match(ui, /type: "QUERY_CLEANUP_SNAPSHOT"/);
  assert.match(ui, /QUERY_CLEANUP_SNAPSHOT_RESULT/);
  assert.match(ui, /function handleCleanupSnapshotResult/);
  assert.match(ui, /snapshot: selection[\s\S]{0,120}sessionId: relaySessionId[\s\S]{0,120}providerId:/);
  assert.match(ui, /\/cleanup\/runs/);
  const requestStart = ui.indexOf("function requestCleanupSnapshot()");
  const requestEnd = ui.indexOf("function handleCleanupSnapshotResult", requestStart);
  assert.match(ui.slice(requestStart, requestEnd), /setTimeout/);
});

test("cleanup action falls back to the visually selected template card", () => {
  assert.match(ui, /function currentAiPromptTemplate\(\)/);
  assert.match(ui, /\.template-card\.selected/);
  assert.match(ui, /return selectedValue \|\| "cleanup"/);
  const requestStart = ui.indexOf("function requestAiRun()");
  const requestEnd = ui.indexOf("function requestCleanupSnapshot", requestStart);
  assert.match(ui.slice(requestStart, requestEnd), /var requestedTemplate = currentAiPromptTemplate\(\)/);
});

test("execution UI renders structured cleanup phases and plan preview", () => {
  assert.match(ui, /id="aiCleanupPlanPreview"/);
  assert.match(ui, /id="cleanupRunPlanPreview"/);
  for (const state of ["capturing", "planning", "validating", "review", "applying", "verifying", "rolled_back", "recovery_required"]) {
    assert.match(ui, new RegExp(`state === "${state}"`));
  }
  assert.match(ui, /function renderCleanupPlanPreview/);
  assert.match(ui, /planSummary\.operations/);
  assert.match(ui, /operation\.type/);
  assert.match(ui, /planSummary\.warnings/);
  assert.doesNotMatch(ui, /planSummary\.componentCandidates/);
});

test("cleanup is presented as one AI choice instead of planner and executor controls", () => {
  assert.match(ui, /<label for="cleanupProviderSelect">AI<\/label>/);
  assert.match(ui, /<select id="aiRunnerSelect" hidden>/);
  assert.doesNotMatch(ui, />执行器<\/label>/);
  assert.doesNotMatch(ui, /整理规划 AI/);
  assert.doesNotMatch(ui, /本机 AI 执行器/);
  assert.match(ui, /当前 AI：/);
  assert.match(ui, /id="aiPromptManualActions"/);
  assert.match(ui, /id="aiPromptSubAgentRow"/);
  assert.match(ui, /id="aiPromptPreviewField"/);
  assert.match(ui, /aiPromptManualActions\.style\.display = template === "cleanup" \? "none" : ""/);
  assert.match(ui, /aiPromptSubAgentRow\.style\.display = template === "cleanup" \? "none" : ""/);
  assert.match(ui, /aiPromptPreviewField\.style\.display = template === "cleanup" \? "none" : ""/);
});

test("cleanup stays on the prompt page and uses one review progress dialog", () => {
  for (const id of ["cleanupRunDialog", "cleanupRunDialogStatus", "cleanupRunPlanPreview", "confirmCleanupRunBtn", "cancelCleanupRunBtn", "closeCleanupRunBtn"]) {
    assert.match(ui, new RegExp(`id="${id}"`));
  }
  assert.match(ui, /function openCleanupRunDialog\(\)/);
  assert.match(ui, /function renderCleanupRunDialog\(run\)/);
  assert.match(ui, /if \(isCleanup\) openCleanupRunDialog\(\);\s*else switchTab\("ai-execution-tab"\);/);
  const reopenStart = ui.indexOf("function requestAiRun()");
  const reopenEnd = ui.indexOf("function requestCleanupSnapshot", reopenStart);
  assert.match(ui.slice(reopenStart, reopenEnd), /openCleanupRunDialog\(\)/);
  assert.doesNotMatch(ui, /整理计划已通过校验，请在“AI 执行”页/);
  assert.doesNotMatch(ui, /AI 整理正在执行；详情见“AI 执行”页/);
});

test("cleanup approval is enabled only for a validated review plan and no CLI session", () => {
  assert.match(ui, /run\.state === "review"/);
  assert.match(ui, /run\.planReady === true/);
  const controlsStart = ui.indexOf("function refreshAiExecutionControls()");
  const controlsEnd = ui.indexOf("function formatAiExecutionDuration", controlsStart);
  assert.doesNotMatch(ui.slice(controlsStart, controlsEnd), /cleanupApprovalReady[\s\S]{0,200}sessionAvailable/);
  assert.match(ui, /JSON\.stringify\(\{ approval: true, snapshotHash: run\.snapshotHash \}\)/);
  assert.match(ui, /确认并执行整理/);
  assert.match(ui, /JSON\.stringify\(\{ text: text \}\)/);
});

test("terminal cleanup unlocks restart while transient poll failures keep the same run", () => {
  assert.match(ui, /function invalidateTerminalCleanupRun/);
  assert.match(ui, /aiExecutionContinueBtn\.hidden = cleanupTerminal/);
  assert.match(ui, /closeCleanupRunBtn\.hidden = !terminal/);
  assert.match(ui, /可以关闭本窗口后重新开始/);
  assert.match(ui, /aiCleanupBusy = false/);
  const pollStart = ui.indexOf("function pollAiCleanupRun()");
  const pollEnd = ui.indexOf("async function continueAiCleanup", pollStart);
  assert.doesNotMatch(ui.slice(pollStart, pollEnd), /pollFailures < 4/);
  assert.doesNotMatch(ui.slice(pollStart, pollEnd), /aiCleanupBusy = false[\s\S]{0,160}pollFailures/);
  assert.match(ui.slice(pollStart, pollEnd), /scheduleAiCleanupPoll/);
});

test("updated plugin UI script remains syntactically valid", () => {
  const script = ui.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
  assert.ok(script.length > 0);
  assert.doesNotThrow(() => new Function(script));
});
