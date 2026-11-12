import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { UpdateService, writeUpdateJson, fetchUpdateManifest } from '../dist/updateService.js';
import { createRelayControlHandler } from '../dist/relayControl.js';

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-update-service-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const config = { schemaVersion: 1, manifestUrl: 'https://releases.example.test/latest.json', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) };
  const payload = { schemaVersion: 1, version: '1.0.1', publishedAt: new Date().toISOString(), notes: ['升级说明 <script>'], archiveUrl: 'https://releases.example.test/relay.zip', sha256: 'a'.repeat(64), size: 100 };
  const bytes = Buffer.from(JSON.stringify(payload));
  const envelope = { schemaVersion: 1, payload: bytes.toString('base64'), signature: crypto.sign(null, bytes, privateKey).toString('base64') };
  writeUpdateJson(path.join(root, 'install.json'), { ...config, currentVersion: '1.0.0' });
  const dataRoot = path.join(root, 'data');
  writeUpdateJson(path.join(dataRoot, '.local/runtime.json'), { schemaVersion: 1, pid: process.pid, instanceId: 'service-test-instance', port: 32130, entry: path.join(root, 'versions/1.0.0/figma-relay/dist/index.js') });
  const options = { installRoot: root, dataRoot, currentVersion: '1.0.0', projectRoot: root, fetchManifest: async () => envelope, launchUpdater: async () => {}, ...overrides };
  return { root, dataRoot, config, payload, envelope, options, service: new UpdateService(options) };
}

test('unconfigured source checkout reports unavailable, never latest or installable', async (t) => {
  const { root, dataRoot } = fixture(t);
  const service = new UpdateService({ projectRoot: path.join(root, 'no-publisher'), dataRoot });
  assert.equal(service.status().configured, false);
  assert.equal(service.status().installed, false);
  assert.equal(service.status().canInstall, false);
  assert.equal((await service.check()).phase, 'failed');
  assert.match(service.status().message, /尚未配置更新源/);
  assert.equal(fs.existsSync(path.join(dataRoot, 'updates/plan.json')), false);
});

test('verified newer release is offered; settings persist without installing', async (t) => {
  const { service, options, dataRoot } = fixture(t);
  const offered = await service.check();
  assert.equal(offered.phase, 'available');
  assert.equal(offered.canInstall, true);
  assert.equal(offered.latest.version, '1.0.1');
  assert.equal(service.settings(false).autoCheck, false);
  assert.equal(new UpdateService(options).status().autoCheck, false);
  assert.equal(fs.existsSync(path.join(dataRoot, 'updates/plan.json')), false);
  assert.throws(() => service.settings('true'), /布尔/);
});

test('one network check runs for concurrent clients and a tampered feed clears stale offers', async (t) => {
  let release, calls = 0;
  const { options, envelope } = fixture(t);
  const service = new UpdateService({ ...options, fetchManifest: () => { calls++; return new Promise((resolve) => { release = resolve; }); } });
  const first = service.check(), second = service.check();
  assert.equal(first, second);
  release(envelope);
  await first;
  assert.equal(calls, 1);
  options.fetchManifest = async () => ({ ...envelope, signature: Buffer.alloc(64).toString('base64') });
  const failing = new UpdateService(options);
  assert.equal((await failing.check()).phase, 'failed');
  assert.equal(failing.status().canInstall, false);
});

test('install launches exactly once, persists only the verified plan and reconciles external progress', async (t) => {
  let launches = 0;
  const { options, dataRoot, envelope } = fixture(t);
  const service = new UpdateService({ ...options, launchUpdater: async (file) => {
    launches++;
    const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(plan.envelope, envelope);
    assert.equal(plan.runtime.pid, process.pid);
  } });
  await Promise.all([service.install(), service.install()]);
  assert.equal(launches, 1);
  assert.equal(service.status().phase, 'preparing');
  const file = path.join(dataRoot, 'updates/status.json');
  writeUpdateJson(file, { ...JSON.parse(fs.readFileSync(file)), phase: 'downloading', progress: 43, message: '下载中' });
  assert.equal(service.status().progress, 43);
  await service.install();
  assert.equal(launches, 1);
});

test('updater launch failure stays recoverable without reporting installed', async (t) => {
  const { options } = fixture(t);
  const service = new UpdateService({ ...options, launchUpdater: async () => { throw new Error('missing updater'); } });
  const result = await service.install();
  assert.equal(result.phase, 'failed');
  assert.equal(result.currentVersion, '1.0.0');
  assert.match(result.error, /missing updater/);
});

test('a local check never hides detached progress or later Bridge results', async (t) => {
  const { service, dataRoot, payload } = fixture(t);
  await service.check();
  const file = path.join(dataRoot, 'updates/status.json');
  writeUpdateJson(file, { phase: 'downloading', progress: 78, message: '后台正在下载', latest: payload });
  assert.equal(service.status().phase, 'downloading');
  writeUpdateJson(file, { phase: 'restart-required', message: '应用更新完成', latest: payload, bridge: { projectId: 'current', phase: 'completed', message: '已编译重连' } });
  assert.equal(service.status().bridge.phase, 'completed');
  assert.equal(service.status().bridge.message, '已编译重连');
});

test('GitHub HTTPS asset redirects are supported and downgrade redirects are rejected', async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const urls = [];
  global.fetch = async (url) => {
    urls.push(String(url));
    return urls.length === 1
      ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/signed-asset' } })
      : new Response(JSON.stringify({ test: 'manifest' }));
  };
  assert.deepEqual(await fetchUpdateManifest('https://github.com/owner/repo/releases/latest/download/latest.json'), { test: 'manifest' });
  assert.equal(urls.length, 2);
  global.fetch = async () => new Response(null, { status: 302, headers: { location: 'http://insecure.test/file' } });
  await assert.rejects(fetchUpdateManifest('https://github.com/owner/repo/latest.json'), /HTTPS/);
});

test('install refuses a runtime owned by another process', async (t) => {
  let launched = false;
  const { options, dataRoot } = fixture(t);
  writeUpdateJson(path.join(dataRoot, '.local/runtime.json'), { pid: -1, instanceId: 'another-instance' });
  const result = await new UpdateService({ ...options, launchUpdater: async () => { launched = true; } }).install();
  assert.equal(result.phase, 'failed');
  assert.equal(launched, false);
});

test('an interrupted detached updater becomes a repairable failure instead of polling forever', (t) => {
  const { service, dataRoot } = fixture(t);
  writeUpdateJson(path.join(dataRoot, 'updates/status.json'), { planId: 'interrupted', phase: 'preparing', message: '准备中' });
  writeUpdateJson(path.join(dataRoot, 'updates/runner.json'), { planId: 'interrupted', pid: 2147483647 });
  assert.equal(service.status().phase, 'failed');
  assert.match(service.status().message, /更新修复/);
});

test('later status polls resume verification when Unity reconnects after the initial timeout', async (t) => {
  let probes = 0;
  const { options, dataRoot } = fixture(t);
  writeUpdateJson(path.join(dataRoot, 'updates/status.json'), { phase: 'restart-required', bridge: { projectId: 'current', phase: 'pending-reconnect', message: '等待连接' } });
  const service = new UpdateService({ ...options, refreshBridge: async () => { probes++; } });
  assert.equal(service.status().bridge.phase, 'pending-reconnect');
  await Promise.resolve();
  assert.equal(probes, 1);
});

test('a plan interrupted before updater spawn expires after the short startup grace', (t) => {
  const { service, dataRoot } = fixture(t);
  const file = path.join(dataRoot, 'updates/status.json');
  writeUpdateJson(file, { planId: 'not-started', phase: 'preparing', updatedAt: new Date().toISOString() });
  assert.equal(service.status().phase, 'preparing');
  writeUpdateJson(file, { planId: 'not-started', phase: 'preparing', updatedAt: new Date(Date.now() - 31_000).toISOString() });
  assert.equal(service.status().phase, 'failed');
  assert.match(service.status().message, /未能启动/);
});

test('update controls reject URL/path injection and require the selected Bridge project', async (t) => {
  const { service, dataRoot } = fixture(t);
  const projects = { list: () => ({ lastSelectedProjectId: 'selected', projects: [] }), snapshot: (id) => ({ id, path: 'C:/Unity/Selected', valid: true }) };
  const control = createRelayControlHandler({ status: () => ({ plugin: { sessions: [] } }) }, {}, undefined, projects, undefined, undefined, undefined, service);
  for (const payload of [{ url: 'https://attacker.test' }, { installRoot: 'C:/Windows' }, { archivePath: 'C:/untrusted.zip' }]) {
    await assert.rejects(control('relay.update.install', payload), /不接受/);
  }
  await assert.rejects(control('relay.update.install', { updateBridge: true, projectId: 'other' }), /当前 Unity/);
  await assert.rejects(control('relay.update.install', { updateBridge: 1 }), /布尔/);
  assert.equal(fs.existsSync(path.join(dataRoot, 'updates/plan.json')), false);
  await control('relay.update.install', { updateBridge: true, projectId: 'selected' });
  const plan = JSON.parse(fs.readFileSync(path.join(dataRoot, 'updates/plan.json')));
  assert.equal(plan.updateBridgeProjectPath, 'C:/Unity/Selected');
});

test('shutdown rejects foreign plans and active work before requesting a graceful stop', async (t) => {
  let active = 1, shutdowns = 0;
  const { options, dataRoot } = fixture(t);
  const original = process.env.FIGMA_RELAY_INSTANCE_ID;
  process.env.FIGMA_RELAY_INSTANCE_ID = 'service-test-instance';
  t.after(() => { if (original === undefined) delete process.env.FIGMA_RELAY_INSTANCE_ID; else process.env.FIGMA_RELAY_INSTANCE_ID = original; });
  const service = new UpdateService({ ...options, activity: () => active, shutdown: () => { shutdowns++; } });
  await service.install();
  const plan = JSON.parse(fs.readFileSync(path.join(dataRoot, 'updates/plan.json')));
  assert.throws(() => service.shutdown('foreign'), /不匹配/);
  assert.throws(() => service.shutdown(plan.planId), /仍有任务/);
  assert.equal(shutdowns, 0);
  active = 0;
  assert.deepEqual(service.shutdown(plan.planId), { ok: true });
  service.shutdown(plan.planId);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(shutdowns, 1);
});
