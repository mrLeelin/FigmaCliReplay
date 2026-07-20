# Relay-Owned Cleanup Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute every validated AI hierarchy plan through Relay without a
second AI write turn, then offer variants only after explicit final
satisfaction.

**Architecture:** Keep `localAiRunner` as the resumable conversation and plan
producer. Compile its validated confirmation artifact into the existing exact
V3 cleanup transaction, then run that transaction with `CleanupExecutor` from
a Relay-owned dispatcher. The dispatcher, rather than AI terminal text,
controls execution state and checks Figma write evidence after a transaction
result arrives.

**Tech Stack:** TypeScript, Node test runner, existing `CleanupExecutor`,
`RuntimeRelay`, Figma plugin WebSocket job transport.

---

### Task 1: Compile a validated confirmation artifact into an exact V3 transaction

**Files:**
- Modify: `src/cleanupConfirmationPlan.ts`
- Modify: `tests/cleanup-confirmation-plan.test.mjs`

- [ ] **Step 1: Write failing compiler tests**

Add a direct test using a root with two groups and nested subgroups. Assert the
new `compileCleanupConfirmationPlanToV3(plan, snapshot)` result has:

```js
assert.equal(compiled.schemaVersion, 3);
assert.equal(compiled.rootNodeId, "ROOT");
assert.deepEqual(compiled.preconditions.map(({ nodeId }) => nodeId), ["A", "B", "C", "D"]);
assert.deepEqual(compiled.operations.map(({ type, name }) => [type, name]), [
  ["CREATE_GROUP", "VectorStructure"],
  ["CREATE_GROUP", "TopArea"],
  ["CREATE_GROUP", "ImageContent"],
]);
assert.deepEqual(validateCleanupPlanV3(compiled, snapshot), compiled);
```

Add a second test proving the compiler rejects a confirmation plan whose root
does not match the snapshot before emitting any transaction object.

- [ ] **Step 2: Run the focused test and verify red**

Run:

```powershell
npm run build; node --test tests/cleanup-confirmation-plan.test.mjs
```

Expected: the new test fails because
`compileCleanupConfirmationPlanToV3` is not exported.

- [ ] **Step 3: Implement the compiler**

Add this exported boundary in `src/cleanupConfirmationPlan.ts`:

```ts
export function compileCleanupConfirmationPlanToV3(
  value: unknown,
  snapshot: CleanupSnapshotV1,
): CleanupPlanV3
```

It must call `validateCleanupConfirmationPlan` first, derive every
`CREATE_GROUP` / nested `CREATE_GROUP` and required `REORDER_CHILDREN`
operation solely from the validated groups, and derive preconditions from the
authoritative root direct children. Use `computeCleanupSnapshotHash(snapshot)`,
`preserveAbsoluteBoundsTolerance: 0`, and `createBackup` remains a property of
the executor transaction wrapper rather than model output.

- [ ] **Step 4: Run the focused test and verify green**

Run:

```powershell
npm run build; node --test tests/cleanup-confirmation-plan.test.mjs
```

Expected: all confirmation-plan tests pass, including exact V3 validation.

### Task 2: Add a Relay-owned conversation execution dispatcher

**Files:**
- Create: `src/cleanup/conversationCleanupDispatcher.ts`
- Modify: `src/localAiRunner.ts`
- Modify: `src/index.ts`
- Test: `tests/local-ai-cleanup-plan.test.mjs`

- [ ] **Step 1: Write failing dispatcher and lifecycle tests**

Add tests that assert a validated local AI decision results in a dispatcher
call with the same `runId`, `sessionId`, authoritative snapshot, and compiled
V3 plan. Assert no second provider follow-up is required for a hierarchy write:

```js
assert.match(source, /dispatchValidatedHierarchyCleanup/);
assert.match(source, /compileCleanupConfirmationPlanToV3/);
assert.doesNotMatch(source, /assertCleanupAiPhaseWriteEvidence\(run\.sessionId, run\.runId, run\.cleanupPhase\)/);
```

Add a test double dispatcher that resolves `succeeded`, invokes a progress
callback, and records one hierarchy result; assert it is called once even if
the terminal AI event is delivered twice.

- [ ] **Step 2: Run the lifecycle tests and verify red**

Run:

```powershell
npm run build; node --test tests/local-ai-cleanup-plan.test.mjs tests/local-ai-runner-lifecycle.test.mjs
```

Expected: new dispatcher assertions fail because the current runner only
changes phase and expects AI-created write evidence.

- [ ] **Step 3: Implement the dispatcher**

Create `ConversationCleanupDispatcher` with one public method:

```ts
dispatchValidatedHierarchyCleanup(request: {
  runId: string;
  sessionId: string;
  plan: CleanupPlanV3;
  snapshot: CleanupSnapshotV1;
  signal: AbortSignal;
  onProgress: (message: string) => void;
}): Promise<CleanupExecutionResult>
```

Its only responsibility is to call existing `CleanupExecutor.execute`, forward
bounded progress messages, and log dispatch, result, and error with `runId`.
Instantiate this dispatcher in `src/index.ts` and register it with the local
AI runner through an explicit configuration function. Do not let AI code import
`RuntimeRelay`, bind a port, or call a Figma command directly.

- [ ] **Step 4: Make local AI finalization dispatch the plan**

In `localAiRunner.ts`, after `materializeCleanupConfirmationPlanArtifact`
succeeds:

1. compile the artifact to V3;
2. set the write guard to `hierarchy`;
3. start exactly one dispatcher promise keyed by `runId`;
4. keep the run live as `hierarchy_executing` while the Figma transaction is
   pending;
5. append dispatcher progress and transaction verification to the same run
   output;
6. only after a successful executor result check write evidence, set
   `awaiting_satisfaction`, and append the satisfaction question.

Do not call `startTurn` for confirmation and do not infer write success from
an AI text response. On a transaction failure, preserve the validated artifact,
append the exact failure, and return to a retryable `plan_validated` state.

- [ ] **Step 5: Run lifecycle tests and verify green**

Run:

```powershell
npm run build; node --test tests/local-ai-cleanup-plan.test.mjs tests/local-ai-runner-lifecycle.test.mjs tests/cleanup-ai-write-guard.test.mjs
```

Expected: hierarchy execution is Relay-owned, idempotent, and awaits final
satisfaction only after a successful Figma transaction.

### Task 3: Simplify cleanup conversation phases and follow-up routing

**Files:**
- Modify: `src/localAiRunner.ts`
- Modify: `src/cleanupAiWriteGuard.ts`
- Modify: `tests/local-ai-runner-lifecycle.test.mjs`
- Modify: `tests/cleanup-ai-write-guard.test.mjs`

- [ ] **Step 1: Write failing phase tests**

Add tests for these rules:

```js
assert.equal(classifyCleanupFollowup("awaiting_satisfaction", "满意"), "variants");
assert.equal(classifyCleanupFollowup("awaiting_satisfaction", "按钮区域不要合并"), "analysis");
assert.throws(
  () => classifyCleanupFollowup("hierarchy_executing", "确认执行"),
  /executing|执行中/i,
);
```

Add a guard test proving a failed hierarchy transaction leaves the plan
retryable without accepting a stale follow-up or changing the session owner.

- [ ] **Step 2: Run phase tests and verify red**

Run:

```powershell
npm run build; node --test tests/local-ai-runner-lifecycle.test.mjs tests/cleanup-ai-write-guard.test.mjs
```

Expected: current tests show `确认执行` transitions to `hierarchy` and a
terminal AI turn can convert the run to `failed` before Relay dispatches.

- [ ] **Step 3: Implement the minimal phase transition changes**

Replace the current confirmation-driven cleanup phases with:

```ts
type CleanupConversationPhase =
  | "analysis"
  | "plan_validated"
  | "hierarchy_executing"
  | "awaiting_satisfaction"
  | "variants_executing"
  | "finished";
```

Remove the path that treats confirmation text as the hierarchy execution
trigger. Keep fresh-snapshot adjustment handling, but allow it only after
execution finishes. Retain `assertCleanupAiPhaseWriteEvidence` as a post-result
integrity check owned by the dispatcher, not terminal AI finalization.

- [ ] **Step 4: Run phase tests and verify green**

Run:

```powershell
npm run build; node --test tests/local-ai-runner-lifecycle.test.mjs tests/cleanup-ai-write-guard.test.mjs
```

Expected: no phase reaches unrecoverable `failed` solely because an AI text
turn did not perform a write.

### Task 4: Align task prompt and plugin UI with automatic safe execution

**Files:**
- Modify: `src/localAiRunner.ts`
- Modify: `prompts/cleanup.md`
- Modify: `ui.html`
- Modify: `tests/cleanup-plan-ui.test.mjs`
- Modify: `tests/local-ai-runner-lifecycle.test.mjs`

- [ ] **Step 1: Write failing prompt and UI assertions**

Assert that the cleanup prompt says Relay dispatches a validated safe hierarchy
transaction automatically and that it does not instruct the model to ask for
or wait for hierarchy confirmation. Assert the UI keeps the conversation in
one page and renders `hierarchy_executing` as progress and
`awaiting_satisfaction` as the only satisfaction decision.

- [ ] **Step 2: Run prompt/UI tests and verify red**

Run:

```powershell
npm run build; node --test tests/cleanup-plan-ui.test.mjs tests/local-ai-runner-lifecycle.test.mjs
```

Expected: assertions fail because the current text requires explicit plan
confirmation and the UI sends `确认执行` as a normal AI follow-up.

- [ ] **Step 3: Update prompt and UI**

Change copy and event routing to show:

```text
AI is preparing the validated plan -> Relay is applying the hierarchy plan ->
Hierarchy cleanup is complete. Are you satisfied?
```

Do not add a modal or a second confirmation button. Disable free-form
adjustment input only while the transaction is executing. Preserve the existing
WebSocket-primary control path and one-minute HTTP fallback for status polling.

- [ ] **Step 4: Run prompt/UI tests and verify green**

Run:

```powershell
npm run build; node --test tests/cleanup-plan-ui.test.mjs tests/local-ai-runner-lifecycle.test.mjs
```

Expected: UI and task wording match the Relay-owned execution lifecycle.

### Task 5: Run end-to-end verification with a live Figma selection

**Files:**
- Test only: `.logs/relay-YYYY-MM-DD.jsonl`
- Test only: `.tmp/ai-runs/<new-run-id>/`

- [ ] **Step 1: Run all affected automated tests**

Run:

```powershell
npm run build
npm run typecheck
node --test tests/cleanup-confirmation-plan.test.mjs tests/local-ai-cleanup-plan.test.mjs tests/local-ai-runner-lifecycle.test.mjs tests/cleanup-ai-write-guard.test.mjs tests/cleanup-plan-ui.test.mjs tests/cleanup-executor.test.mjs
```

Expected: all tests pass with no TypeScript errors.

- [ ] **Step 2: Restart Relay and begin a live cleanup**

Use the existing selected Figma root. Verify the structured log sequence:

```text
snapshot-persisted
confirmation-plan-materialized
plan-validation-succeeded
hierarchy-dispatch-started
FIGMA_HIERARCHY_CLEANUP_TRANSACTION succeeded
transaction-verification
awaiting-satisfaction
```

Expected: no `missing-write-evidence`, no `phase failed`, and no repeated
HTTP follow-up fallback after a valid plan.

- [ ] **Step 3: Verify final-satisfaction gate**

Reply with a non-satisfaction adjustment and assert a fresh snapshot is used
without creating variants. Then complete one fresh safe hierarchy run and
reply `满意`; verify only that reply enables the ComponentSet transaction.

- [ ] **Step 4: Commit only when requested**

Do not stage unrelated existing changes. When a commit is requested, stage
only files owned by this plan and use the repository Lore commit format.
