import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { DATA_ROOT, parseArgs } from '../dist/config.js';
import { MAX_PSD_UPLOAD_BYTES, MAX_INLINE_PSD_UPLOAD_BYTES, MAX_PLUGIN_MESSAGE_BYTES, PSD_UPLOAD_CHUNK_BYTES, assertPsdUploadSize } from '../dist/psdUploadLimits.js';
import { stagePsdUploadChunk, preparePsdUpload, hashPsdFile } from '../dist/psdUploadStore.js';
import { getPsdImportTask } from '../dist/psdImportTask.js';
import { RuntimeRelay } from '../dist/runtimeRelay.js';
import { createRelayControlHandler } from '../dist/relayControl.js';

function fixture(t) {
  const id = 'psd-chunk-test-' + randomUUID();
  const uploadRoot = path.resolve(DATA_ROOT, '.tmp', 'psd-uploads');
  const taskRoot = path.resolve(DATA_ROOT, '.tmp', 'psd-to-figma');
  const uploadDirectory = path.join(uploadRoot, id);
  const taskDirectory = path.join(taskRoot, id);
  t.after(() => {
    for (const [directory, root] of [[uploadDirectory, uploadRoot], [taskDirectory, taskRoot]]) {
      assert.equal(path.dirname(path.resolve(directory)), root);
      assert.equal(path.basename(directory), id);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  return { id, uploadDirectory, taskDirectory, payload: {
    clientRequestId: id, fileName: 'large.psd', sessionId: 'one', fileKey: 'file',
    totalBytes: PSD_UPLOAD_CHUNK_BYTES + 32, chunkCount: 2,
  } };
}

test('1 GiB is allowed, one extra byte is refused, and only inline data determines frame size', () => {
  assert.equal(MAX_PSD_UPLOAD_BYTES, 1024 * 1024 * 1024);
  assert.doesNotThrow(() => assertPsdUploadSize(MAX_PSD_UPLOAD_BYTES));
  assert.throws(() => assertPsdUploadSize(MAX_PSD_UPLOAD_BYTES + 1), /1 GiB/);
  assert.ok(MAX_PLUGIN_MESSAGE_BYTES >= 4 * Math.ceil(MAX_INLINE_PSD_UPLOAD_BYTES / 3) + 1024);
  assert.ok(4 * Math.ceil(PSD_UPLOAD_CHUNK_BYTES / 3) + 1024 < 16 * 1024 * 1024);
});

test('staged chunks deduplicate, freeze identity and assemble exact bytes in order', t => {
  const { id, payload, uploadDirectory, taskDirectory } = fixture(t);
  const first = Buffer.alloc(PSD_UPLOAD_CHUNK_BYTES, 37);
  const last = Buffer.alloc(32, 91);
  const chunk = { ...payload, chunkIndex: 0, chunkBase64: first.toString('base64') };
  assert.equal(stagePsdUploadChunk(chunk).uploadId, id);
  assert.deepEqual(stagePsdUploadChunk(chunk), stagePsdUploadChunk(chunk));
  assert.equal(getPsdImportTask(id), undefined, 'staging must not create a Figma import task');
  assert.equal(fs.existsSync(taskDirectory), false);
  assert.throws(() => preparePsdUpload(id, id, 'large.psd', 'one', 'file'), /incomplete at chunk 1/);
  assert.throws(() => stagePsdUploadChunk({ ...chunk, chunkBase64: Buffer.alloc(first.length, 38).toString('base64') }), /conflicts.*bytes/);
  assert.throws(() => stagePsdUploadChunk({ ...chunk, sessionId: 'two' }), /metadata or Figma session/);
  assert.throws(() => stagePsdUploadChunk({ ...chunk, fileName: 'other.psd' }), /metadata or Figma session/);
  assert.throws(() => stagePsdUploadChunk({ ...chunk, totalBytes: payload.totalBytes + 1 }), /metadata or Figma session/);
  assert.throws(() => stagePsdUploadChunk({ ...chunk, chunkIndex: 2 }), /chunk index/);
  assert.throws(() => stagePsdUploadChunk({ ...chunk, chunkBase64: '!!!!' }), /chunk length/);
  stagePsdUploadChunk({ ...payload, chunkIndex: 1, chunkBase64: last.toString('base64') });
  assert.throws(() => preparePsdUpload(id, id, 'large.psd', 'two', 'file'), /different file or Figma session/);
  assert.throws(() => preparePsdUpload(id, id, 'large.psd', 'one', 'other'), /different file or Figma session/);
  assert.throws(() => preparePsdUpload(id, 'another-id', 'large.psd', 'one', 'file'), /original clientRequestId/);
  const prepared = preparePsdUpload(id, id, 'large.psd', 'one', 'file');
  const expected = Buffer.concat([first, last]);
  assert.equal(prepared.size, expected.length);
  assert.deepEqual(fs.readFileSync(prepared.sourcePath), expected);
  assert.equal(prepared.sha256, createHash('sha256').update(expected).digest('hex'));
  assert.equal(hashPsdFile(prepared.sourcePath), prepared.sha256);
  assert.equal(path.dirname(prepared.sourcePath), uploadDirectory);
  fs.mkdirSync(taskDirectory, { recursive: true });
  assert.throws(() => stagePsdUploadChunk(chunk), /Do not replay/);
});

test('a 1 GiB upload uses 256 bounded chunks and refuses oversize or missing data', t => {
  const { id, payload, uploadDirectory } = fixture(t);
  const chunk = { ...payload, totalBytes: MAX_PSD_UPLOAD_BYTES, chunkCount: 256, chunkIndex: 0,
    chunkBase64: Buffer.alloc(PSD_UPLOAD_CHUNK_BYTES).toString('base64') };
  assert.throws(() => stagePsdUploadChunk({ ...chunk, totalBytes: MAX_PSD_UPLOAD_BYTES + 1, chunkCount: 257 }), /1 GiB/);
  assert.equal(fs.existsSync(uploadDirectory), false);
  stagePsdUploadChunk(chunk);
  stagePsdUploadChunk({ ...chunk, chunkIndex: 255 });
  assert.equal(fs.statSync(path.join(uploadDirectory, '255.chunk')).size, PSD_UPLOAD_CHUNK_BYTES);
  assert.throws(() => preparePsdUpload(id, id, 'large.psd', 'one', 'file'), /incomplete at chunk 1/);
  assert.equal(getPsdImportTask(id), undefined);
});

test('a complete 1 GiB source assembles and hashes with bounded buffers', { skip: process.env.PSD_UPLOAD_FULL_GIB_TEST !== '1', timeout: 60000 }, t => {
  const { id, payload } = fixture(t);
  const bytes = Buffer.alloc(PSD_UPLOAD_CHUNK_BYTES, 83);
  const chunkBase64 = bytes.toString('base64');
  const expected = createHash('sha256');
  for (let index = 0; index < 256; index++) {
    stagePsdUploadChunk({ ...payload, totalBytes: MAX_PSD_UPLOAD_BYTES, chunkCount: 256, chunkIndex: index, chunkBase64 });
    expected.update(bytes);
  }
  const prepared = preparePsdUpload(id, id, 'large.psd', 'one', 'file');
  assert.equal(prepared.size, MAX_PSD_UPLOAD_BYTES);
  assert.equal(fs.statSync(prepared.sourcePath).size, MAX_PSD_UPLOAD_BYTES);
  assert.equal(prepared.sha256, expected.digest('hex'));
  assert.equal(hashPsdFile(prepared.sourcePath), prepared.sha256);
  assert.equal(getPsdImportTask(id), undefined, 'this test must not submit a Figma import');
});

test('the real start control consumes a complete staged source once and preserves task identity', { timeout: 20000 }, async t => {
  const { id, payload, taskDirectory } = fixture(t);
  const relay = { config: parseArgs([]), status: () => ({ plugin: { sessions: [
    { authenticated: true, sessionId: 'one', fileKey: 'file' },
    { authenticated: true, sessionId: 'two', fileKey: 'other' },
  ] } }), algorithmControl: RuntimeRelay.prototype.algorithmControl };
  const control = createRelayControlHandler(relay, {});
  const bytes = Buffer.alloc(32);
  const staged = { ...payload, totalBytes: bytes.length, chunkCount: 1, chunkIndex: 0, chunkBase64: bytes.toString('base64') };
  await assert.rejects(control('psd.import.upload-chunk', { ...staged, sessionId: undefined, fileKey: undefined }), /exactly one/);
  await control('psd.import.upload-chunk', staged);
  await assert.rejects(control('psd.import.upload-chunk', { ...staged, sessionId: 'two', fileKey: 'other' }), /metadata or Figma session/);
  const start = { clientRequestId: id, uploadId: id, fileName: 'large.psd', sessionId: 'one' };
  await assert.rejects(control('psd.import.start', { ...start, fileBase64: bytes.toString('base64') }), /exactly one/);
  await assert.rejects(control('psd.import.start', { ...start, sessionId: 'two' }), /different file or Figma session/);
  assert.equal(fs.existsSync(taskDirectory), false);
  const first = await control('psd.import.start', start);
  assert.equal(first.task.taskId, id);
  assert.equal(first.task.sourceFile.size, bytes.length);
  assert.equal(first.task.sourceFile.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(fs.readFileSync(first.task.sourcePsdPath), bytes);
  const second = await control('psd.import.start', start);
  assert.equal(second.task.taskId, id);
  await assert.rejects(control('psd.import.start', { ...start, uploadId: 'changed' }), /conflicts/);
  const deadline = Date.now() + 15000;
  while (!['error', 'completed'].includes(getPsdImportTask(id).status)) {
    assert.ok(Date.now() < deadline, 'invalid PSD export must finish without a Figma submission');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(getPsdImportTask(id).status, 'error');
  assert.equal(fs.existsSync(first.task.resultPath), false);
});
