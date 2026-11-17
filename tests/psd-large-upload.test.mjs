import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import fs from 'node:fs';
import test from 'node:test';
import { WebSocket } from 'ws';
import { WebSocketGateway } from '../dist/websocketGateway.js';

test('PSD upload above the old 100 MiB frame limit reaches the handler without disconnecting', { timeout: 30000 }, async (t) => {
  const gateway = new WebSocketGateway();
  const server = createServer();
  gateway.attachServer(server);
  t.after(async () => {
    gateway.close();
    await new Promise(resolve => server.close(resolve));
  });
  let acceptedBytes = 0;
  gateway.onClientRequest(request => {
    assert.equal(request.action, 'psd.import.start');
    acceptedBytes = request.payload.fileBase64.length;
    return { ok: true, task: { taskId: request.payload.clientRequestId, status: 'queued' } };
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/figma`);
  t.after(() => socket.terminate());
  await once(socket, 'open');
  const registered = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'plugin.register', sessionId: 'large-psd', figma: { fileKey: 'file' } }));
  await registered;
  // Optional real input validates the reported file without executing a Figma write.
  const base64 = process.env.PSD_UPLOAD_TEST_FILE
    ? fs.readFileSync(process.env.PSD_UPLOAD_TEST_FILE).toString('base64')
    : 'A'.repeat(100 * 1024 * 1024 + 4);
  const outcome = new Promise(resolve => {
    socket.once('message', raw => resolve(JSON.parse(String(raw))));
    socket.once('close', code => resolve({ closed: code }));
  });
  socket.send(JSON.stringify({ type: 'relay.request', requestId: 'upload', action: 'psd.import.start', payload: {
    clientRequestId: 'large-psd-task', fileName: 'large.psd', fileBase64: base64,
  } }));
  const result = await outcome;
  assert.equal(result.closed, undefined, `Upload disconnected before task creation (close code ${result.closed})`);
  assert.equal(result.ok, true);
  assert.equal(result.result.task.taskId, 'large-psd-task');
  assert.equal(acceptedBytes, base64.length);
  socket.close();
  await once(socket, 'close');
});
