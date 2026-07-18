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

test("cleanup polling consumes the V2 cleanup-run view rather than legacy AI-run fields", () => {
  assert.match(ui, /function applyCleanupRunView\(run, result\)/);
  const pollStart = ui.indexOf("function pollAiCleanupRun()");
  const pollEnd = ui.indexOf("async function continueAiCleanup", pollStart);
  const poll = ui.slice(pollStart, pollEnd);
  assert.match(poll, /\/cleanup\/runs\//);
  assert.match(poll, /applyCleanupRunView\(currentRun, result\)/);
  assert.doesNotMatch(poll, /currentRun\.status = result\.status/);
  assert.doesNotMatch(ui, /\/ai-runner\/run-cleanup/);
});

test("relay cleanup snapshot jobs return their result instead of entering the manual cleanup flow", () => {
  const handlerStart = ui.indexOf("function handleCleanupSnapshotResult(message)");
  const handlerEnd = ui.indexOf("//", handlerStart);
  const handler = ui.slice(handlerStart, handlerEnd);
  assert.match(handler, /message\.requestId === executingRequestId && executingJobType === "QUERY_CLEANUP_SNAPSHOT"/);
  assert.match(handler, /postResult\(message\.requestId, result\)/);
  assert.match(handler, /processRelaySocketQueue\(\)/);
});

test("websocket jobs remain executing until the Figma main-thread result arrives", () => {
  assert.doesNotMatch(
    ui,
    /executeJob\(payload\)[\s\S]*?\.then\(function \(\) \{\s*clearExecutionWatchdog\(\);\s*isExecuting = false;/,
  );
  assert.match(
    ui,
    /message\.type && message\.type\.endsWith\("_RESULT"\)[\s\S]*?isExecuting = false;\s*clearExecutionWatchdog\(\);/,
  );
});

test("relay watchdog closes the logged operation and clears the timed-out execution identity", () => {
  const watchdogStart = ui.indexOf("function startExecutionWatchdog(");
  const watchdogEnd = ui.indexOf("async function postResult", watchdogStart);
  const watchdog = ui.slice(watchdogStart, watchdogEnd);
  assert.match(watchdog, /finishUiRelayOperation\(requestId, result\)/);
  assert.match(watchdog, /executingRequestId = ""/);
  assert.match(watchdog, /executingJobType = ""/);
});

test("cleanup action falls back to the visually selected template card", () => {
  assert.match(ui, /function currentAiPromptTemplate\(\)/);
  assert.match(ui, /\.template-card\.selected/);
  assert.match(ui, /return selectedValue \|\| "cleanup"/);
  const requestStart = ui.indexOf("function requestAiRun()");
  const requestEnd = ui.indexOf("function requestCleanupSnapshot", requestStart);
  assert.match(ui.slice(requestStart, requestEnd), /var requestedTemplate = currentAiPromptTemplate\(\)/);
});

test("execution UI renders structured cleanup phases without a second approval dialog", () => {
  assert.match(ui, /id="aiCleanupSatisfaction"/);
  for (const state of ["capturing", "planning", "validating", "review", "applying", "verifying", "awaiting_component_confirmation", "rolled_back", "recovery_required"]) {
    assert.match(ui, new RegExp(`state === "${state}"`));
  }
  assert.match(ui, /confirm-component-sets/);
  assert.match(ui, /awaiting_component_confirmation/);
  assert.doesNotMatch(ui, /id="cleanupRunDialog"/);
  assert.doesNotMatch(ui, /function openCleanupRunDialog\(/);
  assert.doesNotMatch(ui, /确认并执行整理/);
});

test("cleanup keeps both AI prompt and cleanup action buttons visible", () => {
  assert.match(ui, /<label for="cleanupProviderSelect">AI<\/label>/);
  assert.match(ui, /<select id="aiRunnerSelect" hidden>/);
  assert.doesNotMatch(ui, />执行器<\/label>/);
  assert.doesNotMatch(ui, /整理规划 AI/);
  assert.doesNotMatch(ui, /本机 AI 执行器/);
  assert.match(ui, /当前 AI：/);
  assert.match(ui, /id="aiPromptManualActions"/);
  assert.match(ui, /id="aiPromptSubAgentRow"/);
  assert.match(ui, /id="aiPromptPreviewField"/);
  const controlsStart = ui.indexOf("function refreshAiPromptControls()");
  const controlsEnd = ui.indexOf("function readCurrentFigmaKey", controlsStart);
  const controls = ui.slice(controlsStart, controlsEnd);
  assert.doesNotMatch(controls, /aiPromptManualActions\.style\.display = template === "cleanup" \? "none" : ""/);
  assert.match(controls, /aiPromptManualActions\.style\.display = ""/);
  assert.match(ui, /aiPromptSubAgentRow\.style\.display = template === "cleanup" \? "none" : ""/);
  assert.match(ui, /aiPromptPreviewField\.style\.display = template === "cleanup" \? "none" : ""/);
});

test("cleanup enters the AI execution page and records direct authorization", () => {
  assert.match(ui, /autoApprove:\s*true/);
  assert.match(ui, /switchTab\("ai-execution-tab"\);/);
  const reopenStart = ui.indexOf("function requestAiRun()");
  const reopenEnd = ui.indexOf("function requestCleanupSnapshot", reopenStart);
  assert.match(ui.slice(reopenStart, reopenEnd), /switchTab\("ai-execution-tab"\)/);
  assert.doesNotMatch(ui.slice(reopenStart, reopenEnd), /openCleanupRunDialog\(/);
});

test("cleanup does not expose a second approval action", () => {
  assert.match(ui, /state === "review"/);
  const controlsStart = ui.indexOf("function refreshAiExecutionControls()");
  const controlsEnd = ui.indexOf("function formatAiExecutionDuration", controlsStart);
  assert.doesNotMatch(ui.slice(controlsStart, controlsEnd), /cleanupApprovalReady/);
  assert.doesNotMatch(ui, /JSON\.stringify\(\{ approval: true, snapshotHash: run\.snapshotHash \}\)/);
  assert.match(ui, /JSON\.stringify\(\{ text: text \}\)/);
});

test("terminal cleanup unlocks restart while transient poll failures keep the same run", () => {
  assert.match(ui, /function invalidateTerminalCleanupRun/);
  assert.match(ui, /aiCleanupSatisfaction\.hidden = !cleanupAwaitingConfirmation/);
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
