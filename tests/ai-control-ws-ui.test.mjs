import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const ui = fs.readFileSync(new URL('../ui.html', import.meta.url), 'utf8');

test('Unity project management uses WS and refreshes after registration', () => {
  for (const name of ['refreshUnityProjects', 'addUnityProject', 'selectUnityProject', 'removeUnityProject', 'installSelectedUnityBridge', 'readSelectedUnityGatewayConfig']) {
    assert.doesNotMatch(source(name), /fetchWithTimeout|fetch\(/, name);
    assert.match(source(name), /sendRelaySocketRequest/, name);
  }
  assert.match(source('connectRelaySocket'), /relaySocketRegistered = true;\s*refreshUnityProjects\(\)/);
});

test('PSD uses WS and subscribes before immediate terminal events can complete the queue', async () => {
  for (const name of ['startPsdImportFromDroppedFile', 'pollPsdImportTaskStatus', 'adoptPsdIncrementalBaseline', 'confirmPsdIncrementalUpdate']) {
    assert.doesNotMatch(source(name), /fetchWithTimeout|fetch\(/, name);
  }
  assert.doesNotMatch(source('pollPsdImportTaskStatus'), /setTimeout|psd\.import\.start/);
  const start = source('startPsdImportFromDroppedFile');
  assert.ok(start.indexOf('var completion = waitForPsdImportTaskCompletion()') < start.indexOf('pollPsdImportTaskStatus()'));
  const rendered = [];
  const completed = [];
  const context = vm.createContext({
    psdImportTaskId: 'psd-task', psdImportSubscriptionId: '', psdImportBusy: true,
    PSD_PREVIEW_TERMINAL_STATUSES: new Set(['preview-ready']),
    setAiPromptStatus() {}, appendLog() {}, clearPsdImportPollTimer() {},
    renderPsdImportTaskStatus: value => rendered.push(value),
    finishPsdImportTaskPromise: (...values) => completed.push(values),
    sendRelaySocketRequest: async (action, payload, token, timeout, id) => {
      assert.equal(action, 'psd.import.subscribe');
      assert.equal(context.psdImportSubscriptionId, id);
      context.handlePsdImportEvent({subscriptionId: 'stale', taskId: 'psd-task', result: {task: {status: 'completed'}}});
      context.handlePsdImportEvent({subscriptionId: id, taskId: 'other', result: {task: {status: 'completed'}}});
      assert.equal(rendered.length, 0);
      context.handlePsdImportEvent({subscriptionId: id, taskId: 'psd-task', result: {task: {status: 'completed'}}});
    },
  });
  vm.runInContext(source('pollPsdImportTaskStatus') + '\n' + source('handlePsdImportEvent'), context);
  await context.pollPsdImportTaskStatus();
  assert.equal(rendered.length, 1);
  assert.equal(completed.length, 1);
  assert.equal(context.psdImportBusy, false);
});

test('Prefab subscription filters stale identities and never resubmits an uncertain write', async () => {
  const applied = [];
  const finished = [];
  const context = vm.createContext({
    prefabImportTaskId: 'task', prefabImportSubscriptionId: '',
    setPrefabImportStatus() {}, appendLog() {},
    renderPrefabImportTaskStatus: value => applied.push(value),
    finishPrefabImport: value => finished.push(value),
    sendRelaySocketRequest: async (action, payload, token, timeout, id) => {
      assert.equal(action, 'prefab.import.subscribe');
      assert.equal(payload.taskId, 'task');
      assert.equal(context.prefabImportSubscriptionId, id);
      context.handlePrefabImportEvent({subscriptionId: id, taskId: 'task', result: {status: 'running'}});
      return {ok: true};
    },
  });
  vm.runInContext(source('subscribePrefabImportTask') + '\n' + source('handlePrefabImportEvent'), context);
  await context.subscribePrefabImportTask();
  assert.equal(applied.length, 1);
  const subscriptionId = context.prefabImportSubscriptionId;
  context.handlePrefabImportEvent({subscriptionId: 'stale', taskId: 'task', result: {status: 'completed'}});
  context.handlePrefabImportEvent({subscriptionId, taskId: 'other', result: {status: 'completed'}});
  context.handlePrefabImportEvent({subscriptionId, taskId: 'task', error: 'unknown'});
  assert.equal(applied.length, 1);
  assert.equal(finished.length, 0);
  context.handlePrefabImportEvent({subscriptionId, taskId: 'task', result: {status: 'completed'}});
  assert.deepEqual(finished, [true]);
  assert.doesNotMatch(source('startPrefabImportToFigma'), /fetch\(|fetchWithTimeout\(/);
  assert.doesNotMatch(source('subscribePrefabImportTask'), /setTimeout|fetch|prefab\.import\.start/);
});

function source(name) {
  const start = ui.search(new RegExp('    (?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name);
  const rest = ui.slice(start + 4);
  const end = rest.slice(1).search(/\n    (?:async )?function /);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

test('AI controls never fall back to HTTP', () => {
  for (const name of ['refreshCleanupProviders', 'refreshAiRunner', 'writeAiRunnerConfigWithLiveSessionRetry', 'postIdempotentAiStartWithRetry', 'postAiTerminalWithLiveSessionRetry', 'postIdempotentAiFollowupWithRetry', 'confirmCleanupComponentSetsWithSocketFallback', 'stopActiveAiCleanup', 'stopAiCleanupOnPanelClose']) {
    assert.doesNotMatch(source(name), /fetch\(|fetchWithTimeout\(/, name);
  }
});

test('idempotent AI requests retry only transport failures with the same payload', async () => {
  const calls = [];
  const context = vm.createContext({
    waitForRelaySocketRegistration: async () => true,
    sendRelaySocketRequest: async (...args) => {
      calls.push(args);
      if (calls.length === 1) throw Object.assign(new Error('lost'), {relayTransportFailure: true});
      return {ok: true, runId: 'run'};
    },
    setTimeout: fn => fn(),
  });
  vm.runInContext(source('requestAiControlWithRetry'), context);
  const payload = {clientRequestId: 'stable'};
  await context.requestAiControlWithRetry('ai.run.start', payload, '', {step() {}}, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1], payload);
  assert.equal(calls[1][1], payload);
  calls.length = 0;
  context.sendRelaySocketRequest = async () => { calls.push(1); throw Object.assign(new Error('denied'), {relayTransportFailure: false}); };
  await assert.rejects(context.requestAiControlWithRetry('ai.run.start', payload, '', {step() {}}, true), /denied/);
  assert.equal(calls.length, 1);
});

test('AI run progress resumes via subscription without recurring status requests', () => {
  assert.match(source('pollAiCleanupRun'), /run\.subscribe/);
  assert.doesNotMatch(source('pollAiCleanupRun'), /run\.get|fetchWithTimeout/);
  assert.match(source('handleAiRunEvent'), /message\.runId/);
  assert.match(source('handleAiRunEvent'), /message\.subscriptionId/);
  assert.match(source('connectRelaySocket'), /relay\.event/);
  assert.match(source('connectRelaySocket'), /scheduleAiCleanupPoll\(\)/);
});

test('subscription identity is known before the first pushed event and stale events are ignored', async () => {
  const calls = [];
  const applied = [];
  const run = {runId: 'run', capabilityToken: 'cap', lastSequence: 12};
  const context = vm.createContext({
    activeAiCleanupRun: run, relaySocketRegistered: true,
    isTransactionCleanupRun: () => false,
    sendRelaySocketRequest: async (...args) => {calls.push(args); return {ok: true, subscriptionId: args[4]};},
    applyAiRunView: (...args) => applied.push(args),
    handleAiRunError: () => assert.fail('unexpected error'),
  });
  vm.runInContext(source('pollAiCleanupRun') + '\n' + source('handleAiRunEvent'), context);
  context.pollAiCleanupRun();
  context.pollAiCleanupRun();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'ai.run.subscribe');
  assert.equal(calls[0][1].afterSequence, 12);
  assert.equal(calls[0][4], run.subscriptionId);
  context.handleAiRunEvent({runId: 'run', subscriptionId: 'stale', result: {runId: 'run'}});
  context.handleAiRunEvent({runId: 'another', subscriptionId: run.subscriptionId, result: {runId: 'another'}});
  assert.equal(applied.length, 0);
  context.handleAiRunEvent({runId: 'run', subscriptionId: run.subscriptionId, result: {runId: 'run', status: 'running'}});
  assert.equal(applied.length, 1);
  run.subscriptionId = null;
  run.lastSequence = 22;
  context.pollAiCleanupRun();
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1].afterSequence, 22);
});

test('terminal launch never automatically retries an uncertain outcome', async () => {
  let calls = 0;
  const context = vm.createContext({
    waitForRelaySocketRegistration: async () => true,
    sendRelaySocketRequest: async () => {calls++; throw Object.assign(new Error('ack lost'), {relayTransportFailure: true});},
    setTimeout: fn => fn(),
  });
  vm.runInContext(source('requestAiControlWithRetry') + '\n' + source('postAiTerminalWithLiveSessionRetry'), context);
  await assert.rejects(context.postAiTerminalWithLiveSessionRetry({}, {step() {}}), /ack lost/);
  assert.equal(calls, 1);
});
