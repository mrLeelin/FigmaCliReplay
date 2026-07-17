# Figma Cleanup Plan Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 8-14 minute interactive cleanup PlanReview with one bounded Figma subtree snapshot and one validated structured plan, while preserving the explicit approval gate and the existing deterministic apply/verify pipeline.

**Architecture:** The Figma plugin captures a compact, read-only snapshot of the selected root and posts it to the gateway. The gateway asks the local AI for exactly one marked JSON plan, validates it against the immutable snapshot, writes both the public plan and an adapter plan for the existing `run_cleanup_pipeline.py --plan` contract, and exposes a preview to the UI. Only an explicit cleanup approval starts a resumable follow-up turn that reads the full cleanup skill and runs the existing apply/verify pipeline.

**Tech Stack:** Figma Plugin API JavaScript, browser JavaScript in `ui.html`, Node.js 22, TypeScript 5.8, Node test runner, Python 3 cleanup pipeline, PowerShell packaging/runtime scripts.

---

## Preconditions and scope guard

- Work directly in `E:\Project\Tools\FigmaMcpRelay` on `main`; do not create a worktree.
- Preserve the user's currently staged changes in `ui.html` and `tests/unity-project-ui.test.mjs`, and preserve `.playwright-cli/` as untracked user data.
- Treat the existing uncommitted lifecycle changes in `src/localAiRunner.ts` and `tests/local-ai-runner-lifecycle.test.mjs` as Task 1 input, not unrelated dirt.
- Before every commit, run `git diff --cached --name-status` and ensure only that task's intended paths are staged.
- Every commit must use the repository Lore trailers shown below. Do not push unless the user explicitly asks.
- For the first implementation slice, the structured `groups` contract covers the selected root's **direct children**. Nested generic cleanup remains the responsibility of the existing `--auto-nested-generic` pipeline after approval. This keeps the apply engine unchanged and makes the structured plan directly convertible to its proven root-plan schema.
- Snapshot limits are fixed at 500 nodes, depth 12, 256 text characters per text node, and 256 KiB serialized JSON. Exceeding any limit fails before the AI process is started.

## Task 1: Land the process-lifecycle prerequisite

**Files:**

- Modify: `src/localAiRunner.ts`
- Create: `tests/local-ai-runner-lifecycle.test.mjs`

- [ ] **Step 1: Run the focused lifecycle tests against the current uncommitted implementation**

Run:

```powershell
npm run build
node --test tests/local-ai-runner-lifecycle.test.mjs
```

Expected: 3 tests pass, proving Claude `result` is terminal, cleanup has a 5-minute total/90-second idle bound, and PlanReview is read-only/single-agent.

- [ ] **Step 2: Verify the process tree is terminated on terminal result, timeout, stop, and disconnect paths**

Confirm the implementation keeps these invariants:

```ts
export function classifyClaudeTerminalEvent(value: unknown): "completed" | "failed" | null;

export function localAiTimeoutPolicy(taskKind: string) {
  return taskKind === "cleanup"
    ? { totalMs: 5 * 60 * 1000, idleMs: 90 * 1000 }
    : { totalMs: 30 * 60 * 1000, idleMs: 5 * 60 * 1000 };
}
```

`finishTerminalStreamEvent`, timeout failure, `stopAiRun`, and `stopAiRunsForSession` must all reach the existing `terminateChild` process-tree kill path and call `finalise` once.

- [ ] **Step 3: Run regression checks**

Run:

```powershell
npm run typecheck
node --test tests/local-ai-runner-lifecycle.test.mjs tests/unity-task-snapshot.test.mjs
git diff --check -- src/localAiRunner.ts tests/local-ai-runner-lifecycle.test.mjs
```

Expected: all checks pass and `git diff --check` is silent.

- [ ] **Step 4: Commit only the lifecycle prerequisite**

```powershell
git add src/localAiRunner.ts tests/local-ai-runner-lifecycle.test.mjs
git diff --cached --name-status
git commit -m "Bound cleanup planning before the optimization path" -m "Constraint: Claude result events must stop the Windows child process tree immediately.
Rejected: Relying on CLI process exit alone | the observed stream stayed alive after emitting its result.
Confidence: high
Scope-risk: narrow
Directive: Keep cleanup timeouts task-specific and clear them on every terminal path.
Tested: npm run typecheck; node --test tests/local-ai-runner-lifecycle.test.mjs tests/unity-task-snapshot.test.mjs
Not-tested: Live timeout wait was not exercised at full five-minute duration."
```

Expected staged scope before commit: only the two Task 1 paths.

## Task 2: Capture one compact cleanup snapshot in the Figma plugin

**Files:**

- Create: `code/07_cleanup_snapshot.mjs`
- Modify: `code/01_handlers.js`
- Modify: `scripts/build.py`
- Create: `tests/cleanup-snapshot.test.mjs`

- [ ] **Step 1: Write failing pure snapshot tests**

Create fake Figma nodes with `id`, `parent`, `children`, bounds, text, fills, and `getSharedPluginData`. Test that `buildCleanupSnapshot(root)`:

- visits root and descendants exactly once in pre-order;
- records `id`, `parentId`, `type`, `name`, `siblingIndex`, `depth`, `x`, `y`, `w`, `h`, `visible`, `opacity`, `childCount`, and truncated text characters;
- records role flags for image, nine-slice, component, and PSD source;
- whitelists PSD identity fields only: `psdLayerId`, `psdOwnership`, `psdContentHash`, `rawPsdLayerName`, `psdSourceFileName`, `psdSourceKey`, and `psdLayerSetFingerprint`;
- never serializes fills, image bytes, image hashes, absolute paths, tokens, or arbitrary plugin data;
- throws `cleanup snapshot exceeds 500 nodes`, `cleanup snapshot exceeds depth 12`, or `cleanup snapshot exceeds 262144 bytes` before returning an oversized payload.

Run:

```powershell
node --test tests/cleanup-snapshot.test.mjs
```

Expected: fail because `code/07_cleanup_snapshot.mjs` does not exist.

- [ ] **Step 2: Implement the pure snapshot builder**

Use this public shape:

```js
export const CleanupSnapshotLimits = Object.freeze({
  maxNodes: 500,
  maxDepth: 12,
  maxTextCharacters: 256,
  maxBytes: 256 * 1024
});

export function buildCleanupSnapshot(root, limits = CleanupSnapshotLimits) {
  return {
    schemaVersion: 1,
    rootNodeId: root.id,
    capturedAt: new Date().toISOString(),
    limits,
    nodes: collectCompactNodes(root, limits)
  };
}
```

Use the shared namespace string `psd_layer_to_figma_bridge` and read only the explicit PSD keys above. For image role detection, emit a boolean from paint type without including `imageHash`. For component role, treat `COMPONENT`, `COMPONENT_SET`, and `INSTANCE` as component-related. Reuse the existing nine-slice naming/metadata semantics, but keep the new module independent enough to import from Node tests.

- [ ] **Step 3: Add the read-only plugin command**

In `code/01_handlers.js`, route `QUERY_CLEANUP_SNAPSHOT` to a new handler. It must:

1. require exactly one selected root;
2. require a supported container (`FRAME`, `COMPONENT`, `COMPONENT_SET`, or `INSTANCE`);
3. call `buildCleanupSnapshot(selection[0])` exactly once;
4. post `QUERY_CLEANUP_SNAPSHOT_RESULT` with `{status: "completed", snapshot}`;
5. post `{status: "error", errors: [...]}` on limit or selection errors;
6. perform no Figma write and no relay/MCP request.

Add `07_cleanup_snapshot.mjs` to the end of `ORDER` in `scripts/build.py`. Function declarations remain callable from `code/01_handlers.js` after concatenation.

- [ ] **Step 4: Prove the builder and plugin contract**

Run:

```powershell
node --test tests/cleanup-snapshot.test.mjs
python scripts/build.py
node --check code.js
```

Expected: snapshot tests pass; build output lists `07_cleanup_snapshot.mjs`; `node --check` is silent.

- [ ] **Step 5: Commit the snapshot slice**

```powershell
git add code/07_cleanup_snapshot.mjs code/01_handlers.js scripts/build.py tests/cleanup-snapshot.test.mjs code.js .build_version
git diff --cached --name-status
git commit -m "Give cleanup planning one bounded source of truth" -m "Constraint: PlanReview must not traverse the Figma tree interactively.
Rejected: Reusing the broad export manifest | it carries fields the planner does not need and increases prompt size.
Confidence: high
Scope-risk: moderate
Directive: Keep snapshot fields whitelisted and fail before AI launch when limits are exceeded.
Tested: node --test tests/cleanup-snapshot.test.mjs; python scripts/build.py; node --check code.js
Not-tested: Live Figma snapshot timing is deferred to final verification."
```

## Task 3: Define and validate the structured cleanup-plan contract

**Files:**

- Create: `src/cleanupPlan.ts`
- Create: `tests/cleanup-plan-contract.test.mjs`

- [ ] **Step 1: Write failing extraction and validation tests**

Cover:

- exactly one `[CLEANUP_PLAN_JSON]` marker followed by one JSON object;
- malformed JSON, missing marker, and two markers;
- root mismatch;
- foreign node IDs;
- duplicate source IDs across groups;
- a source whose `parentId` does not match its group;
- group sources not in original sibling order;
- incomplete or extra root-direct-child coverage;
- non-root `parentNodeId` in this first implementation slice;
- `componentCandidates` referencing only snapshot nodes;
- warnings as display-only strings;
- unknown fields ignored rather than forwarded;
- mutation/result fields such as `applied`, `commands`, or `toolCalls` rejected.

Run:

```powershell
npm run build
node --test tests/cleanup-plan-contract.test.mjs
```

Expected: fail because `dist/cleanupPlan.js` does not exist.

- [ ] **Step 2: Implement strict parsing and normalization**

Export these APIs:

```ts
export const CleanupPlanMarker = "[CLEANUP_PLAN_JSON]";

export interface CleanupPlanV1 {
  schemaVersion: 1;
  rootNodeId: string;
  groups: Array<{
    name: string;
    parentNodeId: string;
    sourceNodeIds: string[];
    preserveSiblingOrder: true;
  }>;
  componentCandidates: Array<{
    name: string;
    sourceNodeIds: string[];
    reason?: string;
  }>;
  warnings: string[];
}

export function extractCleanupPlan(text: string): unknown;
export function validateCleanupPlan(plan: unknown, snapshot: unknown): CleanupPlanV1;
export function toPipelineRootPlan(plan: CleanupPlanV1, snapshot: CleanupSnapshotV1): object;
```

Validation must index snapshot nodes once with `Map`, compare root direct-child IDs in original `siblingIndex` order, and require every root direct child exactly once across `groups`. Normalize group names to the existing bracket form only in `toPipelineRootPlan`, not in the public preview.

- [ ] **Step 3: Adapt to the existing deterministic pipeline schema**

`toPipelineRootPlan` must emit the current apply contract:

```ts
{
  schemaVersion: 1,
  operation: "figma-hierarchy-cleanup",
  target: { nodeId: plan.rootNodeId },
  options: {
    preserveAbsoluteBoundsTolerance: 0.01,
    createGroupType: "FRAME",
    renameOriginalNodes: false,
    allowVisualChanges: false
  },
  groups: plan.groups.map(group => ({
    name: `[${group.name.replace(/^\[|\]$/g, "")}]`,
    childNodeIds: group.sourceNodeIds,
    sourceIndices: group.sourceNodeIds.map(id => snapshotIndex.get(id).siblingIndex)
  })),
  warnings: plan.warnings,
  blockingErrors: []
}
```

Do not add a second apply engine. The generated object must satisfy the existing Figma-side `validateHierarchyCleanupPlan` node-conservation and group-name rules.

- [ ] **Step 4: Run contract verification**

```powershell
npm run typecheck
npm run build
node --test tests/cleanup-plan-contract.test.mjs
```

Expected: all contract tests pass.

- [ ] **Step 5: Commit the contract**

```powershell
git add src/cleanupPlan.ts tests/cleanup-plan-contract.test.mjs
git diff --cached --name-status
git commit -m "Make AI cleanup output a validated execution contract" -m "Constraint: Existing Figma apply and verification semantics must remain unchanged.
Rejected: Accepting prose plans | prose cannot prove node membership, uniqueness, or sibling order.
Confidence: high
Scope-risk: moderate
Directive: Never treat unknown AI fields as apply authority.
Tested: npm run typecheck; node --test tests/cleanup-plan-contract.test.mjs
Not-tested: End-to-end CLI output extraction is covered in the runner integration task."
```

## Task 4: Integrate structured PlanReview into the local AI runner

**Files:**

- Modify: `src/localAiRunner.ts`
- Modify: `src/httpServer.ts`
- Create: `tests/local-ai-cleanup-plan.test.mjs`

- [ ] **Step 1: Write failing runner integration tests**

Test exported pure helpers and source-level route behavior for:

- cleanup requires `{sessionId, snapshot}` rather than the old root-only `{selection}`;
- the initial task contains the compact schema and `[CLEANUP_PLAN_JSON]` marker;
- the initial task does not contain `figma-hierarchy-cleanup-mcp/SKILL.md`, `run_cleanup_pipeline.py`, or permission to write;
- Claude final `result.result` and Codex final agent-message text are captured as assistant output;
- a successful terminal event only becomes `completed` after plan extraction/validation and file persistence;
- missing/invalid plan changes the run to `failed`, terminates the process tree, and does not retry;
- `cleanup-plan.json` and `cleanup-pipeline-plan.json` are written under the run directory;
- `getAiRun` exposes `phase`, `planSummary`, and `planReady`, never the full snapshot or capability token.

Run:

```powershell
npm run build
node --test tests/local-ai-cleanup-plan.test.mjs
```

Expected: fail on missing structured-plan integration.

- [ ] **Step 2: Replace the initial full-skill prompt with a compact prompt**

Move prompt construction to an exported pure helper:

```ts
export function buildCleanupPlanReviewTask(snapshot: CleanupSnapshotV1): string {
  return [
    "# Figma cleanup PlanReview",
    "This turn is read-only. Do not call tools, MCP, pipeline scripts, or subagents.",
    "Use only the supplied snapshot. Return exactly one marked JSON plan, then stop.",
    compactGroupingRules(),
    cleanupPlanJsonSchemaText(),
    CleanupPlanMarker,
    "<one JSON object>",
    "## Snapshot",
    JSON.stringify(snapshot)
  ].join("\n");
}
```

The compact rules must retain node conservation, sibling order, absolute-bound preservation, mask/nine-slice safety, PSD SharedPluginData preservation, ComponentSet candidate reporting, no guessing, and the three-minute target. They must prohibit Figma reads because the complete snapshot is already present.

- [ ] **Step 3: Store immutable cleanup-run state**

Extend `AiRun` with:

```ts
cleanupSnapshot?: CleanupSnapshotV1;
cleanupPlan?: CleanupPlanV1;
cleanupPlanPath?: string;
cleanupPipelinePlanPath?: string;
assistantText: string;
phase?: "planning" | "validating" | "awaiting-approval" | "applying" | "verifying";
```

Write snapshot metadata into `task.json`, but never return the full snapshot from `getAiRun`. Persist plans with UTF-8 JSON under the existing run directory.

- [ ] **Step 4: Validate before finalizing the initial cleanup turn**

Refactor terminal handling so initial cleanup completion follows this order:

1. mark phase `validating`;
2. extract exactly one marker payload from `assistantText`;
3. validate it against `cleanupSnapshot`;
4. write both plan files;
5. set phase `awaiting-approval` and `planReady = true`;
6. terminate the child tree and finalize `completed`.

Any error appends one concise system message, terminates the tree, and finalizes `failed`. Do not launch a repair turn.

- [ ] **Step 5: Keep route authorization local and explicit**

In `src/httpServer.ts`, keep the existing live Figma session check for `/ai-runner/run-cleanup`. Pass the snapshot through unchanged to `runLocalAiCleanup`; do not add a public snapshot-fetch endpoint.

- [ ] **Step 6: Run runner verification**

```powershell
npm run typecheck
npm run build
node --test tests/local-ai-runner-lifecycle.test.mjs tests/local-ai-cleanup-plan.test.mjs
```

Expected: all tests pass, including invalid-plan failure without retry.

- [ ] **Step 7: Commit runner integration**

```powershell
git add src/localAiRunner.ts src/httpServer.ts tests/local-ai-cleanup-plan.test.mjs
git diff --cached --name-status
git commit -m "End cleanup PlanReview at one validated plan" -m "Constraint: The initial AI turn has no Figma read or write authority.
Rejected: Asking the AI to repair malformed output | it reintroduces unbounded autonomous turns.
Confidence: high
Scope-risk: moderate
Directive: A completed cleanup PlanReview must always have persisted validated plan files.
Tested: npm run typecheck; node --test tests/local-ai-runner-lifecycle.test.mjs tests/local-ai-cleanup-plan.test.mjs
Not-tested: Live Claude and Codex CLI streams are deferred to the final smoke test."
```

## Task 5: Show capture, validation, preview, and approval phases in the UI

**Files:**

- Modify: `ui.html`
- Create: `tests/cleanup-plan-ui.test.mjs`

- [ ] **Step 1: Protect the pre-existing staged UI work**

Before touching `ui.html`, record:

```powershell
git diff --cached -- ui.html tests/unity-project-ui.test.mjs
git status --short
```

The existing staged `addUnityProject` hunk and its test are user-owned. Do not reset or include them in a cleanup commit. If a commit is made, unstage only `ui.html`, stage only cleanup hunks with `git add -p ui.html`, commit them, then re-stage the original `addUnityProject` hunk and verify `tests/unity-project-ui.test.mjs` remains staged.

- [ ] **Step 2: Write failing UI source-contract tests**

Assert that cleanup mode:

- sends `QUERY_CLEANUP_SNAPSHOT`, not `QUERY_AI_PROMPT_SELECTION`;
- handles `QUERY_CLEANUP_SNAPSHOT_RESULT`;
- posts `{snapshot, sessionId}` to `/ai-runner/run-cleanup`;
- renders phases `capturing`, `planning`, `validating`, `awaiting-approval`, `applying`, and `verifying`;
- renders group name/count, component candidates, and warnings from `planSummary`;
- enables approval only when `status === "completed"`, `planReady === true`, and the CLI session is resumable;
- sends `{approval: true}` for cleanup approval;
- keeps free-text follow-up behavior for non-cleanup templates;
- remains syntactically valid with `new Function(script)`.

Run:

```powershell
node --test tests/cleanup-plan-ui.test.mjs
```

Expected: fail because the cleanup-specific snapshot/preview flow is absent.

- [ ] **Step 3: Route cleanup through the compact snapshot command**

In `requestAiRun`, when the template is `cleanup`:

1. set phase/status to “正在采集层级快照”; 
2. post `QUERY_CLEANUP_SNAPSHOT` with a unique request ID;
3. on success call `startAiRun("cleanup", result.snapshot)`;
4. on error clear busy state and display the exact node/depth/byte limit message.

All other templates continue to use `QUERY_AI_PROMPT_SELECTION` and existing prompt generation.

- [ ] **Step 4: Render structured status instead of treating raw logs as the primary UI**

Extend `activeAiCleanupRun` with `phase`, `planReady`, and `planSummary`. Polling copies those fields from `getAiRun`. Add a compact preview block that shows:

```text
分组：3
- TopHUD（5 个节点）
- Content（12 个节点）
- BottomActions（4 个节点）
组件候选：2
警告：0
```

Keep raw output below for diagnostics. Change the cleanup continue action to an explicit `确认并执行整理` button; it does not depend on free-text input. Non-cleanup tasks retain the existing follow-up text box.

- [ ] **Step 5: Run UI regression tests**

```powershell
node --test tests/cleanup-plan-ui.test.mjs tests/figma-ui-initialization.test.mjs tests/psd-incremental-ui.test.mjs tests/unity-project-ui.test.mjs
```

Expected: all tests pass, including the user's existing Unity project button test.

- [ ] **Step 6: Commit only cleanup UI hunks**

Use interactive staging because `ui.html` already contains user-owned staged work:

```powershell
git restore --staged ui.html
git add tests/cleanup-plan-ui.test.mjs
git add -p ui.html
git diff --cached --name-status
git diff --cached -- ui.html
git commit -m "Make cleanup approval depend on a visible valid plan" -m "Constraint: Existing staged Unity project UI work must remain outside this commit.
Rejected: Using raw AI logs as plan state | logs cannot safely gate apply authority.
Confidence: high
Scope-risk: moderate
Directive: Cleanup approval stays disabled until planReady and a resumable CLI session are both present.
Tested: node --test tests/cleanup-plan-ui.test.mjs tests/figma-ui-initialization.test.mjs tests/psd-incremental-ui.test.mjs tests/unity-project-ui.test.mjs
Not-tested: Visual layout is verified in the final live Figma smoke test."
```

After the commit, re-stage only the user's original `addUnityProject` hunk in `ui.html` with `git add -p ui.html`; confirm `tests/unity-project-ui.test.mjs` is still staged and `git diff --cached` matches the pre-task user changes.

## Task 6: Gate approved apply and hand off the validated plan to the existing pipeline

**Files:**

- Modify: `src/localAiRunner.ts`
- Modify: `src/httpServer.ts`
- Modify: `tests/local-ai-cleanup-plan.test.mjs`
- Modify: `tests/cleanup-plan-ui.test.mjs`

- [ ] **Step 1: Add failing approval-gate tests**

Prove:

- cleanup follow-up is rejected without `approval: true`;
- cleanup follow-up is rejected when status is failed/cancelled, plan is absent, or plan files are missing;
- arbitrary follow-up text cannot substitute for approval;
- approved cleanup builds one follow-up instruction containing the full skill path and exact pipeline-plan path;
- the instruction includes `--plan`, `--apply-confirmed`, `--auto-nested-generic`, `--auto-component-sets`, the snapshotted root node ID, and the original Figma plugin session ID;
- approval changes phase to `applying`;
- non-cleanup follow-up behavior remains unchanged.

Run:

```powershell
npm run build
node --test tests/local-ai-cleanup-plan.test.mjs tests/cleanup-plan-ui.test.mjs
```

Expected: new approval tests fail.

- [ ] **Step 2: Require an explicit approval bit at the HTTP boundary**

Change cleanup follow-up handling to pass the full request payload:

```ts
followupAiRun(runId, token, {
  text: payload.text,
  approval: payload.approval === true
});
```

For cleanup runs, ignore approval phrases in free text. Require `approval === true`, `status === "completed"`, `phase === "awaiting-approval"`, `cleanupPlan`, `cleanupPipelinePlanPath`, and `cliSessionId`.

- [ ] **Step 3: Build one deterministic apply instruction**

The cleanup follow-up prompt must say to read the full bundled `SKILL.md`, then execute exactly:

```powershell
python "<plugin-root>\ai\skills\figma-hierarchy-cleanup-mcp\scripts\run_cleanup_pipeline.py" `
  --node-id "<rootNodeId>" `
  --session-id "<figmaPluginSessionId>" `
  --plan "<runDir>\cleanup-pipeline-plan.json" `
  --work-dir "<runDir>\apply" `
  --output "<runDir>\apply-report.json" `
  --apply-confirmed `
  --auto-nested-generic `
  --auto-component-sets
```

The AI must not recompute the root plan. It may report and stop on pipeline validation failure. Existing pipeline rollback/verify behavior remains authoritative.

- [ ] **Step 4: Surface apply/verify phases**

When the resumed stream reports pipeline step names or `[SUMMARY_JSON]`, map them to `applying` and `verifying`. On successful terminal completion, expose a concise apply summary. On failure, keep the validated plan files for diagnosis and terminate the child tree.

- [ ] **Step 5: Verify approval and regression behavior**

```powershell
npm run typecheck
npm run build
node --test tests/local-ai-runner-lifecycle.test.mjs tests/local-ai-cleanup-plan.test.mjs tests/cleanup-plan-ui.test.mjs
python -m pytest ai/skills/figma-hierarchy-cleanup-mcp/tests -q
```

Expected: Node tests pass; the existing Python semantic-gate suite passes.

- [ ] **Step 6: Commit apply handoff**

```powershell
git add src/localAiRunner.ts src/httpServer.ts tests/local-ai-cleanup-plan.test.mjs tests/cleanup-plan-ui.test.mjs
git diff --cached --name-status
git commit -m "Require validated cleanup approval before deterministic apply" -m "Constraint: No cleanup mutation may start from prose, failed output, or an unvalidated plan.
Rejected: Letting the resumed AI regenerate the plan | it would break the reviewed execution contract.
Confidence: high
Scope-risk: moderate
Directive: The persisted pipeline plan is the only root-plan input after approval.
Tested: npm run typecheck; Node cleanup tests; Python hierarchy semantic-gate tests
Not-tested: Live Figma mutation and rollback are deferred to the disposable smoke subtree."
```

## Task 7: Full verification, packaging, service restart, and live benchmark

**Files:**

- Modify as generated: `code.js`, `.build_version`, release/package artifacts produced by `scripts/package_release.ps1`
- Verify only: all changed source/test files and live runtime endpoints

- [ ] **Step 1: Run the complete automated suite**

```powershell
npm run typecheck
npm run build
node --test tests/*.test.mjs
python -m pytest ai/skills/figma-hierarchy-cleanup-mcp/tests -q
python scripts/build.py
node --check code.js
git diff --check
```

Expected: all Node tests pass, all Python tests pass, TypeScript compiles, plugin JavaScript parses, and `git diff --check` is silent.

- [ ] **Step 2: Verify PSD incremental identity preservation in tests**

Run:

```powershell
node --test tests/psd-incremental-diff.test.mjs tests/psd-incremental-task.test.mjs tests/psd-incremental-ui.test.mjs tests/cleanup-snapshot.test.mjs tests/cleanup-plan-contract.test.mjs
```

Expected: all pass. Inspect the snapshot test fixture to confirm PSD SharedPluginData values survive snapshot capture and are never converted into mutation instructions.

- [ ] **Step 3: Package the active plugin release**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package_release.ps1
```

Expected: packaging completes without missing bundled skill/scripts; release output contains the rebuilt `code.js`, updated `ui.html`, and the full cleanup skill for apply-only use.

- [ ] **Step 4: Restart the main service, not a worktree service**

```powershell
.\stop_mcp.bat
.\start_mcp.bat
```

Then verify:

```powershell
Invoke-RestMethod http://127.0.0.1:32130/health | ConvertTo-Json -Depth 8
```

Expected: `status` is `ok`, the plugin reports `connected: true`, and `gateway.pluginRoot` points to the packaged main-project plugin root.

- [ ] **Step 5: Run a disposable live Figma PlanReview benchmark**

Create or select a disposable 50-100 node root that includes text, image, hidden, nine-slice-like, component-related, and PSD-bound examples. Record timestamps for:

1. snapshot capture;
2. AI planning;
3. plan validation;
4. awaiting approval.

Before approval, query/inspect the same root and prove:

- child IDs and order are unchanged;
- absolute bounds are unchanged;
- PSD metadata is unchanged;
- no new Frame/Component/Instance exists;
- the CLI child process has stopped after the terminal result;
- elapsed PlanReview is normally under two minutes and always below the five-minute hard limit.

- [ ] **Step 6: Approve once and verify deterministic apply**

Click `确认并执行整理` once. Verify:

- the exact persisted pipeline plan is consumed;
- hierarchy apply and verification complete;
- root size and absolute bounds remain within the existing 0.01 tolerance;
- child set is conserved and sibling order matches the validated plan;
- hidden/mask/nine-slice nodes and PSD SharedPluginData remain intact;
- ComponentSet candidates are processed only after hierarchy verification;
- the process tree stops at the terminal result.

- [ ] **Step 7: Final git-scope audit and generated-artifact commit**

Run:

```powershell
git status --short
git diff --cached --name-status
git diff --stat
```

Preserve the user's staged `ui.html`/`tests/unity-project-ui.test.mjs` changes and `.playwright-cli/`. If packaging generated intended tracked changes not yet committed, stage only those paths and commit with:

```powershell
git commit -m "Publish the bounded cleanup planning runtime" -m "Constraint: The active main-project plugin and gateway must run the same verified build.
Rejected: Leaving the service on the pre-optimization package | source tests would not prove the live plugin changed.
Confidence: high
Scope-risk: moderate
Directive: Verify gateway.pluginRoot and plugin.connected after every cleanup-runner release.
Tested: Full Node suite; Python hierarchy tests; TypeScript build; plugin build; live 50-100 node PlanReview and approved apply
Not-tested: Performance on selections larger than the enforced 500-node limit."
```

Do not include user-owned staged changes in this commit.

## Completion criteria

- The cleanup button makes one Figma snapshot request and no AI-driven Figma read during PlanReview.
- The initial task does not load the full cleanup skill and cannot call tools or subagents.
- A cleanup run reaches `completed/awaiting-approval` only with one persisted, validated plan.
- The approval UI is driven by `planReady`, not raw text or a guessed phrase.
- Approved apply consumes the persisted adapter plan through the existing deterministic pipeline.
- PlanReview on the disposable 50-100 node subtree is normally under two minutes and cannot exceed five minutes.
- No mutation occurs before approval; PSD incremental identity metadata survives approved grouping.
- All automated tests pass, the main service is restarted, and `/health` proves the active packaged plugin is connected.

