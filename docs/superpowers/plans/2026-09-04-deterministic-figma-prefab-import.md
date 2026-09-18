# Deterministic Figma Prefab Import Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Figma-to-Prefab button import the selected Figma root into the selected empty Unity folder through fixed local rules, without starting any AI runner or prompt workflow. `UiAtlas/` is a classification directory for generated atlas inputs in this first pass; it does not create a Unity `.spriteatlas` asset.

**Architecture:** Add a Relay-owned asynchronous import task that validates the Figma selection and Unity target, then launches the existing deterministic `run_full_import.py` pipeline. The plugin UI starts and polls that task directly. Existing manifest generation, image health checks, nine-slice processing, TMP font/material generation, sprite import, Prefab generation, and static verification remain the single source of truth.

**Tech Stack:** TypeScript Node HTTP server, Figma plugin UI JavaScript, Python import pipeline, Unity Editor C#, Node test runner.

---

## Chunk 1: Relay Task Runtime

### Task 1: Add the deterministic import task

**Files:**
- Create: `src/figmaPrefabImportTask.ts`
- Modify: `src/httpServer.ts`
- Test: `tests/figma-to-prefab-direct-import-task.test.mjs`

- [x] **Step 1: Write failing regression tests for the task contract**

Assert that the Relay exposes `POST /figma-to-prefab/import` and `GET /figma-to-prefab/import/{taskId}/status`, and that the task launches `run_full_import.py` with complete `--unity-project`, `--figma-url`, `--file-key`, `--session-id`, `--target-prefab`, `--target-image-dir`, `--infer-formal-names`, `--formal-layout split`, `--formal-output-dir`, `--overwrite create-new-only`, `--yes`, a unique manifest directory, and a wall-clock report. Export pure validation/summary helpers or injectable process and filesystem dependencies so tests cover traversal/absolute/symlink escapes, non-empty targets, exact spawn arguments, concurrent-task locking, queued/running/completed/error transitions, malformed/missing summaries, nonzero exits, and `verifyAllPass` enforcement.

- [x] **Step 2: Run the targeted test and verify it fails**

Run: `node --test tests/figma-to-prefab-direct-import-task.test.mjs`

Expected: FAIL because the task module and routes do not exist.

- [x] **Step 3: Implement the minimal task runtime**

Validate one selected Figma node, a live plugin session, a registered Unity project that matches the connected gateway, the installed compatible Bridge/font-material prerequisites, and an empty `Assets/...` folder. Resolve the project through `UnityProjectRegistry`; normalize the asset path, reject absolute/traversal paths and symlink/junction escapes, and recheck emptiness immediately before spawning. Serialize tasks per Unity project to isolate the pipeline's shared `.tmp`/uLoop files. Spawn Python hidden with argument arrays, retain bounded logs, parse exactly one final `[SUMMARY_JSON]`, and mark success only for exit code zero plus `status=completed`, `verifyAllPass=true`, and outputs beneath the selected folder.

- [x] **Step 4: Run the task regression test**

Run: `node --test tests/figma-to-prefab-direct-import-task.test.mjs`

Expected: PASS.

## Chunk 2: Direct UI Wiring

### Task 2: Bypass all AI prompt and runner code

**Files:**
- Modify: `ui.html`
- Modify: `tests/figma-to-prefab-direct-import-ui.test.mjs`

- [x] **Step 1: Rewrite the UI regression test to require a non-AI path**

Assert that `exportHierarchyToUnity()` posts directly to `/figma-to-prefab/import`, uses the current single Figma selection and selected Unity project/folder, polls task status, and does not reference `requestAiRun`, `startAiRun`, `aiPromptTemplateSelect`, or the AI tabs. `refreshUnityControls()` must gate only deterministic-import activity and the selection/folder prerequisites, not `aiCleanupBusy` or `generatingAiPrompt`.

- [x] **Step 2: Run the targeted UI test and verify it fails**

Run: `node --test tests/figma-to-prefab-direct-import-ui.test.mjs`

Expected: FAIL because the button currently starts the AI runner.

- [x] **Step 3: Implement direct start, progress polling, and final result rendering**

Use the existing selection cache and Unity folder health state. Disable the button only while this deterministic task is active or prerequisites are invalid. Show generated Prefab, Texture, UiAtlas, audit, image, and verification paths from the task summary.

- [x] **Step 4: Run the targeted UI test**

Run: `node --test tests/figma-to-prefab-direct-import-ui.test.mjs`

Expected: PASS.

## Chunk 3: Lossless Rule Gates

### Task 3: Lock nine-slice and TMP behavior into regression coverage

**Files:**
- Modify: `tests/run-full-import-portability.test.mjs`
- Test: `tests/figma-to-prefab-lossless-rules.test.mjs`
- Modify only if a test exposes a gap: `ai/skills/figma-to-prefab/scripts/run_full_import.py`
- Modify only if a test exposes a gap: `ai/skills/figma-to-prefab/scripts/gen_spec.py`
- Modify only if a test exposes a gap: `unity/Assets/Editor/FigmaBridge/PrefabImport/FigmaPrefabGenerator.cs`

- [x] **Step 1: Add regression assertions for deterministic rules**

Cover fixture-driven Figma `fontSize`, text material signature generation, CommonFont binding, `enableAutoSizing = false`, nine-slice crop dimensions/pixel preservation and Sprite border order, `Image.Type.Sliced`, raycast disabling, image health/hash gates, create-new-only/GUID preservation, and blocking verification on invalid output. Static source assertions remain only as contract smoke checks.

- [x] **Step 2: Run the rule test and inspect any real gap**

Run: `node --test tests/figma-to-prefab-lossless-rules.test.mjs tests/run-full-import-portability.test.mjs`

Expected: Existing rules pass; production edits are made only for an evidenced failure.

- [x] **Step 3: Run focused integration verification**

Run: `node --test tests/figma-to-prefab-direct-import-task.test.mjs tests/figma-to-prefab-direct-import-ui.test.mjs tests/figma-to-prefab-lossless-rules.test.mjs tests/run-full-import-portability.test.mjs tests/unity-gameobject-image-target.test.mjs tests/path-portability.test.mjs`

Expected: All focused tests pass.

- [x] **Step 4: Run TypeScript validation**

Run: `npm run typecheck`

Expected: PASS.

- [x] **Step 5: Report runtime boundary**

Do not claim a real Prefab was produced unless a live Figma plugin session, a selected empty Unity folder, Python, uLoop, and the target Unity Editor were all available and the task summary reported `verifyAllPass=true`.
