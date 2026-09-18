import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const ui = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");

function aiPromptTemplates() {
  const start = ui.indexOf("const AiPromptTemplates = {");
  const end = ui.indexOf("// END_AI_PROMPT_TEMPLATES", start);
  const source = ui.slice(start, ui.lastIndexOf(";", end) + 1);
  return Function(`${source}; return AiPromptTemplates;`)();
}

test("Unity import prompt directly names the project skill and its standard entry points", () => {
  const unityPrompt = aiPromptTemplates().unity;

  assert.match(unityPrompt, /\$figma-to-prefab/);
  assert.match(unityPrompt, /ai\/skills\/figma-to-prefab\/SKILL\.md/);
  assert.match(unityPrompt, /figma_to_prefab_cli\.py/);
  assert.match(unityPrompt, /Skill\(\)/);
  assert.doesNotMatch(unityPrompt, /`Skill`、`ToolSearch`、`Glob`、`Grep`、`Read`/);
});

test("cleanup opens a local AI conversation from the selected target", () => {
  const start = ui.indexOf("function startAiRun");
  const end = ui.indexOf("function scheduleAiCleanupPoll", start);
  const startAiRun = ui.slice(start, end);
  const requestStart = ui.indexOf("function requestAiRun()");
  const requestEnd = ui.indexOf("function requestCleanupSnapshot", requestStart);
  const request = ui.slice(requestStart, requestEnd);

  assert.match(startAiRun, /postIdempotentAiStartWithRetry\(payload, startOperation\)/);
  assert.match(startAiRun, /cleanupSnapshot: template === "cleanup" \? selection : undefined/);
  assert.match(startAiRun, /runner: template === "cleanup" \? runnerIdForCleanupProvider\(cleanupProviderId\)/);
  assert.match(startAiRun, /clientRequestId:/);
  assert.match(startAiRun, /postIdempotentAiStartWithRetry\(payload, startOperation\)/);
  assert.doesNotMatch(startAiRun, /autoApprove: true/);
  assert.match(request, /pendingAutoAiTemplate = requestedTemplate/);
  assert.match(request, /if \(requestedTemplate === "cleanup"\) \{[\s\S]*requestCleanupSnapshot\(\);[\s\S]*return;/);
});

test("cleanup start waits for WebSocket registration and retries the same idempotent request", () => {
  const retryStart = ui.indexOf("async function postIdempotentAiStartWithRetry(");
  const retryEnd = ui.indexOf("function startAiRun", retryStart);
  const retry = ui.slice(retryStart, retryEnd);

  assert.ok(retryStart >= 0 && retryEnd > retryStart);
  assert.match(retry, /requestAiControlWithRetry\("ai\.run\.start", payload, "", operation, payload.template === "cleanup"\)/);
  assert.doesNotMatch(retry, /fetchWithTimeout/);
});

test("registered WebSocket sessions are the primary AI control path", () => {
  const gateway = fs.readFileSync(new URL("../src/websocketGateway.ts", import.meta.url), "utf8");
  const index = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const start = ui.slice(ui.indexOf("async function postIdempotentAiStartWithRetry("), ui.indexOf("function startAiRun"));
  const poll = ui.slice(ui.indexOf("function pollAiCleanupRun()"), ui.indexOf("async function continueAiCleanup"));
  const followup = ui.slice(ui.indexOf("async function postIdempotentAiFollowupWithRetry("), ui.indexOf("async function continueAiCleanup"));
  const stop = ui.slice(ui.indexOf("async function stopActiveAiCleanup()"), ui.indexOf("function stopAiCleanupOnPanelClose"));

  assert.match(ui, /function sendRelaySocketRequest\(/);
  assert.match(ui, /message\.type === "relay\.response"/);
  assert.match(start, /requestAiControlWithRetry\("ai\.run\.start"/);
  assert.match(poll, /ai\.run\.subscribe/);
  assert.match(followup, /requestAiControlWithRetry\("ai\.run\.followup"/);
  assert.match(stop, /requestAiControlWithRetry\(isCleanup \? "cleanup\.run\.cancel" : "ai\.run\.stop"/);
  assert.match(gateway, /type === "relay\.request"/);
  assert.match(gateway, /relay\.response/);
  assert.match(gateway, /onClientRequest/);
  assert.match(index, /gateway\.onClientRequest/);
  assert.match(index, /createRelayControlHandler/);
});

test("cleanup polling uses the resumable AI-run view while retaining V2 compatibility only when present", () => {
  assert.match(ui, /function applyCleanupRunView\(run, result\)/);
  const pollStart = ui.indexOf("function pollAiCleanupRun()");
  const pollEnd = ui.indexOf("async function continueAiCleanup", pollStart);
  const poll = ui.slice(pollStart, pollEnd);
  assert.match(poll, /isTransactionCleanupRun\(currentRun\)/);
  assert.match(poll, /ai\.run\.subscribe/);
  assert.match(poll, /Object\.assign\(currentRun, \{/);
  assert.match(poll, /cleanup\.run\.subscribe/);
  assert.match(poll, /applyCleanupRunView\(currentRun, result\)/);
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

test("stale websocket callbacks and late Figma results cannot clear newer execution state", () => {
  const socketStart = ui.indexOf("function connectRelaySocket()");
  const socketEnd = ui.indexOf("function processRelaySocketQueue()", socketStart);
  const socket = ui.slice(socketStart, socketEnd);
  assert.match(socket, /socket = new WebSocket/);
  assert.match(socket, /if \(relaySocket !== socket\) return/);

  const resultStart = ui.indexOf('// 本地 Relay 的 _RESULT 回传');
  const resultEnd = ui.indexOf('// Unity 图片导出结果', resultStart);
  const resultHandler = ui.slice(resultStart, resultEnd);
  assert.match(resultHandler, /message\.requestId !== executingRequestId/);
  assert.match(resultHandler, /忽略晚到状态覆盖/);
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

test("execution UI makes cleanup a resumable chat without a second modal", () => {
  assert.match(ui, /function isTransactionCleanupRun\(run\)/);
  assert.match(ui, /run && run\.template === "cleanup" \? "发送消息"/);
  assert.match(ui, /AI 整理对话本回合已完成/);
  assert.doesNotMatch(ui, /id="cleanupRunDialog"/);
  assert.doesNotMatch(ui, /function openCleanupRunDialog\(/);
  assert.doesNotMatch(ui, /确认并执行整理/);
});

test("cleanup keeps the generated prompt preview and cleanup action buttons visible", () => {
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
  assert.match(controls, /aiPromptPreviewField\.style\.display = ""/);
  assert.doesNotMatch(controls, /aiPromptPreviewField\.style\.display = template === "cleanup" \? "none" : ""/);
  assert.match(ui, /\$figma-hierarchy-cleanup/);
});

test("manual prompt actions can continue with the currently selected AI in a terminal", () => {
  const controlsStart = ui.indexOf("function refreshAiPromptControls()");
  const controlsEnd = ui.indexOf("function readCurrentFigmaKey", controlsStart);
  const controls = ui.slice(controlsStart, controlsEnd);
  const terminalStart = ui.indexOf("async function postAiTerminalWithLiveSessionRetry(");
  const terminalEnd = ui.indexOf("function requestAiRun()", terminalStart);
  const terminal = ui.slice(terminalStart, terminalEnd);

  assert.match(ui, /id="openAiTerminalBtn"/);
  assert.match(ui, /openAiTerminalBtn\.addEventListener\("click", openAiTerminal\)/);
  assert.match(controls, /openAiTerminalBtn\.disabled = generatingAiPrompt \|\| aiCleanupBusy \|\| aiTerminalLaunching \|\| !aiPromptPreviewEl\.value\.trim\(\)/);
  assert.match(ui, /function runnerForCurrentAiPromptTemplate\(template\)/);
  assert.match(terminal, /"ai\.open-terminal"/);
  assert.match(terminal, /runnerForCurrentAiPromptTemplate\(template\)/);
  assert.match(terminal, /uiLogger\.startOperation\("ai\.terminal"/);
  assert.match(terminal, /任务文件：/);
});

test("cleanup enters the AI execution page and records a read-only conversation start", () => {
  assert.doesNotMatch(ui, /autoApprove:\s*true/);
  assert.match(ui, /writeAuthorised: false/);
  assert.match(ui, /AI 整理对话已启动；首轮只会读取和分析/);
  assert.match(ui, /switchTab\("ai-execution-tab"\);/);
  const reopenStart = ui.indexOf("function requestAiRun()");
  const reopenEnd = ui.indexOf("function requestCleanupSnapshot", reopenStart);
  assert.match(ui.slice(reopenStart, reopenEnd), /switchTab\("ai-execution-tab"\)/);
  assert.doesNotMatch(ui.slice(reopenStart, reopenEnd), /openCleanupRunDialog\(/);
});

test("cleanup sends confirmation and adjustment messages through the same AI session", () => {
  assert.match(ui, /ai\.cleanup-conversation-followup/);
  const continueStart = ui.indexOf("async function continueAiCleanup()");
  const continueEnd = ui.indexOf("async function stopActiveAiCleanup", continueStart);
  assert.match(ui.slice(continueStart, continueEnd), /run\.status !== "completed" && run\.status !== "failed"/);
  const controlsStart = ui.indexOf("function refreshAiExecutionControls()");
  const controlsEnd = ui.indexOf("function formatAiExecutionDuration", controlsStart);
  assert.doesNotMatch(ui.slice(controlsStart, controlsEnd), /cleanupApprovalReady/);
  assert.doesNotMatch(ui, /JSON\.stringify\(\{ approval: true, snapshotHash: run\.snapshotHash \}\)/);
  assert.match(ui, /postIdempotentAiFollowupWithRetry\(run, text, followupRequestId/);
  assert.match(ui, /clientRequestId: followupRequestId/);
});

test("AI follow-up retries reuse one request id so a lost response cannot execute a turn twice", () => {
  const helperStart = ui.indexOf("async function postIdempotentAiFollowupWithRetry(");
  const helperEnd = ui.indexOf("async function continueAiCleanup()", helperStart);
  const helper = ui.slice(helperStart, helperEnd);

  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  assert.match(helper, /clientRequestId/);
  assert.match(helper, /requestAiControlWithRetry\("ai\.run\.followup"/);
  assert.match(helper, /operation, true\)/);
});

test("cleanup adjustment follow-ups capture and send a fresh hierarchy snapshot", () => {
  const ui = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");

  assert.match(ui, /cleanupFollowupNeedsFreshSnapshot/);
  assert.match(ui, /captureCleanupSnapshotForFollowup/);
  assert.match(ui, /cleanupSnapshot:\s*cleanupSnapshot/);
  assert.match(ui, /followup-snapshot-request/);
  assert.match(ui, /rootNodeId:\s*run\.cleanupSnapshotRootNodeId/);
  assert.match(ui, /cleanupSnapshotRootNodeId:\s*result\.rootNodeId/);
});

test("AI follow-up falls back only for WebSocket transport failures", () => {
  const helperStart = ui.indexOf("async function postIdempotentAiFollowupWithRetry(");
  const helperEnd = ui.indexOf("async function continueAiCleanup()", helperStart);
  const helper = ui.slice(helperStart, helperEnd);
  const socketStart = ui.indexOf("function rejectRelaySocketRequests(");
  const socketEnd = ui.indexOf("function registerRelaySocket()", socketStart);
  const socket = ui.slice(socketStart, socketEnd);

  assert.match(ui, /error\.relayTransportFailure !== true/);
  assert.match(socket, /error\.relayTransportFailure = false/);
  assert.match(socket, /transportError\.relayTransportFailure = true/);
  assert.match(socket, /unavailableError\.relayTransportFailure = true/);
  assert.match(socket, /timeoutError\.relayTransportFailure = true/);
  assert.match(socket, /sendError\.relayTransportFailure = true/);
});

test("AI polling uses bounded backoff and aggregates repeated transport failures", () => {
  const scheduleStart = ui.indexOf("function scheduleAiCleanupPoll(");
  const scheduleEnd = ui.indexOf("function applyCleanupRunView", scheduleStart);
  const schedule = ui.slice(scheduleStart, scheduleEnd);
  const pollStart = ui.indexOf("function pollAiCleanupRun()");
  const pollEnd = ui.indexOf("async function recordCleanupSatisfaction", pollStart);
  const poll = ui.slice(pollStart, pollEnd);

  assert.match(schedule, /delayMs/);
  assert.match(schedule, /activeAiCleanupRun\.subscriptionId/);
  assert.doesNotMatch(schedule, /\|\| 4000/);
  assert.doesNotMatch(schedule, /setTimeout\(pollAiCleanupRun, 700\)/);
  assert.match(ui, /function aiCleanupPollRetryDelayMs\(failures\)/);
  assert.match(ui, /function shouldLogAiPollFailure\(failures\)/);
  assert.match(poll, /scheduleAiCleanupPoll\(aiCleanupPollRetryDelayMs\(currentRun\.pollFailures\)\)/);
  assert.match(poll, /if \(shouldLogAiPollFailure\(currentRun\.pollFailures\)\)/);
});

test("Figma execution uses WebSocket without polling or HTTP result fallback", () => {
  assert.doesNotMatch(ui, /function pollOnce|scheduleNextPoll|relayFallbackPollDelayMs/);
  assert.doesNotMatch(ui, /\/figma\/pending|\/figma\/result/);
  assert.match(ui, /scheduleRelaySocketReconnect\("socket-closed"\)/);
});

test("background-throttled Figma panels receive a two-minute WebSocket heartbeat lease", () => {
  const gateway = fs.readFileSync(new URL("../src/websocketGateway.ts", import.meta.url), "utf8");

  assert.match(gateway, /HEARTBEAT_TIMEOUT_MS\s*=\s*120_000/);
  assert.match(gateway, /missed heartbeat as a transport reconnect/);
});

test("provider list refresh does not rewrite the selected AI runner", () => {
  const refreshStart = ui.indexOf("async function refreshCleanupProviders()");
  const refreshEnd = ui.indexOf("function runnerIdForCleanupProvider", refreshStart);
  const refresh = ui.slice(refreshStart, refreshEnd);

  assert.doesNotMatch(refresh, /syncAiRunnerToCleanupProvider\(\)/);
});

test("AI runner selection is pinned per request while the explicit config endpoint remains guarded", () => {
  const syncStart = ui.indexOf("function syncAiRunnerToCleanupProvider()");
  const syncEnd = ui.indexOf("function selectCleanupProvider()", syncStart);
  const sync = ui.slice(syncStart, syncEnd);
  const writeStart = ui.indexOf("async function writeAiRunnerConfigWithLiveSessionRetry(");
  const writeEnd = ui.indexOf("async function selectAiRunner(", writeStart);
  const write = ui.slice(writeStart, writeEnd);
  const selectStart = ui.indexOf("async function selectAiRunner(");
  const selectEnd = ui.indexOf("function startAiRun", selectStart);
  const select = ui.slice(selectStart, selectEnd);

  assert.doesNotMatch(ui, /function waitForLiveRelayPluginSession\(/);
  assert.doesNotMatch(sync, /\/health|selectAiRunner|\/ai-runner\/config/);
  assert.match(sync, /targetRunner = runnerIdForCleanupProvider\(providerId\)/);
  assert.match(sync, /aiRunnerSelect\.value = targetRunner/);
  assert.match(sync, /requestPinning: true/);
  assert.match(write, /ai\.config/);
  assert.match(write, /sessionId: relaySessionId/);
  assert.match(write, /error\.relayTransportFailure !== true/);
  assert.match(write, /await waitForRelaySocketRegistration\(/);
  assert.match(write, /websocket-retry/);
  assert.doesNotMatch(write, /\/health/);
  assert.match(select, /await writeAiRunnerConfigWithLiveSessionRetry\(payload, operation\)/);
  assert.match(select, /return true;/);
  assert.match(select, /return false;/);
  assert.match(ui, /uiLogger\.startOperation\("ai\.runner-sync"/);
});

test("Relay registration acknowledgement gates HTTP requests that require a live plugin session", () => {
  const waitStart = ui.indexOf("function waitForRelaySocketRegistration(");
  const waitEnd = ui.indexOf("function connectRelaySocket()", waitStart);
  const wait = ui.slice(waitStart, waitEnd);
  const socketStart = ui.indexOf("function connectRelaySocket()");
  const socketEnd = ui.indexOf("function processRelaySocketQueue()", socketStart);
  const socket = ui.slice(socketStart, socketEnd);

  assert.ok(waitStart >= 0 && waitEnd > waitStart);
  assert.match(wait, /relaySocketRegistered/);
  assert.match(wait, /setTimeout/);
  assert.match(socket, /message\.type === "plugin\.registered"/);
  assert.match(socket, /relaySocketRegistered = true/);
  assert.match(socket, /relaySocketRegistered = false/);
});

test("cleanup prompt rendering does not reintroduce a health probe or one-step variant authorization", () => {
  const readStart = ui.indexOf("function readAiPromptTemplate(template)");
  const readEnd = ui.indexOf("function formatFileSize", readStart);
  const read = ui.slice(readStart, readEnd);
  const buildStart = ui.indexOf("function buildAiPrompt(template, selectionInfo)");
  const buildEnd = ui.indexOf("function getAiPromptFigmaKey", buildStart);
  const build = ui.slice(buildStart, buildEnd);
  assert.doesNotMatch(read, /figma-hierarchy-cleanup[^\n]*\/health/);
  assert.doesNotMatch(build, /单次确认执行规则/);
  assert.doesNotMatch(build, /授权同时覆盖[\s\S]*ComponentSet/);
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

test("permanent AI run polling failures stop instead of retrying indefinitely", () => {
  const pollStart = ui.indexOf("function pollAiCleanupRun()");
  const pollEnd = ui.indexOf("async function recordCleanupSatisfaction", pollStart);
  const poll = ui.slice(pollStart, pollEnd);
  const terminalStart = ui.indexOf("function isTerminalAiRunPollError(error)");
  const terminalEnd = ui.indexOf("function pollAiCleanupRun()", terminalStart);
  const terminal = ui.slice(terminalStart, terminalEnd);

  assert.match(terminal, /status === 403/);
  assert.match(terminal, /unknown run or invalid capability/i);
  assert.match(poll, /handleAiRunError\(currentRun, error\)/);
  assert.match(poll, /if \(isTerminalAiRunPollError\(error\)\) \{[\s\S]*?clearAiCleanupPollTimer\(\);[\s\S]*?activeAiCleanupRun = null;[\s\S]*?return;/);
});

test("updated plugin UI script remains syntactically valid", () => {
  const script = ui.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
  assert.ok(script.length > 0);
  assert.doesNotThrow(() => new Function(script));
});
