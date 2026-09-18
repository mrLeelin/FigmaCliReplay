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
    confirmComponentSets(runId, token, request) {
      calls.push(["confirmComponentSets", runId, token, request]);
      return runView(request.satisfied ? "applying" : "succeeded");
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

test("retired cleanup HTTP routes cannot invoke the controller", async () => {
  await withServer(async (baseUrl, calls) => {
    for (const route of ["/ai-runner/providers", "/cleanup/runs", "/cleanup/runs/cleanup-1/approve", "/cleanup/runs/cleanup-1/cancel"]) {
      const response = await fetch(baseUrl + route, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(response.status, 410);
    }
    assert.equal(calls.length, 0);
  });
});
