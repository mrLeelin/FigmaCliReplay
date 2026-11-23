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
