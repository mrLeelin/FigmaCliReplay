import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { parseArgs, PLUGIN_ROOT } from "../dist/config.js";
import { startPsdImportTask, getPsdImportTask, cancelPsdImportTask } from "../dist/psdImportTask.js";
import { RuntimeRelay } from "../dist/runtimeRelay.js";
import { createRelayControlHandler } from "../dist/relayControl.js";

test("PSD controls freeze targets, deduplicate submissions, and reject cross-session access", { timeout: 20000 }, async (t) => {
  const config = parseArgs([]);
  const id = 'psd-test-' + randomUUID();
  const directory = path.join(PLUGIN_ROOT, '.tmp', 'psd-to-figma', id);
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const relay = {config, status: () => ({plugin: {sessions: [
    {authenticated: true, sessionId: 'one', fileKey: 'file'},
    {authenticated: true, sessionId: 'two', fileKey: 'other'},
  ]}}), algorithmControl: RuntimeRelay.prototype.algorithmControl};
  const control = createRelayControlHandler(relay, {});
  const payload = {clientRequestId: id, fileName: 'invalid.psd', fileBase64: Buffer.alloc(32).toString('base64'), sessionId: 'one'};
  await assert.rejects(control('psd.import.start', {...payload, target: {fileKey: 'other'}}), /conflicts/);
  await assert.rejects(control('psd.import.start', {...payload, sessionId: undefined}), /exactly one/);
  const first = await control('psd.import.start', payload);
  assert.equal(first.task.taskId, id);
  assert.equal(first.task.target.sessionId, 'one');
  assert.equal(first.task.target.fileKey, 'file');
  const second = await control('psd.import.start', payload);
  assert.equal(second.task.taskId, id);
  await assert.rejects(control('psd.import.start', {...payload, fileName: 'changed.psd'}), /conflicts/);
  await assert.rejects(control('psd.import.get', {taskId: id, sessionId: 'two'}), /different Figma session/);
  first.task.target.sessionId = 'tampered';
  assert.equal(getPsdImportTask(id).target.sessionId, 'one');
  await assert.rejects(control('psd.import.apply', {taskId: id, sessionId: 'one', baselineFingerprint: 'wrong'}), /not ready/);
  const deadline = Date.now() + 15000;
  while (!['error', 'completed'].includes(getPsdImportTask(id).status)) {
    assert.ok(Date.now() < deadline, 'invalid PSD child must finish');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(getPsdImportTask(id).status, 'error');
  assert.equal((await control('psd.import.start', payload)).task.status, 'error');
  assert.equal((await control('psd.import.cancel', {taskId: id, sessionId: 'one'})).accepted, false);
  await assert.rejects(control('psd.import.cancel', {taskId: id, sessionId: 'two'}), /different Figma session/);
});

test('PSD cancellation waits for export exit and prevents Figma submission', {timeout: 20000}, async (t) => {
  const id = 'psd-cancel-' + randomUUID();
  const directory = path.join(PLUGIN_ROOT, '.tmp', 'psd-to-figma', id);
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  startPsdImportTask(parseArgs([]), {clientRequestId: id, fileName: 'cancel.psd',
    fileBase64: Buffer.alloc(32).toString('base64'), target: {sessionId: 'one', fileKey: 'file'}});
  const request = cancelPsdImportTask(id);
  assert.equal(request.accepted, true);
  assert.equal(request.task.status, 'cancel_requested');
  assert.equal(cancelPsdImportTask(id).task.status, 'cancel_requested');
  const deadline = Date.now() + 15000;
  while (getPsdImportTask(id).status === 'cancel_requested') {
    assert.ok(Date.now() < deadline, 'export child should exit');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const task = getPsdImportTask(id);
  assert.equal(task.status, 'cancelled');
  assert.ok(!task.logs.some(line => line.includes('55%')));
  assert.equal(fs.existsSync(task.resultPath), false);
  assert.equal(cancelPsdImportTask(id).task.status, 'cancelled');
});

test('existing artifact identity after restart blocks PSD replay', () => {
  const id = 'psd-existing-' + randomUUID();
  const directory = path.join(PLUGIN_ROOT, '.tmp', 'psd-to-figma', id);
  fs.mkdirSync(directory, {recursive: true});
  try {
    assert.throws(() => startPsdImportTask(parseArgs([]), {clientRequestId: id,
      fileName: 'input.psd', fileBase64: 'YWJj', target: {sessionId: 'one', fileKey: 'file'}}), /Do not replay/);
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});
