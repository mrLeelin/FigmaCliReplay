import assert from "node:assert/strict";
import test from "node:test";

import { createConversationCleanupDispatcher } from "../dist/cleanup/conversationCleanupDispatcher.js";

test("Relay dispatcher forwards only a validated hierarchy transaction to the executor", async () => {
  const calls = [];
  const dispatcher = createConversationCleanupDispatcher({
    async execute(request) {
      calls.push(request);
      request.onProgress({ message: "Figma hierarchy transaction verified." });
      return { state: "succeeded", report: { operationCount: 1 } };
    },
    async executeComponentSets() {
      throw new Error("component sets must not run during hierarchy dispatch");
    },
  });
  const progress = [];
  const result = await dispatcher.dispatchValidatedHierarchyCleanup({
    runId: "cleanup-run-1",
    sessionId: "figma-session-1",
    signal: new AbortController().signal,
    snapshot: {
      schemaVersion: 1,
      rootNodeId: "ROOT",
      nodes: [{ id: "ROOT", parentId: "", type: "FRAME", name: "Root", siblingIndex: 0, depth: 0 }],
    },
    plan: {
      schemaVersion: 3,
      rootNodeId: "ROOT",
      snapshotHash: "snapshot",
      operations: [],
      preconditions: [],
      verification: { preserveAbsoluteBoundsTolerance: 0.01 },
      warnings: [],
    },
    onProgress: (message) => progress.push(message),
  });

  assert.equal(result.state, "succeeded");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].runId, "cleanup-run-1");
  assert.equal(calls[0].sessionId, "figma-session-1");
  assert.deepEqual(progress, ["Figma hierarchy transaction verified."]);
});

test("Relay dispatcher starts ComponentSet creation only after the satisfaction gate", async () => {
  const calls = [];
  const dispatcher = createConversationCleanupDispatcher({
    async execute() {
      throw new Error("hierarchy must not run during component-set dispatch");
    },
    async executeComponentSets(request) {
      calls.push(request);
      request.onProgress({ message: "ComponentSet stage verified." });
      return { state: "succeeded", report: { componentSets: 1 } };
    },
  });
  const progress = [];
  const result = await dispatcher.dispatchConfirmedComponentSets({
    runId: "cleanup-run-2",
    sessionId: "figma-session-2",
    signal: new AbortController().signal,
    snapshot: {
      schemaVersion: 1,
      rootNodeId: "ROOT",
      nodes: [{ id: "ROOT", parentId: "", type: "FRAME", name: "Root", siblingIndex: 0, depth: 0 }],
    },
    plan: {
      schemaVersion: 3,
      rootNodeId: "ROOT",
      snapshotHash: "snapshot",
      operations: [],
      preconditions: [],
      verification: { preserveAbsoluteBoundsTolerance: 0.01 },
      warnings: [],
    },
    onProgress: (message) => progress.push(message),
  });

  assert.equal(result.state, "succeeded");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].runId, "cleanup-run-2");
  assert.deepEqual(progress, ["ComponentSet stage verified."]);
});
