import assert from "node:assert/strict";
import test from "node:test";

import { CleanupPlanMarker, computeCleanupSnapshotHash } from "../dist/cleanupPlan.js";
import { createPlanningProviderRegistry } from "../dist/ai/providerRegistry.js";
import { createCleanupController } from "../dist/cleanup/cleanupController.js";
import { CleanupPlanner } from "../dist/cleanup/cleanupPlanner.js";

const snapshot = {
  schemaVersion: 1,
  rootNodeId: "R",
  nodes: [
    { id: "R", parentId: "", type: "FRAME", name: "Root", siblingIndex: 0, depth: 0 },
    { id: "A", parentId: "R", type: "FRAME", name: "A", siblingIndex: 0, depth: 1 },
    { id: "B", parentId: "R", type: "FRAME", name: "B", siblingIndex: 1, depth: 1 },
    { id: "C", parentId: "R", type: "FRAME", name: "C", siblingIndex: 2, depth: 1 },
    { id: "D", parentId: "R", type: "FRAME", name: "D", siblingIndex: 3, depth: 1 },
  ],
};

function validPlan() {
  return {
    schemaVersion: 2,
    rootNodeId: "R",
    snapshotHash: computeCleanupSnapshotHash(snapshot),
    operations: [
      { id: "one", type: "CREATE_GROUP", parentNodeId: "R", name: "Top", childNodeIds: ["A", "B"] },
      { id: "two", type: "CREATE_GROUP", parentNodeId: "R", name: "Bottom", childNodeIds: ["C", "D"] },
    ],
    preconditions: [],
    verification: { preserveAbsoluteBoundsTolerance: 0.01 },
    warnings: [],
  };
}

function fakePlanner(plan = validPlan()) {
  return {
    async plan(request) {
      request.onProgress({ message: "validating plan", state: "validating" });
      return {
        plan,
        summary: {
          operationCount: plan.operations.length,
          operations: plan.operations.map((operation) => ({ id: operation.id, type: operation.type, label: operation.name || operation.type })),
          warningCount: plan.warnings.length,
          warnings: plan.warnings,
        },
      };
    },
  };
}

function fakeExecutor(state = "succeeded") {
  return {
    async execute(request) {
      request.onProgress({ message: "verifying result", state: "verifying", completed: 2, total: 2 });
      return { state, report: { status: state } };
    },
  };
}

function pendingPlanner() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return {
    planner: { plan: () => promise },
    resolve: () => resolve({ plan: validPlan(), summary: { operationCount: 2, operations: [], warningCount: 0, warnings: [] } }),
  };
}

test("cleanup reaches review without an AI session id", async () => {
  const controller = createCleanupController({ planner: fakePlanner(), executor: fakeExecutor() });
  const started = await controller.start({ sessionId: "figma-1", providerId: "codex", snapshot });
  await controller.waitForPlanning(started.runId);
  const run = controller.get(started.runId, started.capabilityToken);
  assert.equal(run.state, "review");
  assert.equal(run.planReady, true);
  assert.equal(run.providerId, "codex");
  assert.equal("cliSessionId" in run, false);
});

test("cleanup planner uses the explicitly selected provider and common V2 validation", async () => {
  let selectedProvider = "";
  const planner = new CleanupPlanner(
    createPlanningProviderRegistry({ commandAvailable: () => true, commandVersion: () => undefined }),
    {
      async run(request) {
        selectedProvider = request.provider.id;
        assert.match(request.prompt, /schemaVersion 2/i);
        return `${CleanupPlanMarker}\n${JSON.stringify(validPlan())}`;
      },
    },
  );
  const result = await planner.plan({
    runId: "run-1",
    sessionId: "figma-1",
    providerId: "claude-code",
    snapshot,
    signal: new AbortController().signal,
    onProgress: () => {},
  });
  assert.equal(selectedProvider, "claude-code");
  assert.equal(result.plan.schemaVersion, 2);
  assert.equal(result.summary.operationCount, 2);
});

test("one plugin session cannot enqueue a hidden second cleanup", async () => {
  const pending = pendingPlanner();
  const controller = createCleanupController({ planner: pending.planner, executor: fakeExecutor() });
  await controller.start({ sessionId: "figma-1", providerId: "codex", snapshot });
  await assert.rejects(
    controller.start({ sessionId: "figma-1", providerId: "claude-code", snapshot }),
    /CLEANUP_ALREADY_RUNNING/,
  );
  pending.resolve();
});

test("cleanup start rejects recovery backup roots and descendants", async () => {
  const controller = createCleanupController({ planner: fakePlanner(), executor: fakeExecutor() });
  const poisonedSnapshot = {
    ...snapshot,
    nodes: snapshot.nodes.concat({
      id: "backup",
      parentId: "R",
      type: "FRAME",
      name: "__cleanup_backup__orphan",
      siblingIndex: 4,
      depth: 1,
    }),
  };
  await assert.rejects(
    controller.start({ sessionId: "figma-1", providerId: "codex", snapshot: poisonedSnapshot }),
    /CLEANUP_RECOVERY_REQUIRED/,
  );
});

test("approval requires review state, explicit approval, and matching snapshot hash", async () => {
  const controller = createCleanupController({ planner: fakePlanner(), executor: fakeExecutor() });
  const started = await controller.start({ sessionId: "figma-1", providerId: "codex", snapshot });
  await controller.waitForPlanning(started.runId);
  assert.throws(
    () => controller.approve(started.runId, started.capabilityToken, { approval: false, snapshotHash: computeCleanupSnapshotHash(snapshot) }),
    /explicit cleanup approval/i,
  );
  assert.throws(
    () => controller.approve(started.runId, started.capabilityToken, { approval: true, snapshotHash: "stale" }),
    /SNAPSHOT_CHANGED/,
  );
});

test("approved cleanup executes and reaches a terminal state", async () => {
  const controller = createCleanupController({ planner: fakePlanner(), executor: fakeExecutor("succeeded") });
  const started = await controller.start({ sessionId: "figma-1", providerId: "claude-code", snapshot });
  await controller.waitForPlanning(started.runId);
  const approved = controller.approve(started.runId, started.capabilityToken, {
    approval: true,
    snapshotHash: computeCleanupSnapshotHash(snapshot),
  });
  assert.equal(approved.state, "applying");
  await controller.waitForExecution(started.runId);
  assert.equal(controller.get(started.runId, started.capabilityToken).state, "succeeded");
});

test("cancelling review releases the session lock", async () => {
  const controller = createCleanupController({ planner: fakePlanner(), executor: fakeExecutor() });
  const first = await controller.start({ sessionId: "figma-1", providerId: "codex", snapshot });
  await controller.waitForPlanning(first.runId);
  assert.equal(controller.cancel(first.runId, first.capabilityToken).state, "cancelled");
  const second = await controller.start({ sessionId: "figma-1", providerId: "codex", snapshot });
  assert.notEqual(second.runId, first.runId);
});
