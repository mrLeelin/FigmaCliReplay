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

test("the plugin exposes three prompt functions and sends no AI execution requests", () => {
  const tools = ui.slice(ui.indexOf('id="tools-tab">'), ui.indexOf('id="ai-prompt-tab">'));
  const prompts = ui.slice(ui.indexOf('id="ai-prompt-tab">'), ui.indexOf('id="export-tab">'));
  const buttons = [...prompts.matchAll(/<button\b[^>]*\bdata-prompt="(\w+)"[^>]*>/g)];
  assert.deepEqual(buttons.filter(([tag]) => !/\bhidden\b/.test(tag)).map(([, value]) => value),
    ["cleanup", "imageDecompose", "htmlMotion"]);
  assert.deepEqual(buttons.filter(([tag]) => /\bhidden\b/.test(tag)).map(([, value]) => value),
    ["componentVariants", "unity"]);
  assert.match(tools, /data-tools-tab="nine-slice-tab"/);
  assert.match(tools, /data-tools-tab="merge-image-layers-tab"/);
  assert.match(tools, /id="aiCleanupRecoveryActions"/);
  assert.doesNotMatch(tools, /image-decompose-tab|html-motion-tab/);
  assert.doesNotMatch(ui, /ai-execution-tab|ai\.run\.|cleanup\.run\.|ai\.open-terminal|GET_CLEANUP_PROVIDER_PREFERENCE/);
});

test("the copied cleanup template gives the external AI the standalone workflow and confirmation boundary", () => {
  const cleanup = aiPromptTemplates().cleanup;
  assert.match(cleanup, /\{\{cleanupSkillPath\}\}/);
  assert.match(ui, /cleanupSkillPath:[\s\S]{0,200}ai\/skills\/figma-hierarchy-cleanup\/SKILL\.md/);
  assert.match(cleanup, /\{\{selectionBlock\}\}/);
  assert.match(cleanup, /analyze → plan → apply/);
  assert.match(cleanup, /明确确认.*CLI.*写入/);
  assert.match(cleanup, /组件变体需另行确认/);
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

test("updated plugin UI script remains syntactically valid", () => {
  const script = ui.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
  assert.ok(script.length > 0);
  assert.doesNotThrow(() => new Function(script));
});
