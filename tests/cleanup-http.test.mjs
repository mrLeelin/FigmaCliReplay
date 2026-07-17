import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../dist/config.js";
import { CleanupError } from "../dist/cleanup/cleanupTypes.js";
import { createRelayHttpServer } from "../dist/httpServer.js";
import { UnityProjectRegistry } from "../dist/unityProjectRegistry.js";

function runView(state = "review") {
  return {
    ok: true,
    runId: "cleanup-1",
    sessionId: "figma-1",
    providerId: "codex",
    rootNodeId: "R",
    snapshotHash: "a".repeat(64),
    state,
    planReady: state === "review",
    startedAt: "2026-07-17T00:00:00.000Z",
    cancelRequested: false,
    nextSequence: 1,
    output: [],
  };
}

async function withServer(callback) {
  const calls = [];
  const controller = {
    async start(request) {
      calls.push(["start", request]);
      if (request.providerId === "claude-code") throw new CleanupError("CLEANUP_ALREADY_RUNNING", "busy");
      return { ok: true, runId: "cleanup-1", capabilityToken: "secret", providerId: request.providerId, state: "planning" };
    },
    get(runId, token, afterSequence) {
      calls.push(["get", runId, token, afterSequence]);
      if (token !== "secret") throw new CleanupError("CLEANUP_CAPABILITY_INVALID", "invalid capability");
      return runView();
    },
    approve(runId, token, request) {
      calls.push(["approve", runId, token, request]);
      return runView("applying");
    },
    cancel(runId, token) {
      calls.push(["cancel", runId, token]);
      return runView("cancelled");
    },
    stopForSession() { return 0; },
    waitForPlanning: async () => {},
    waitForExecution: async () => {},
    has: (runId) => runId === "cleanup-1",
  };
  const runtime = {
    providers: {
      async list() {
        return [
          { id: "codex", label: "Codex", available: true, version: "codex 1" },
          { id: "claude-code", label: "Claude Code", available: false, reason: "command not found: claude" },
        ];
      },
      async resolve(id) {
        if (id === "codex" || id === "claude-code") return { id };
        throw new Error("unknown planning provider");
      },
      refresh() {},
    },
    controller,
  };
  const relay = { status: () => ({ status: "ok" }), hasLivePluginSession: (sessionId) => sessionId === "figma-1" };
  const config = parseArgs(["--port", "32198"]);
  const server = createRelayHttpServer(config, relay, new UnityProjectRegistry(undefined), runtime);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`, calls);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("HTTP exposes provider discovery and dedicated cleanup actions", async () => {
  await withServer(async (baseUrl, calls) => {
    const providers = await fetch(`${baseUrl}/ai-runner/providers`);
    assert.equal(providers.status, 200);
    assert.deepEqual((await providers.json()).providers.map((item) => item.id), ["codex", "claude-code"]);

    const started = await fetch(`${baseUrl}/cleanup/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "figma-1", providerId: "codex", snapshot: { schemaVersion: 1, rootNodeId: "R", nodes: [] } }),
    });
    assert.equal(started.status, 200);
    assert.equal((await started.json()).capabilityToken, "secret");

    const status = await fetch(`${baseUrl}/cleanup/runs/cleanup-1?afterSequence=4`, {
      headers: { "x-ai-run-capability": "secret" },
    });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).state, "review");

    const approved = await fetch(`${baseUrl}/cleanup/runs/cleanup-1/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ai-run-capability": "secret" },
      body: JSON.stringify({ approval: true, snapshotHash: "a".repeat(64) }),
    });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).state, "applying");

    const cancelled = await fetch(`${baseUrl}/cleanup/runs/cleanup-1/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ai-run-capability": "secret" },
      body: "{}",
    });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).state, "cancelled");
    assert.deepEqual(calls.map((call) => call[0]), ["start", "get", "approve", "cancel"]);
  });
});

test("cleanup routes return stable authorization and conflict status codes", async () => {
  await withServer(async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}/cleanup/runs/cleanup-1`);
    assert.equal(unauthorized.status, 403);

    const duplicate = await fetch(`${baseUrl}/cleanup/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "figma-1", providerId: "claude-code", snapshot: { schemaVersion: 1, rootNodeId: "R", nodes: [] } }),
    });
    assert.equal(duplicate.status, 409);
    assert.match((await duplicate.json()).error, /CLEANUP_ALREADY_RUNNING/);
  });
});
