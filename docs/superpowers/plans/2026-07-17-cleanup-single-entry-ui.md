# Cleanup Single-Entry UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI cleanup a single-page flow with one AI selector and one review/progress dialog while preserving the existing planner/executor safety boundary.

**Architecture:** Keep `CleanupController`, planning providers, validation, approval tokens, and the transaction executor unchanged. Simplify only `ui.html`: one visible AI selector maps to the existing internal provider/runner values, and cleanup-specific progress plus approval moves into a dedicated modal on the AI prompt page. Generic non-cleanup AI tasks retain the existing task page.

**Tech Stack:** Figma plugin HTML/JavaScript, Node.js built-in test runner, TypeScript relay server.

---

### Task 1: Lock the simplified UI contract

**Files:**
- Modify: `tests/cleanup-plan-ui.test.mjs`
- Modify: `tests/cleanup-provider-storage.test.mjs`
- Test: `tests/cleanup-plan-ui.test.mjs`
- Test: `tests/cleanup-provider-storage.test.mjs`

- [ ] **Step 1: Write failing assertions**

Add assertions that require one visible label named `AI`, a cleanup dialog with status/preview/confirm/cancel controls, cleanup startup to call `openCleanupRunDialog()`, and cleanup status messages to remain on the current page. Reject the old visible labels `执行器` and `整理规划 AI` and old cleanup directions to the “AI 执行” page.

- [ ] **Step 2: Verify RED**

Run:

```powershell
node --test tests/cleanup-plan-ui.test.mjs tests/cleanup-provider-storage.test.mjs
```

Expected: FAIL because the current HTML exposes two AI selectors and has no cleanup run dialog.

### Task 2: Implement one AI selector and one cleanup dialog

**Files:**
- Modify: `ui.html`
- Test: `tests/cleanup-plan-ui.test.mjs`
- Test: `tests/cleanup-provider-storage.test.mjs`

- [ ] **Step 1: Replace the two visible selectors**

Keep `cleanupProviderSelect` as the only visible selector and label it `AI`. Retain `aiRunnerSelect` only as hidden compatibility state for generic tasks. Change provider status text to `当前 AI：<name> · <version>` and map `claude-code` to the generic runner value `claude` when the user changes the single selector.

- [ ] **Step 2: Add cleanup review/progress dialog**

Add `cleanupRunDialog`, `cleanupRunDialogStatus`, `cleanupRunPlanPreview`, `confirmCleanupRunBtn`, `cancelCleanupRunBtn`, and `closeCleanupRunBtn`. Render the existing structured `planSummary.operations` and warnings inside this dialog. Enable confirmation only for `state=review` with a valid plan and snapshot hash.

- [ ] **Step 3: Keep cleanup on the current page**

For cleanup runs, open the cleanup dialog instead of calling `switchTab("ai-execution-tab")`. Polling updates the dialog through planning, review, applying, verifying, success, rollback, and recovery states. Generic AI tasks continue using the existing execution page.

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
node --test tests/cleanup-plan-ui.test.mjs tests/cleanup-provider-storage.test.mjs
```

Expected: all selected tests PASS.

### Task 3: Regression and release verification

**Files:**
- Modify only if a regression is found: `ui.html`, related tests

- [ ] **Step 1: Run all automated checks**

```powershell
npm run build
npm run typecheck
node --test tests/*.test.mjs
python -B tests/test_apply_cleanup_plan.py
node --check code.js
git diff --check
```

Expected: all checks PASS with no syntax, type, contract, or whitespace errors.

- [ ] **Step 2: Build and restart the main-project release**

Use the repository release script and hidden service launcher already used by the project. Confirm `/health`, `/ai-runner/providers`, the connected Figma session, one visible AI selector, and the enabled cleanup button.

- [ ] **Step 3: Preserve repository ownership boundaries**

Do not stage or commit. Preserve the user's existing staged `tests/unity-project-ui.test.mjs`, `.playwright-cli/`, and all unrelated dirty files.
