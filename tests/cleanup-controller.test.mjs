import assert from "node:assert/strict";
import test from "node:test";

import { computeCleanupSnapshotHash } from "../dist/cleanupPlan.js";
import { createPlanningProviderRegistry } from "../dist/ai/providerRegistry.js";
import { createCleanupController } from "../dist/cleanup/cleanupController.js";
import { buildCleanupPlanV2ReviewTask, CleanupPlanner } from "../dist/cleanup/cleanupPlanner.js";
import { CleanupSkillDecisionMarker } from "../dist/cleanup/skillConstrainedPlan.js";

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
    schemaVersion: 3,
    rootNodeId: "R",
    snapshotHash: computeCleanupSnapshotHash(snapshot),
    operations: [
      { id: "one", type: "CREATE_GROUP", parentNodeId: "R", name: "Top", childNodeIds: ["A", "B"] },
      { id: "two", type: "CREATE_GROUP", parentNodeId: "R", name: "Bottom", childNodeIds: ["C", "D"] },
    ],
    preconditions: [
      { nodeId: "A", parentNodeId: "R", siblingIndex: 0 },
      { nodeId: "B", parentNodeId: "R", siblingIndex: 1 },
      { nodeId: "C", parentNodeId: "R", siblingIndex: 2 },
      { nodeId: "D", parentNodeId: "R", siblingIndex: 3 },
    ],
    verification: { preserveAbsoluteBoundsTolerance: 0.01 },
    warnings: [],
  };
}

function validDecision() {
  return {
    schemaVersion: 1,
    rootNodeId: "R",
    snapshotHash: computeCleanupSnapshotHash(snapshot),
    tree: [
      { name: "Top", endExclusive: 2, children: [] },
      { name: "Bottom", endExclusive: 4, children: [] },
    ],
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

test("direct cleanup authorization executes immediately after planning", async () => {
  let executionCount = 0;
  const controller = createCleanupController({
    planner: fakePlanner(),
    executor: {
      async execute(request) {
        executionCount += 1;
        request.onProgress({ message: "running complete skill pipeline", state: "verifying" });
        return { state: "succeeded", report: { status: "completed" } };
      },
    },
  });

  const started = await controller.start({
    sessionId: "figma-direct",
    providerId: "codex",
    snapshot,
    autoApprove: true,
  });

  await controller.waitForPlanning(started.runId);
  await controller.waitForExecution(started.runId);

  const run = controller.get(started.runId, started.capabilityToken);
  assert.equal(executionCount, 1);
  assert.equal(run.state, "awaiting_component_confirmation");
  assert.equal(run.autoApproved, true);
  assert.match(run.output.map((entry) => entry.text).join("\n"), /direct cleanup authorization/i);
});

test("direct cleanup surfaces the exact transaction failure instead of a generic terminal state", async () => {
  const controller = createCleanupController({
    planner: fakePlanner(),
    executor: {
      async execute() {
        throw new Error("cleanup transaction state is failed: snapshot changed before apply");
      },
    },
  });

  const started = await controller.start({
    sessionId: "figma-transaction-failure",
    providerId: "codex",
    snapshot,
    autoApprove: true,
  });
  await controller.waitForPlanning(started.runId);
  await controller.waitForExecution(started.runId);

  const run = controller.get(started.runId, started.capabilityToken);
  assert.equal(run.state, "failed");
  assert.match(run.output.map((entry) => entry.text).join("\n"), /snapshot changed before apply/i);
});

test("direct cleanup waits for final satisfaction before creating ComponentSets", async () => {
  let hierarchyExecutions = 0;
  let componentSetExecutions = 0;
  const controller = createCleanupController({
    planner: fakePlanner(),
    executor: {
      async execute() {
        hierarchyExecutions += 1;
        return { state: "succeeded", report: { status: "completed" } };
      },
      async executeComponentSets() {
        componentSetExecutions += 1;
        return { state: "succeeded", report: { status: "completed" } };
      },
    },
  });

  const started = await controller.start({
    sessionId: "figma-final-confirmation",
    providerId: "codex",
    snapshot,
    autoApprove: true,
  });

  await controller.waitForPlanning(started.runId);
  await controller.waitForExecution(started.runId);

  const run = controller.get(started.runId, started.capabilityToken);
  assert.equal(hierarchyExecutions, 1);
  assert.equal(componentSetExecutions, 0);
  assert.equal(run.state, "awaiting_component_confirmation");
  assert.equal(run.endedAt, undefined);

  controller.confirmComponentSets(started.runId, started.capabilityToken, { satisfied: true });
  await controller.waitForExecution(started.runId);

  assert.equal(componentSetExecutions, 1);
  assert.equal(controller.get(started.runId, started.capabilityToken).state, "succeeded");
});

test("declined final satisfaction finishes without creating ComponentSets", async () => {
  let componentSetExecutions = 0;
  const controller = createCleanupController({
    planner: fakePlanner(),
    executor: {
      async execute() {
        return { state: "succeeded", report: { status: "completed" } };
      },
      async executeComponentSets() {
        componentSetExecutions += 1;
        return { state: "succeeded", report: { status: "completed" } };
      },
    },
  });
  const started = await controller.start({
    sessionId: "figma-declined-confirmation",
    providerId: "codex",
    snapshot,
    autoApprove: true,
  });

  await controller.waitForPlanning(started.runId);
  await controller.waitForExecution(started.runId);
  const result = controller.confirmComponentSets(started.runId, started.capabilityToken, {
    satisfied: false,
    feedback: "先调整分组",
  });

  assert.equal(componentSetExecutions, 0);
  assert.equal(result.state, "succeeded");
  assert.match(result.output.map((entry) => entry.text).join("\n"), /ComponentSet creation was skipped/i);
});

test("zero-operation cleanup completes without approval or executor", async () => {
  let executionCount = 0;
  const organizedSnapshot = {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => node.parentId === "R" ? { ...node, name: `[${node.name}]` } : node),
  };
  const noOpPlan = {
    ...validPlan(),
    snapshotHash: computeCleanupSnapshotHash(organizedSnapshot),
    operations: [],
  };
  const controller = createCleanupController({
    planner: fakePlanner(noOpPlan),
    executor: {
      async execute() {
        executionCount += 1;
        throw new Error("a no-op cleanup must not be executed");
      },
    },
  });
  const started = await controller.start({ sessionId: "figma-no-op", providerId: "claude-code", snapshot: organizedSnapshot });

  await controller.waitForPlanning(started.runId);

  const run = controller.get(started.runId, started.capabilityToken);
  assert.equal(run.state, "succeeded");
  assert.equal(run.planReady, true);
  assert.equal(run.planSummary?.operationCount, 0);
  assert.equal(executionCount, 0);
});

test("direct cleanup still executes the exact transaction when the AI plan has no operations", async () => {
  let executionCount = 0;
  const organizedSnapshot = {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => node.parentId === "R" ? { ...node, name: `[${node.name}]` } : node),
  };
  const noOpPlan = {
    ...validPlan(),
    snapshotHash: computeCleanupSnapshotHash(organizedSnapshot),
    operations: [],
  };
  const controller = createCleanupController({
    planner: fakePlanner(noOpPlan),
    executor: {
      async execute() {
        executionCount += 1;
        return { state: "succeeded", report: { status: "completed", autoComponentSets: {} } };
      },
    },
  });
  const started = await controller.start({
    sessionId: "figma-direct-no-op",
    providerId: "codex",
    snapshot: organizedSnapshot,
    autoApprove: true,
  });

  await controller.waitForPlanning(started.runId);
  await controller.waitForExecution(started.runId);

  assert.equal(executionCount, 1);
  assert.equal(controller.get(started.runId, started.capabilityToken).state, "awaiting_component_confirmation");
});

test("direct cleanup fails safely when the exact AI transaction plan is rejected", async () => {
  let executionCount = 0;
  const controller = createCleanupController({
    planner: {
      async plan() {
        throw new Error("清理操作 op-001 不允许单子节点分组");
      },
    },
    executor: {
      async execute() {
        executionCount += 1;
        return { state: "succeeded", report: { status: "completed" } };
      },
    },
  });

  const started = await controller.start({
    sessionId: "figma-direct-invalid-preflight",
    providerId: "codex",
    snapshot,
    autoApprove: true,
  });

  await controller.waitForPlanning(started.runId);
  await controller.waitForExecution(started.runId);

  const run = controller.get(started.runId, started.capabilityToken);
  assert.equal(executionCount, 0);
  assert.equal(run.state, "failed");
  assert.match(run.output.map((entry) => entry.text).join("\n"), /preliminary AI plan was rejected/i);
  assert.match(run.output.map((entry) => entry.text).join("\n"), /no unverified cleanup transaction was applied/i);
});

test("cleanup planner uses the selected provider and compiles only a skill decision", async () => {
  let selectedProvider = "";
  const planner = new CleanupPlanner(
    createPlanningProviderRegistry({ commandAvailable: () => true, commandVersion: () => undefined }),
    {
      async run(request) {
        selectedProvider = request.provider.id;
        assert.match(request.prompt, /Skill-constrained decision/i);
        assert.match(request.prompt, /Do not return node IDs/i);
        return `${CleanupSkillDecisionMarker}\n${JSON.stringify(validDecision())}`;
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
  assert.equal(result.plan.schemaVersion, 3);
  assert.equal(result.summary.operationCount, 2);
});

test("cleanup planner repairs one incomplete large semantic group before compiling a transaction", async () => {
  const largeSnapshot = {
    schemaVersion: 1,
    rootNodeId: "R",
    nodes: [
      { id: "R", parentId: "", type: "FRAME", name: "Root", siblingIndex: 0, depth: 0 },
      ...Array.from({ length: 18 }, (_, index) => ({
        id: `N-${index}`,
        parentId: "R",
        type: "FRAME",
        name: `Panel ${index}`,
        siblingIndex: index,
        depth: 1,
      })),
    ],
  };
  const snapshotHash = computeCleanupSnapshotHash(largeSnapshot);
  const incompleteDecision = {
    schemaVersion: 1,
    rootNodeId: "R",
    snapshotHash,
    tree: [{ name: "Panel Base Frames", endExclusive: 18, children: [] }],
    warnings: [],
  };
  const repairedDecision = {
    ...incompleteDecision,
    tree: [{
      name: "Panel Base Frames",
      endExclusive: 18,
      children: [
        { name: "Panel Header Frames", endExclusive: 6, children: [] },
        { name: "Panel Content Frames", endExclusive: 12, children: [] },
        { name: "Panel Footer Frames", endExclusive: 18, children: [] },
      ],
    }],
  };
  const prompts = [];
  const planner = new CleanupPlanner(
    createPlanningProviderRegistry({ commandAvailable: async () => true, commandVersion: async () => undefined }),
    {
      async run(request) {
        prompts.push(request.prompt);
        return `${CleanupSkillDecisionMarker}\n${JSON.stringify(prompts.length === 1 ? incompleteDecision : repairedDecision)}`;
      },
    },
  );

  const result = await planner.plan({
    runId: "run-large-group-repair",
    sessionId: "figma-large-group-repair",
    providerId: "claude-code",
    snapshot: largeSnapshot,
    signal: new AbortController().signal,
    onProgress: () => {},
  });

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Repair the previous semantic-only decision/i);
  assert.match(prompts[1], /Panel Base Frames/i);
  assert.equal(result.plan.operations.length, 4);
});

test("cleanup planning prompt follows the plugin hierarchy-cleanup skill contract", () => {
  const prompt = buildCleanupPlanV2ReviewTask(snapshot, "claude-code");
  assert.match(prompt, /complete semantic range tree/i);
  assert.match(prompt, /Do not return node IDs, parent IDs, childNodeIds, operation IDs/i);
  assert.match(prompt, /compiler-owned and cannot be overridden/i);
  assert.match(prompt, /Every level must partition its current direct child sequence completely, in original order/i);
  assert.match(prompt, /CLEANUP_SKILL_DECISION_JSON/);
  assert.doesNotMatch(prompt, /"operations"/i);
});

test("cleanup planning prompt preserves the skill's structural and visual-safety goals", () => {
  const prompt = buildCleanupPlanV2ReviewTask(snapshot, "claude-code");
  assert.match(prompt, /12 or more direct children must contain child ranges/i);
  assert.match(prompt, /preserve visual appearance, size, absolute position, and sibling stacking order/i);
  assert.match(prompt, /already organized only when[\s\S]{0,160}semantic container/i);
});

test("cleanup planning prompt supplies geometry and requires semantic group names", () => {
  const positionedSnapshot = {
    ...snapshot,
    nodes: snapshot.nodes.map((node, index) => ({ ...node, x: index * 10, y: index * 20, w: 100, h: 40 })),
  };
  const prompt = buildCleanupPlanV2ReviewTask(positionedSnapshot, "claude-code");
  assert.match(prompt, /semantic, production-readable group names/i);
  assert.match(prompt, /UI Layer Set/i);
  assert.match(prompt, /"x":10,"y":20,"width":100,"height":40/);
});

test("cleanup planner rejects an invalid skill decision without an AI repair retry", async () => {
  const prompts = [];
  const progress = [];
  const planner = new CleanupPlanner(
    createPlanningProviderRegistry({ commandAvailable: async () => true, commandVersion: async () => undefined }),
    {
      async run(request) {
        prompts.push(request.prompt);
        return "I think this hierarchy is already organized.";
      },
    },
  );

  await assert.rejects(
    planner.plan({
      runId: "run-repair",
      sessionId: "figma-repair",
      providerId: "claude-code",
      snapshot,
      signal: new AbortController().signal,
      onProgress: (value) => progress.push(value.message),
    }),
    /技能决策标记/,
  );

  assert.equal(prompts.length, 1);
  assert.ok(progress.some((message) => /Planning with/i.test(message)));
});

test("cleanup planner validates one fenced JSON plan without an AI format retry", async () => {
  let calls = 0;
  const planner = new CleanupPlanner(
    createPlanningProviderRegistry({ commandAvailable: async () => true, commandVersion: async () => undefined }),
    {
      async run() {
        calls += 1;
        return `${CleanupSkillDecisionMarker}\n\`\`\`json\n${JSON.stringify(validDecision())}\n\`\`\``;
      },
    },
  );

  const result = await planner.plan({
    runId: "run-fenced-plan",
    sessionId: "figma-fenced-plan",
    providerId: "claude-code",
    snapshot,
    signal: new AbortController().signal,
    onProgress: () => {},
  });

  assert.equal(calls, 1);
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

test("approved cleanup waits for final satisfaction before ComponentSets", async () => {
  const controller = createCleanupController({ planner: fakePlanner(), executor: fakeExecutor("succeeded") });
  const started = await controller.start({ sessionId: "figma-1", providerId: "claude-code", snapshot });
  await controller.waitForPlanning(started.runId);
  const approved = controller.approve(started.runId, started.capabilityToken, {
    approval: true,
    snapshotHash: computeCleanupSnapshotHash(snapshot),
  });
  assert.equal(approved.state, "applying");
  await controller.waitForExecution(started.runId);
  assert.equal(controller.get(started.runId, started.capabilityToken).state, "awaiting_component_confirmation");
});

test("cancelling review releases the session lock", async () => {
  const controller = createCleanupController({ planner: fakePlanner(), executor: fakeExecutor() });
  const first = await controller.start({ sessionId: "figma-1", providerId: "codex", snapshot });
  await controller.waitForPlanning(first.runId);
  assert.equal(controller.cancel(first.runId, first.capabilityToken).state, "cancelled");
  const second = await controller.start({ sessionId: "figma-1", providerId: "codex", snapshot });
  assert.notEqual(second.runId, first.runId);
});
