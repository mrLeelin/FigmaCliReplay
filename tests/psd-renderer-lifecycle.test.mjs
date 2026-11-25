import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test, { after, beforeEach, mock } from 'node:test';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'psd-renderer-lifecycle-'));
process.env.FIGMA_RELAY_DATA_ROOT = dataRoot;
process.env.LOG_LEVEL = 'silent';
const originalRenderer = process.env.FIGMA_RELAY_PSD_RENDERER;
let scenario;
let events;
let held;
let killed;

mock.method(childProcess, 'spawnSync', (command) => ({ status: command === 'reg' && !scenario.available ? 1 : 0 }));
mock.method(childProcess, 'spawn', (_command, args, options) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const script = path.basename(args.find(arg => arg.endsWith('.py')));
  const taskId = options.env.FIGMA_RELAY_OPERATION_ID;
  child.kill = () => { killed.push(script); child.emit('close', 1); return true; };
  const value = flag => args[args.indexOf(flag) + 1];
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(content));
  };
  queueMicrotask(() => {
    events.push({ script, taskId, args: [...args] });
    let code = 0;
    let output = '';
    let stderr = '';
    if (script === 'export_psd_layers.py') {
      write(path.join(value('--out'), 'manifest_summary.json'), { canvas: { width: 100, height: 100 }, layers: [], hiddenLayerIds: [71] });
    } else if (script === 'photoshop_render_units.py' || script === 'psd_tools_render_units.py') {
      const reference = path.join(value('--out'), script === 'photoshop_render_units.py' ? 'ps_render/reference.png' : 'reference.png');
      const base = JSON.parse(fs.readFileSync(value('--base-manifest'), 'utf8'));
      write(path.join(value('--out'), 'manifest_summary.json'), {
        layers: [], renderSource: script, referencePath: reference, hiddenLayerIds: base.hiddenLayerIds,
      });
      write(reference, {});
      if (script === 'photoshop_render_units.py') {
        write(value('--session-receipt'), { version: 1, startedByImport: !scenario.preexisting, state: 'active' });
        if (scenario.failRender) code = 1;
      }
    } else if (script === 'submit_psd_import_job.py') {
      if (scenario.failSubmit) {
        code = 1;
        output = scenario.submitStdout || '';
        stderr = scenario.submitStderr || '';
      } else write(value('--result-output'), { result: value('--import-mode') === 'incremental-preview'
        ? { status: 'preview-no-changes', baselineFingerprint: 'preview-fingerprint', canApply: false }
        : { status: 'completed', rootNodeId: '12:34' } });
    } else if (script === 'verify_psd_visual.py') {
      const report = {
        status: scenario.visualDifference ? 'differences' : 'passed',
        differenceCount: scenario.visualDifference ? 1 : 0,
        screenshotPath: path.join(value('--out'), 'final.png'),
        reportPath: path.join(value('--out'), 'report.json'),
      };
      output = JSON.stringify(report);
      write(report.reportPath, report);
    } else if (script === 'photoshop_lifecycle.py') {
      output = JSON.stringify({ ok: true, action: scenario.preexisting || scenario.openDocuments ? 'kept' : 'closed',
        reason: scenario.openDocuments ? 'open-documents' : scenario.preexisting ? 'already-running' : 'owned-import-finished' });
      if (scenario.failCleanup) code = 1;
    }
    const finish = () => {
      if (output) child.stdout.emit('data', Buffer.from(output));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    };
    if ((script === 'photoshop_render_units.py' && scenario.holdRender)
      || (script === 'submit_psd_import_job.py' && scenario.holdSubmit)
      || (script === 'photoshop_lifecycle.py' && scenario.holdCleanup)) {
      held.set(taskId, finish);
    } else finish();
  });
  return child;
});
syncBuiltinESMExports();
const { startPsdImportTask, getPsdImportTask, cancelPsdImportTask } = await import('../dist/psdImportTask.js');
const { getLoggingRuntime } = await import('../dist/logging/loggingRuntime.js');
const config = { host: '127.0.0.1', publicHost: 'localhost', port: 32130, transport: 'websocket',
  verbose: false, pythonWorker: false, adminToken: 'test', bridgeToken: 'test', assetRoots: [] };

beforeEach(() => {
  delete process.env.FIGMA_RELAY_PSD_RENDERER;
  scenario = { available: true, preexisting: false };
  events = [];
  held = new Map();
  killed = [];
});
after(async () => {
  for (const finish of held.values()) finish();
  mock.restoreAll();
  syncBuiltinESMExports();
  if (originalRenderer === undefined) delete process.env.FIGMA_RELAY_PSD_RENDERER;
  else process.env.FIGMA_RELAY_PSD_RENDERER = originalRenderer;
  await getLoggingRuntime().close();
  assert.equal(path.dirname(path.resolve(dataRoot)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dataRoot).startsWith('psd-renderer-lifecycle-'));
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

function start(mode = 'initial') {
  return startPsdImportTask(config, { clientRequestId: 'psd-lifecycle-' + randomUUID(), fileName: 'dialog.psd',
    fileBase64: Buffer.alloc(32, 1).toString('base64'), mode, target: { sessionId: 'session', fileKey: 'file',
      ...(mode === 'incremental-preview' ? { targetNodeId: '12:34', targetType: 'FRAME' } : {}) } });
}
async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('PSD task did not reach the expected state');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
async function completed(task) {
  await waitFor(() => ['completed', 'error', 'cancelled'].includes(getPsdImportTask(task.taskId).status));
  return getPsdImportTask(task.taskId);
}
const scripts = task => events.filter(event => event.taskId === task.taskId).map(event => event.script);

test('auto selects Photoshop when installed and closes an owned instance only after Figma and text alignment', async () => {
  const task = start();
  const result = await completed(task);
  assert.equal(result.status, 'completed');
  assert.equal(result.renderer, 'photoshop');
  assert.deepEqual(scripts(task), ['export_psd_layers.py', 'photoshop_render_units.py', 'submit_psd_import_job.py',
    'align_psd_text_to_reference.py', 'align_psd_text_to_reference.py', 'verify_psd_visual.py', 'photoshop_lifecycle.py']);
  assert.equal(result.summary.visualValidation.status, 'passed');
  assert.equal(JSON.parse(fs.readFileSync(result.resultPath, 'utf8')).result.visualValidation.status, 'passed');
  assert.match(result.logs.join('\n'), /本次导入启动的 Photoshop 已退出/);
  assert.ok(!events.find(event => event.taskId === task.taskId && event.script === 'export_psd_layers.py').args.includes('--include-hidden'));
});

test('incremental previews submit rendered manifest with hidden IDs and release the renderer', async () => {
  const initial = await completed(start());
  const task = start('incremental-preview');
  await waitFor(() => getPsdImportTask(task.taskId).status === 'preview-no-changes');
  const result = getPsdImportTask(task.taskId);
  const initialManifest = JSON.parse(fs.readFileSync(initial.manifestSummaryPath, 'utf8'));
  const previewManifest = JSON.parse(fs.readFileSync(result.manifestSummaryPath, 'utf8'));
  assert.equal(result.renderer, initial.renderer);
  assert.deepEqual(previewManifest.hiddenLayerIds, [71]);
  assert.equal(previewManifest.renderSource, initialManifest.renderSource);
  assert.deepEqual(scripts(task), ['export_psd_layers.py', 'photoshop_render_units.py', 'submit_psd_import_job.py',
    'photoshop_lifecycle.py']);
});

test('explicit raw incremental mode keeps the original hidden-layer export', async () => {
  process.env.FIGMA_RELAY_PSD_RENDERER = 'raw';
  const task = start('incremental-preview');
  await waitFor(() => getPsdImportTask(task.taskId).status === 'preview-no-changes');
  const exported = events.find(event => event.taskId === task.taskId && event.script === 'export_psd_layers.py');
  assert.ok(exported.args.includes('--include-hidden'));
  assert.deepEqual(scripts(task), ['export_psd_layers.py', 'submit_psd_import_job.py']);
});

test('visual differences are surfaced after import without repeating the Figma write', async () => {
  scenario.visualDifference = true;
  const task = start();
  const result = await completed(task);
  assert.equal(result.status, 'completed');
  assert.equal(result.summary.visualValidation.differenceCount, 1);
  assert.match(result.summary.warnings.join('\n'), /视觉校验发现 1 个区域有差异/);
  assert.equal(scripts(task).filter(script => script === 'submit_psd_import_job.py').length, 1);
});

test('auto selects psd-tools without Photoshop and never touches its lifecycle', async () => {
  scenario.available = false;
  const task = start();
  const result = await completed(task);
  assert.equal(result.status, 'completed');
  assert.equal(result.renderer, 'psd-tools');
  assert.deepEqual(scripts(task), ['export_psd_layers.py', 'psd_tools_render_units.py', 'submit_psd_import_job.py',
    'verify_psd_visual.py']);
});

test('an already running Photoshop is retained after import', async () => {
  scenario.preexisting = true;
  const result = await completed(start());
  assert.equal(result.status, 'completed');
  assert.match(result.logs.join('\n'), /导入前已运行，保持打开/);
});

test('an owned instance retained for open documents reports its actual reason', async () => {
  scenario.openDocuments = true;
  const result = await completed(start());
  assert.equal(result.status, 'completed');
  assert.match(result.logs.join('\n'), /仍有打开的文档，保持打开/);
  assert.doesNotMatch(result.logs.join('\n'), /导入前已运行/);
});

for (const phase of ['failRender', 'failSubmit']) {
  test(`an owned Photoshop session is released when ${phase} fails`, async () => {
    scenario[phase] = true;
    const task = start();
    const result = await completed(task);
    assert.equal(result.status, 'error');
    assert.equal(scripts(task).filter(script => script === 'photoshop_lifecycle.py').length, 1);
    if (phase === 'failRender') assert.ok(!scripts(task).includes('submit_psd_import_job.py'));
  });
}

const cliDiagnostic = JSON.stringify({ level: 30, time: 1794973186635,
  module: 'relay-cli', operationId: 'cli-operation', msg: 'Run project CLI command' });

test('PSD import surfaces an explicit Python failure ahead of Relay CLI diagnostics', async () => {
  const reason = "Preflight failed: preflight /health failed: {'code': 'UPGRADE_REQUIRED', 'message': 'Upgrade the CLI and Relay together to matching versions.'}";
  scenario.failSubmit = true;
  scenario.submitStdout = [
    '[PREFLIGHT] relay health + target...',
    `[FAIL] ${reason}`,
    '  Timeline JSON: timeline.json',
  ].join('\r\n');
  scenario.submitStderr = (cliDiagnostic + '\r\n').repeat(10);
  const result = await completed(start());
  assert.equal(result.status, 'error');
  assert.equal(result.error, `submit_psd_import_job.py exited with code 1: ${reason}`);
});

test('PSD import surfaces the final Python exception when stdout has no explicit failure', async () => {
  scenario.failSubmit = true;
  scenario.submitStderr = [cliDiagnostic, 'Traceback (most recent call last):',
    '  File "submit_psd_import_job.py", line 1, in main', 'ValueError: invalid manifest', cliDiagnostic].join('\r\n');
  const result = await completed(start());
  assert.equal(result.status, 'error');
  assert.equal(result.error, 'submit_psd_import_job.py exited with code 1: ValueError: invalid manifest');
});

test('cancelling rendering releases the owned instance and never writes to Figma', async () => {
  scenario.holdRender = true;
  const task = start();
  await waitFor(() => held.has(task.taskId));
  assert.equal(cancelPsdImportTask(task.taskId).accepted, true);
  held.get(task.taskId)();
  const result = await completed(task);
  assert.equal(result.status, 'cancelled');
  assert.ok(!scripts(task).includes('submit_psd_import_job.py'));
  assert.equal(scripts(task).at(-1), 'photoshop_lifecycle.py');
});

test('a queued import cannot use Photoshop until the previous import has finished its cleanup', async () => {
  scenario.holdSubmit = true;
  const first = start();
  await waitFor(() => held.has(first.taskId));
  const second = start();
  await waitFor(() => getPsdImportTask(second.taskId).stage === 'waiting_for_photoshop');
  assert.ok(!scripts(second).includes('photoshop_render_units.py'));
  scenario.holdSubmit = false;
  held.get(first.taskId)();
  assert.equal((await completed(first)).status, 'completed');
  assert.equal((await completed(second)).status, 'completed');
  assert.ok(events.findIndex(event => event.taskId === first.taskId && event.script === 'photoshop_lifecycle.py')
    < events.findIndex(event => event.taskId === second.taskId && event.script === 'photoshop_render_units.py'));
});

test('a task cancelled while queued never starts Photoshop', async () => {
  scenario.holdRender = true;
  const first = start();
  await waitFor(() => held.has(first.taskId));
  const second = start();
  await waitFor(() => getPsdImportTask(second.taskId).stage === 'waiting_for_photoshop');
  assert.equal(cancelPsdImportTask(second.taskId).accepted, true);
  scenario.holdRender = false;
  held.get(first.taskId)();
  assert.equal((await completed(first)).status, 'completed');
  assert.equal((await completed(second)).status, 'cancelled');
  assert.deepEqual(scripts(second), ['export_psd_layers.py']);
});

test('a cleanup failure preserves a successful Figma result and releases the queue', async () => {
  scenario.failCleanup = true;
  const first = await completed(start());
  assert.equal(first.status, 'completed');
  assert.match(first.logs.join('\n'), /Photoshop 自动退出失败/);
  scenario.failCleanup = false;
  assert.equal((await completed(start())).status, 'completed');
});

test('a stuck COM cleanup only times out its Python helper and lets the next import proceed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  scenario.holdCleanup = true;
  const second = start();
  for (let i = 0; i < 30 && !held.has(second.taskId); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(held.has(second.taskId));
  t.mock.timers.tick(30_000);
  for (let i = 0; i < 30 && getPsdImportTask(second.taskId).status !== 'completed'; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(getPsdImportTask(second.taskId).status, 'completed');
  assert.deepEqual(killed, ['photoshop_lifecycle.py']);
  assert.match(getPsdImportTask(second.taskId).logs.join('\n'), /timed out after 30000 ms/);
  t.mock.timers.reset();
  scenario.holdCleanup = false;
  assert.equal((await completed(start())).status, 'completed');
});
