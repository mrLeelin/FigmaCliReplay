# Cleanup Module V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the transitional cleanup flow with a provider-agnostic, exact-plan, explicitly approved, observable, and rollback-capable cleanup workflow.

**Architecture:** A dedicated cleanup domain owns state and approval. AI CLI implementations sit behind a PlanningProvider interface and return one CleanupPlanV2 contract. The Figma side executes only confirmed operations inside one transaction job; componentization is excluded.

**Tech Stack:** TypeScript 5.8, Node.js 22, Node test runner, plain Figma Plugin JavaScript, Python 3.11+, existing relay HTTP/WebSocket transport.

---

## Execution constraints

- Work directly in `E:\Project\Tools\FigmaMcpRelay` as requested; do not create a worktree.
- Preserve unrelated dirty and staged changes, especially existing edits in `ui.html` and `tests/unity-project-ui.test.mjs`.
- Edit source fragments under `code/` and regenerate `code.js` with `python scripts/build.py`; do not hand-edit generated `code.js`.
- Use UTF-8 explicitly when reading or verifying Chinese text.
- Each task starts with a failing targeted test and ends with targeted tests plus `npm run typecheck`.
- Commits must use path-limited or partial staging and the repository Lore trailers.

## Locked file structure

Create:

- `src/ai/planningProvider.ts` — provider contract and availability/result types.
- `src/ai/providerRegistry.ts` — allowlisted provider discovery and selection.
- `src/ai/codexCliProvider.ts` — Codex CLI arguments and stream extraction.
- `src/ai/claudeCodeCliProvider.ts` — Claude Code CLI arguments and stream extraction.
- `src/cleanup/cleanupTypes.ts` — cleanup state, plan, operation, progress, and error types.
- `src/cleanup/cleanupRunStore.ts` — in-memory active-run ownership and cleanup.
- `src/cleanup/cleanupController.ts` — plan/approve/cancel lifecycle.
- `src/cleanup/cleanupPlanner.ts` — provider-independent prompt and common JSON validation.
- `src/cleanup/cleanupExecutor.ts` — exact-plan Python process and report handling.
- `code/08_cleanup_transaction.mjs` — Figma transaction apply, verify, and rollback.
- `ai/skills/figma-hierarchy-cleanup-mcp/scripts/apply_cleanup_plan.py` — thin exact-plan relay client.
- `tests/ai-planning-providers.test.mjs`
- `tests/cleanup-controller.test.mjs`
- `tests/cleanup-transaction.test.mjs`
- `tests/test_apply_cleanup_plan.py`
- `tests/fixtures/cleanup-snapshot-hash.json` — shared TypeScript/Figma hash parity fixture.

Modify:

- `src/cleanupPlan.ts` — CleanupPlanV2 extraction, hash, validation, and Figma-plan adapter.
- `src/localAiRunner.ts` — retain generic prompt runner; delegate cleanup lifecycle.
- `src/httpServer.ts` — provider and cleanup REST endpoints.
- `code/01_handlers.js` — provider preference messages and transaction dispatch.
- `code/04_hierarchy.js` — exclude recovery trees from prefab traversal.
- `code/05_utils.js` — exclude recovery trees from export and PSD-bound traversal.
- `code/06_psd_incremental.mjs` — ignore recovery-only backup trees.
- `code/07_cleanup_snapshot.mjs` — canonical snapshot fields and backup exclusion.
- `scripts/build.py` — concatenate the new transaction source.
- `ui.html` — provider selector, cleanup state rendering, approval, cancel, and recovery UI.
- Existing cleanup tests and docs to remove old session/resume and component-candidate assumptions.

### Task 1: Lock CleanupPlanV2 and idempotency gates

**Files:**
- Modify: `src/cleanupPlan.ts`
- Modify: `tests/cleanup-plan-contract.test.mjs`

- [ ] **Step 1: Write failing contract tests**

Add a V2 fixture and assertions:

~~~js
const v2Plan = {
  schemaVersion: 2,
  rootNodeId: "R",
  snapshotHash: computeCleanupSnapshotHash(snapshot),
  operations: [
    {
      id: "group-hud",
      type: "CREATE_GROUP",
      parentNodeId: "R",
      name: "HUD",
      childNodeIds: ["A", "B"],
    },
    {
      id: "group-actions",
      type: "CREATE_GROUP",
      parentNodeId: "R",
      name: "Actions",
      childNodeIds: ["C"],
    },
  ],
  preconditions: [],
  verification: { preserveAbsoluteBoundsTolerance: 0.01 },
  warnings: [],
};

test("validates an exact V2 hierarchy plan", () => {
  assert.deepEqual(validateCleanupPlanV2(v2Plan, snapshot), v2Plan);
});

test("rejects component writes and redundant wrappers", () => {
  assert.throws(
    () => validateCleanupPlanV2({ ...v2Plan, operations: [{ id: "x", type: "CREATE_COMPONENT" }] }, snapshot),
    /unsupported cleanup operation/i,
  );
  assert.throws(
    () => validateCleanupPlanV2({
      ...v2Plan,
      operations: [{
        id: "x",
        type: "CREATE_GROUP",
        parentNodeId: "R",
        name: "Background",
        childNodeIds: ["A"],
      }],
    }, {
      ...snapshot,
      nodes: snapshot.nodes.map((node) => node.id === "A" ? { ...node, name: "[Background]" } : node),
    }),
    /redundant wrapper|single-child group/i,
  );
});
~~~

- [ ] **Step 2: Run the contract test and verify failure**

Run:

~~~powershell
npm run build
node --test tests/cleanup-plan-contract.test.mjs
~~~

Expected: FAIL because `computeCleanupSnapshotHash` and `validateCleanupPlanV2` are not exported.

- [ ] **Step 3: Add V2 types and canonical hash**

Add to `src/cleanupPlan.ts`:

~~~ts
export type CleanupOperationV2 =
  | { id: string; type: "CREATE_GROUP"; parentNodeId: string; name: string; childNodeIds: string[] }
  | { id: string; type: "RENAME_NODE"; nodeId: string; name: string }
  | { id: string; type: "MOVE_NODE"; nodeId: string; parentNodeId: string; index: number }
  | { id: string; type: "REORDER_CHILDREN"; parentNodeId: string; childNodeIds: string[] }
  | {
      id: string;
      type: "SET_AUTO_LAYOUT";
      nodeId: string;
      layoutMode: "HORIZONTAL" | "VERTICAL";
      itemSpacing: number;
      paddingTop: number;
      paddingRight: number;
      paddingBottom: number;
      paddingLeft: number;
    };

export interface CleanupPlanV2 {
  schemaVersion: 2;
  rootNodeId: string;
  snapshotHash: string;
  operations: CleanupOperationV2[];
  preconditions: Array<{ nodeId: string; parentNodeId: string; siblingIndex: number }>;
  verification: { preserveAbsoluteBoundsTolerance: number };
  warnings: string[];
}

export function computeCleanupSnapshotHash(snapshotValue: unknown): string {
  const snapshot = normalizeSnapshot(snapshotValue);
  const canonical = snapshot.nodes.map((node) => ({
    id: node.id,
    parentId: node.parentId,
    siblingIndex: node.siblingIndex,
    type: node.type,
    name: node.name,
    x: node.x ?? null,
    y: node.y ?? null,
    width: node.width ?? null,
    height: node.height ?? null,
    characters: node.characters ?? null,
    layoutMode: node.layoutMode ?? null,
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
~~~

- [ ] **Step 4: Implement strict V2 validation and adapter**

`validateCleanupPlanV2` must:

- require schema 2, matching root, and matching snapshot hash;
- reject unknown operation types and duplicate operation IDs;
- reject Component/ComponentSet/Variant fields recursively;
- require all referenced nodes to exist in the snapshot;
- reject single-child `CREATE_GROUP` operations;
- reject a group whose normalized name equals its only existing semantic container;
- require every root direct child to appear exactly once across root `CREATE_GROUP` operations;
- preserve global sibling order;
- return `operations: []` as a valid no-op only when the root already has semantic containers.

Add `toFigmaCleanupTransactionPlan(plan, snapshot)` returning exactly:

~~~ts
{
  schemaVersion: 2,
  operation: "figma-hierarchy-cleanup-transaction",
  target: { nodeId: plan.rootNodeId, snapshotHash: plan.snapshotHash },
  operations: plan.operations,
  verification: plan.verification,
  createBackup: true,
}
~~~

- [ ] **Step 5: Run targeted verification**

Run:

~~~powershell
npm run build
node --test tests/cleanup-plan-contract.test.mjs
npm run typecheck
~~~

Expected: all commands exit 0.

### Task 2: Introduce provider-agnostic AI planning

**Files:**
- Create: `src/ai/planningProvider.ts`
- Create: `src/ai/providerRegistry.ts`
- Create: `src/ai/codexCliProvider.ts`
- Create: `src/ai/claudeCodeCliProvider.ts`
- Create: `tests/ai-planning-providers.test.mjs`
- Modify: `src/localAiRunner.ts`

- [ ] **Step 1: Write failing provider tests**

~~~js
test("registry exposes Codex and Claude Code without silently falling back", async () => {
  const registry = createPlanningProviderRegistry({
    commandAvailable: (command) => command === "codex",
  });
  assert.deepEqual((await registry.list()).map((item) => [item.id, item.available]), [
    ["codex", true],
    ["claude-code", false],
  ]);
  assert.equal((await registry.resolve("codex")).id, "codex");
  await assert.rejects(registry.resolve("missing"), /unknown planning provider/i);
  await assert.rejects(registry.resolve("claude-code"), /not available/i);
});

test("providers produce provider-specific arguments and common final text", () => {
  assert.match(codexProvider.buildArgs("E:\\relay", "prompt").join(" "), /exec --json/);
  assert.match(claudeCodeProvider.buildArgs("E:\\relay", "prompt").join(" "), /--output-format stream-json/);
  assert.equal(codexProvider.extractAssistantText({
    type: "item.completed",
    item: { type: "agent_message", text: "plan" },
  }), "plan");
  assert.equal(claudeCodeProvider.extractAssistantText({
    type: "result",
    result: "plan",
  }), "plan");
});
~~~

- [ ] **Step 2: Run the test and verify failure**

Run:

~~~powershell
npm run build
node --test tests/ai-planning-providers.test.mjs
~~~

Expected: FAIL because the provider modules do not exist.

- [ ] **Step 3: Implement the provider contract**

`planningProvider.ts` defines:

~~~ts
export type PlanningProviderId = "codex" | "claude-code";

export interface ProviderAvailability {
  id: PlanningProviderId;
  label: string;
  available: boolean;
  version?: string;
  reason?: string;
}

export interface PlanningProvider {
  readonly id: PlanningProviderId;
  readonly label: string;
  readonly command: string;
  buildArgs(workspace: string, prompt: string): string[];
  extractAssistantText(event: unknown): string;
  isTerminalEvent(event: unknown): "completed" | "failed" | null;
}
~~~

Implement Codex with `codex exec --json --sandbox workspace-write --disable hooks` and Claude Code with `claude -p --output-format stream-json --verbose --dangerously-skip-permissions`. Neither adapter exposes resume/session capability to cleanup.

- [ ] **Step 4: Implement the allowlisted registry**

`providerRegistry.ts` accepts an injectable command detector for tests, caches availability for five seconds, and exposes:

~~~ts
list(): Promise<ProviderAvailability[]>;
resolve(id: unknown): Promise<PlanningProvider>;
refresh(): void;
~~~

Unknown IDs and unavailable commands throw stable errors. No method performs fallback.

- [ ] **Step 5: Keep generic AI behavior compatible**

Update `localAiRunner.ts` so generic Unity/component prompt tasks still use the existing configured runner, while cleanup planning receives an explicit Provider object. Reuse the common spawn and stream wiring functions; do not copy process-tree code into each adapter.

- [ ] **Step 6: Verify**

Run:

~~~powershell
npm run build
node --test tests/ai-planning-providers.test.mjs tests/local-ai-runner-lifecycle.test.mjs
npm run typecheck
~~~

Expected: all commands exit 0.

### Task 3: Add one cleanup controller and one state machine

**Files:**
- Create: `src/cleanup/cleanupTypes.ts`
- Create: `src/cleanup/cleanupRunStore.ts`
- Create: `src/cleanup/cleanupPlanner.ts`
- Create: `src/cleanup/cleanupController.ts`
- Create: `tests/cleanup-controller.test.mjs`
- Modify: `src/localAiRunner.ts`

- [ ] **Step 1: Write failing lifecycle tests**

~~~js
test("cleanup reaches review without an AI session id", async () => {
  const controller = createController({
    planner: fakePlanner(validPlan),
    executor: fakeExecutor(),
  });
  const started = await controller.start({
    sessionId: "figma-1",
    providerId: "codex",
    snapshot,
  });
  await controller.waitForPlanning(started.runId);
  const run = controller.get(started.runId, started.capabilityToken);
  assert.equal(run.state, "review");
  assert.equal(run.planReady, true);
  assert.equal("cliSessionId" in run, false);
});

test("one plugin session cannot enqueue a hidden second cleanup", async () => {
  const controller = createController({ planner: pendingPlanner(), executor: fakeExecutor() });
  await controller.start({ sessionId: "figma-1", providerId: "codex", snapshot });
  await assert.rejects(
    controller.start({ sessionId: "figma-1", providerId: "claude-code", snapshot }),
    /CLEANUP_ALREADY_RUNNING/,
  );
});

test("approval requires review state, token, hash, and explicit approval", async () => {
  const run = await readyRun();
  await assert.rejects(run.controller.approve(run.runId, run.token, { approval: false }), /explicit/i);
  await assert.rejects(
    run.controller.approve(run.runId, run.token, { approval: true, snapshotHash: "stale" }),
    /SNAPSHOT_CHANGED/,
  );
});
~~~

- [ ] **Step 2: Run tests and verify failure**

Run:

~~~powershell
npm run build
node --test tests/cleanup-controller.test.mjs
~~~

Expected: FAIL because the cleanup controller does not exist.

- [ ] **Step 3: Implement cleanup state and run storage**

`cleanupTypes.ts` defines the single state union:

~~~ts
export type CleanupState =
  | "capturing"
  | "planning"
  | "validating"
  | "review"
  | "applying"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "rolled_back"
  | "recovery_required";
~~~

`CleanupRunStore` owns:

- run lookup by capability token;
- a plugin-session lock and root-node lock;
- bounded output with sequence numbers;
- terminal-run expiry;
- no persistence-based resume.

- [ ] **Step 4: Implement planner and controller**

`CleanupPlanner` builds the common read-only prompt, asks the selected Provider for one marked V2 JSON object, then calls `extractCleanupPlan` and `validateCleanupPlanV2`.

`CleanupController` exposes:

~~~ts
start(request: StartCleanupRequest): Promise<StartCleanupResponse>;
get(runId: string, token: string, afterSequence?: number): CleanupRunView;
approve(runId: string, token: string, request: ApproveCleanupRequest): Promise<CleanupRunView>;
cancel(runId: string, token: string): Promise<CleanupRunView>;
stopForSession(sessionId: string, reason: string): number;
~~~

Transitions are checked through one `transition(run, expected, next)` helper. Approval never checks Provider session metadata.

- [ ] **Step 5: Delegate old cleanup exports**

Keep compatibility exports in `localAiRunner.ts` temporarily, but make `runLocalAiCleanup`, cleanup status, approval, and stop call the new controller. Generic prompt followup remains unchanged.

- [ ] **Step 6: Verify**

Run:

~~~powershell
npm run build
node --test tests/cleanup-controller.test.mjs tests/local-ai-cleanup-plan.test.mjs
npm run typecheck
~~~

Expected: all commands exit 0.

### Task 4: Publish provider and cleanup HTTP APIs

**Files:**
- Modify: `src/httpServer.ts`
- Create: `tests/cleanup-http.test.mjs`
- Modify: `tests/local-ai-cleanup-plan.test.mjs`

- [ ] **Step 1: Write failing route tests**

Add source-contract tests for the exact routes and controller calls:

~~~js
test("HTTP exposes provider discovery and dedicated cleanup actions", () => {
  const source = fs.readFileSync(new URL("../src/httpServer.ts", import.meta.url), "utf8");
  assert.match(source, /GET.*\/ai-runner\/providers|pathname === "\/ai-runner\/providers"/s);
  assert.match(source, /pathname === "\/cleanup\/runs"/);
  assert.match(source, /\/cleanup\/runs\/\(\[\^\/\]\+\)\/\(approve\|cancel\)/);
  assert.match(source, /cleanupController\.start/);
  assert.match(source, /cleanupController\.approve/);
  assert.match(source, /cleanupController\.cancel/);
});
~~~

- [ ] **Step 2: Run tests and verify failure**

Run:

~~~powershell
npm run build
node --test tests/cleanup-http.test.mjs
~~~

Expected: FAIL because dedicated routes are absent.

- [ ] **Step 3: Implement routes**

Add:

~~~text
GET  /ai-runner/providers
POST /cleanup/runs
GET  /cleanup/runs/:runId
POST /cleanup/runs/:runId/approve
POST /cleanup/runs/:runId/cancel
~~~

Reuse live Figma session checks for start. Run access uses `X-AI-Run-Capability`. Unknown Provider IDs return 400, invalid capability returns 403, and duplicate active cleanup returns 409.

Keep old cleanup endpoints as compatibility shims that call the controller and add a deprecation log entry.

- [ ] **Step 4: Verify**

Run:

~~~powershell
npm run build
node --test tests/cleanup-http.test.mjs tests/local-ai-cleanup-plan.test.mjs
npm run typecheck
~~~

Expected: all commands exit 0.

### Task 5: Make Provider choice explicit in the plugin UI

**Files:**
- Modify: `code/01_handlers.js`
- Modify: `ui.html`
- Modify: `tests/cleanup-plan-ui.test.mjs`
- Create: `tests/cleanup-provider-storage.test.mjs`

- [ ] **Step 1: Write failing UI/storage tests**

~~~js
test("cleanup approval is independent from provider session resumption", () => {
  assert.match(ui, /run\.state === "review"/);
  assert.match(ui, /run\.planReady === true/);
  assert.doesNotMatch(ui, /cleanupApprovalReady[\s\S]{0,200}sessionAvailable/);
});

test("provider preference uses plugin clientStorage", () => {
  const handlers = fs.readFileSync(new URL("../code/01_handlers.js", import.meta.url), "utf8");
  assert.match(handlers, /figma\.clientStorage\.getAsync\("cleanup\.preferredPlanningProvider"\)/);
  assert.match(handlers, /figma\.clientStorage\.setAsync\("cleanup\.preferredPlanningProvider"/);
});
~~~

- [ ] **Step 2: Run tests and verify failure**

Run:

~~~powershell
node --test tests/cleanup-plan-ui.test.mjs tests/cleanup-provider-storage.test.mjs
~~~

Expected: FAIL because cleanup still depends on `sessionAvailable` and no clientStorage handlers exist.

- [ ] **Step 3: Add provider preference messages**

Handle:

~~~text
GET_CLEANUP_PROVIDER_PREFERENCE
SET_CLEANUP_PROVIDER_PREFERENCE
~~~

Only accept `codex` and `claude-code`. Read/write `cleanup.preferredPlanningProvider` through `figma.clientStorage` and post a result message back to the UI.

- [ ] **Step 4: Update UI behavior**

The UI:

- loads `/ai-runner/providers`;
- renders availability, version, and reason;
- restores the stored provider selection;
- sends `providerId` with `POST /cleanup/runs`;
- never silently changes Provider;
- enables approval only for `state === "review" && planReady === true`;
- shows all exact operations and no component-candidate preview;
- keeps polling after transient failures instead of unlocking a still-running task;
- reopens the same review run after repeated clicks.

- [ ] **Step 5: Verify UI syntax and tests**

Run:

~~~powershell
node --test tests/cleanup-plan-ui.test.mjs tests/cleanup-provider-storage.test.mjs
npm run typecheck
~~~

Expected: all commands exit 0 and `new Function` can parse the UI script.

### Task 6: Replace the broad Python pipeline with exact-plan apply

**Files:**
- Create: `ai/skills/figma-hierarchy-cleanup-mcp/scripts/apply_cleanup_plan.py`
- Create: `tests/test_apply_cleanup_plan.py`
- Create: `src/cleanup/cleanupExecutor.ts`
- Modify: `tests/local-ai-cleanup-plan.test.mjs`

- [ ] **Step 1: Write failing Python and TypeScript tests**

~~~python
def test_build_job_contains_only_confirmed_plan(tmp_path):
    plan = {
        "schemaVersion": 2,
        "operation": "figma-hierarchy-cleanup-transaction",
        "target": {"nodeId": "R", "snapshotHash": "abc"},
        "operations": [],
        "verification": {"preserveAbsoluteBoundsTolerance": 0.01},
        "createBackup": True,
    }
    job = build_transaction_job(plan, "figma-session")
    assert job["type"] == "FIGMA_HIERARCHY_CLEANUP_TRANSACTION"
    assert job["plan"] == plan
    assert "autoComponentSets" not in str(job)
    assert "autoNestedGeneric" not in str(job)
~~~

Add a Node assertion that `buildCleanupApplyProcess` points to `apply_cleanup_plan.py` and contains neither `--auto-component-sets` nor `--auto-nested-generic`.

- [ ] **Step 2: Run tests and verify failure**

Run:

~~~powershell
python -B tests/test_apply_cleanup_plan.py
npm run build
node --test tests/local-ai-cleanup-plan.test.mjs
~~~

Expected: FAIL because the thin script does not exist and the old flags remain.

- [ ] **Step 3: Implement the thin script**

`apply_cleanup_plan.py`:

- parses `--session-id`, `--plan`, `--output`, and `--timeout`;
- validates the plan is schema 2 and transaction operation;
- submits exactly one `FIGMA_HIERARCHY_CLEANUP_TRANSACTION` job through the existing relay client;
- writes structured JSON progress lines;
- writes one report with `status`, `state`, `checks`, `rollback`, and `errors`;
- exits nonzero unless final state is `succeeded` or `rolled_back`.

- [ ] **Step 4: Implement CleanupExecutor**

Spawn the thin script, parse each JSON line as progress, use a 120-second apply timeout and 60-second graceful-cancel allowance, then validate the report. Do not use the AI Provider or Provider session data in this class.

- [ ] **Step 5: Verify**

Run:

~~~powershell
python -B tests/test_apply_cleanup_plan.py
npm run build
node --test tests/local-ai-cleanup-plan.test.mjs tests/cleanup-controller.test.mjs
npm run typecheck
~~~

Expected: all commands exit 0.

### Task 7: Add one Figma transaction with rollback

**Files:**
- Create: `code/08_cleanup_transaction.mjs`
- Modify: `code/01_handlers.js`
- Modify: `scripts/build.py`
- Create: `tests/cleanup-transaction.test.mjs`
- Modify: `tests/hierarchy-cleanup-apply.test.mjs`

- [ ] **Step 1: Write failing pure rollback tests**

Export pure helpers from the module and test:

~~~js
test("rollback restores parents, indices, names, and removes created groups", async () => {
  const fixture = createTransactionFixture();
  const journal = captureCleanupRollbackJournal(fixture.root, fixture.plan);
  await mutateFixture(fixture);
  await rollbackCleanupTransaction(journal);
  assert.deepEqual(fixture.root.children.map((node) => node.id), ["A", "B", "C"]);
  assert.equal(fixture.nodes.A.name, "A");
  assert.equal(fixture.createdGroup.removed, true);
});
~~~

- [ ] **Step 2: Run tests and verify failure**

Run:

~~~powershell
node --test tests/cleanup-transaction.test.mjs
~~~

Expected: FAIL because the transaction module does not exist.

- [ ] **Step 3: Implement transaction preflight and journal**

Before mutation:

- resolve the root and all referenced nodes;
- recompute the canonical structural hash;
- reject mismatch with `SNAPSHOT_CHANGED`;
- capture parent, index, name, bounds, and supported layout fields;
- create a hidden, locked sibling backup named `__cleanup_backup__<runId>`.

- [ ] **Step 4: Execute exact operations and verify**

Implement all V2 operation types through a switch with an exhaustive `never` check. Emit progress after every operation. Verification checks root bounds, original-node bounds, child coverage/order, semantic errors, and unchanged PSD SharedPluginData.

- [ ] **Step 5: Roll back on failure or cancellation**

On error, failed verification, or `cancelRequested`:

- stop before the next operation;
- reverse journal entries;
- restore original child order;
- remove created nodes;
- verify restoration;
- return `rolled_back` when successful;
- retain the backup and return `recovery_required` when restoration fails.

- [ ] **Step 6: Register and build**

Add `08_cleanup_transaction.mjs` after `07_cleanup_snapshot.mjs` in `scripts/build.py` and dispatch `FIGMA_HIERARCHY_CLEANUP_TRANSACTION` in `code/01_handlers.js`.

- [ ] **Step 7: Verify**

Run:

~~~powershell
node --test tests/cleanup-transaction.test.mjs tests/hierarchy-cleanup-apply.test.mjs
python scripts/build.py
npm run typecheck
~~~

Expected: tests exit 0 and `code.js` contains the transaction handler once.

### Task 8: Recovery exclusions, legacy removal, and end-to-end verification

**Files:**
- Modify: `code/04_hierarchy.js`
- Modify: `code/05_utils.js`
- Modify: `code/06_psd_incremental.mjs`
- Modify: `code/07_cleanup_snapshot.mjs`
- Modify: `ui.html`
- Modify: cleanup tests and lifecycle tests
- Modify: `docs/superpowers/specs/2026-07-17-cleanup-plan-performance-design.md`
- Modify: user-facing cleanup documentation

- [ ] **Step 1: Write failing backup-exclusion tests**

~~~js
test("backup descendants are excluded from snapshots and PSD incremental matching", () => {
  const backup = fakeNode({ name: "__cleanup_backup__run-1", visible: false });
  const source = fakeNode({ id: "PSD-A", parent: backup });
  assert.equal(isCleanupRecoveryNode(source), true);
  assert.equal(collectCleanupSnapshotNodes(backup, limits).length, 0);
  assert.equal(isPsdIncrementalCandidate(source), false);
});
~~~

- [ ] **Step 2: Implement exclusions and recovery detection**

Add one shared ancestry predicate based on the reserved backup-root prefix:

```js
export function isCleanupRecoveryNode(node) {
  let current = node || null;
  while (current) {
    if (typeof current.name === "string" && current.name.startsWith("__cleanup_backup__")) return true;
    current = current.parent || null;
  }
  return false;
}
```

Use it from `collectFigmaPrefabNodes` in `code/04_hierarchy.js`, `collectPsdBoundNodes` and `collectHierarchyExportNode` in `code/05_utils.js`, PSD incremental discovery, cleanup snapshots, and new cleanup starts. UI displays restore/delete/defer choices when the plugin reports an orphaned backup.

- [ ] **Step 3: Remove transitional behavior**

Delete:

- cleanup use of `CleanupRunPhase` plus `RunStatus` combinations;
- cleanup `sessionAvailable`/`cliSessionId` checks;
- `buildCleanupApplyInstruction`;
- old cleanup followup path after compatibility tests migrate;
- auto-component and post-approval auto-nested flags;
- component-candidate cleanup preview;
- dead source-regex tests that assert the old architecture.

Keep generic prompt followup for non-cleanup templates.

- [ ] **Step 4: Run the complete automated suite**

Run:

~~~powershell
npm run build
npm run typecheck
node --test tests/*.test.mjs
python -B tests/test_apply_cleanup_plan.py
python scripts/build.py
git diff --check
~~~

Expected: all commands exit 0; Chinese-source scan finds no replacement characters, escaped Unicode, `???`, or mojibake introduced by this work.

- [ ] **Step 5: Package and live-smoke the plugin**

Run:

~~~powershell
npm run package:release
~~~

Restart the local relay service, verify `/health` reports `status: ok` and `plugin.connected: true`, then use one disposable 50-100 node selection to record:

- selected Provider and version;
- snapshot, planning, validation, apply, and verify duration;
- exact preview-to-execution equality;
- second-run no-op;
- cancellation rollback;
- injected failure rollback.

- [ ] **Step 6: Final narrow review**

Confirm:

- no Component/ComponentSet operation is present;
- no automatic Provider fallback exists;
- no old cleanup run remains resumable after service restart;
- no recovery backup participates in PSD incremental update or Unity export;
- unrelated dirty files remain preserved.

Commit each completed scope with Lore trailers and report any live Figma behavior that could not be exercised.

## Self-review coverage map

- Provider abstraction, availability, explicit UI choice, and no fallback: Tasks 2 and 5.
- One cleanup state machine, concurrency ownership, approval, and cancellation: Tasks 3 and 4.
- Exact CleanupPlanV2 preview/execution contract and no componentization: Tasks 1 and 6.
- Snapshot freshness, idempotency, semantic gates, and second-run no-op: Tasks 1 and 7.
- Transaction journal, verification, rollback, and crash recovery backup: Tasks 7 and 8.
- No persistent custom Figma node mapping and no resumable plan authority after restart: Tasks 3, 4, and 8.
- Backup exclusion from PSD incremental update and Unity export: Task 8.
- Performance, packaging, live Provider coverage, and failure injection: Task 8.

No approved design requirement is intentionally deferred outside this plan. Hard-crash recovery retains the documented limitation that replacing a damaged root from a clone can change Figma node IDs.
