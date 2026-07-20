# AI Terminal Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open a visible PowerShell session that starts the AI CLI selected in the Figma Relay panel with the generated prompt as its initial interactive message.

**Architecture:** Keep the action distinct from managed AI runs. `ui.html` submits the current preview and resolved runner to a new local Relay endpoint; `localAiRunner.ts` persists an UTF-8 task file, creates a Base64-encoded PowerShell startup script, and returns only launch metadata. The existing central UI and local-AI loggers record the complete start lifecycle without recording the prompt body.

**Tech Stack:** TypeScript/Node.js, Node test runner, Figma plugin WebView JavaScript, Windows PowerShell.

---

### Task 1: Lock the terminal launcher contract with tests

**Files:**
- Modify: `tests/local-ai-cleanup-plan.test.mjs`
- Modify: `tests/cleanup-plan-ui.test.mjs`

- [x] **Step 1: Add a server-contract test**

Assert the AI runner route block accepts `/ai-runner/open-terminal`, retains the live Figma session check, and calls `openLocalAiTerminal(payload)` rather than `runLocalAiPrompt(payload)`.

```js
assert.match(route, /pathname === "\/ai-runner\/open-terminal"/);
assert.match(route, /openLocalAiTerminal\(payload\)/);
assert.match(route, /!relay\.hasLivePluginSession\(payload\.sessionId\)/);
```

- [x] **Step 2: Add a UI-contract test**

Assert the manual-actions row contains `openAiTerminalBtn`, `refreshAiPromptControls` disables it when the preview is empty, and its handler posts to `/ai-runner/open-terminal` with `runnerForCurrentAiPromptTemplate(template)`.

```js
assert.match(ui, /id="openAiTerminalBtn"/);
assert.match(controls, /openAiTerminalBtn\.disabled = .* !aiPromptPreviewEl\.value\.trim\(\)/);
assert.match(terminal, /"\/ai-runner\/open-terminal"/);
assert.match(terminal, /runnerForCurrentAiPromptTemplate\(template\)/);
```

- [x] **Step 3: Run the focused tests and confirm the assertions fail**

Run: `node --test tests/local-ai-cleanup-plan.test.mjs tests/cleanup-plan-ui.test.mjs`

Expected: FAIL because the endpoint, button, and launcher function do not exist yet.

### Task 2: Add the centralized server-side interactive terminal launcher

**Files:**
- Modify: `src/localAiRunner.ts`

- [x] **Step 1: Implement payload validation and task persistence**

Export `openLocalAiTerminal(payload)`. Require `sessionId`, supported `template`, non-empty `prompt`, and runner resolved through `preset(runnerFrom(payload))`. Create a unique `terminal-...` run directory under `RUNS_ROOT` and write `terminal-task.md` with a UTF-8 BOM.

```ts
const terminalId = `terminal-${Date.now()}-${randomBytes(4).toString("hex")}`;
const terminalDir = path.join(RUNS_ROOT, terminalId);
const taskFile = path.join(terminalDir, "terminal-task.md");
fs.writeFileSync(taskFile, `\uFEFF${taskContent}`, "utf8");
```

- [x] **Step 2: Build an injection-safe visible PowerShell command**

Use a single-quote PowerShell literal helper and `Buffer.from(script, "utf16le").toString("base64")`. The script changes to the configured workspace, reads the prompt from the task file with `-Encoding UTF8`, and invokes the configured CLI interactively. Start `powershell.exe` with `-NoExit`, `-EncodedCommand`, `detached: true`, `stdio: "ignore"`, and `windowsHide: false`.

```ts
const child = spawn("powershell.exe", ["-NoExit", "-EncodedCommand", encodedScript], {
  cwd: config.workspace,
  detached: true,
  stdio: "ignore",
  windowsHide: false,
});
child.unref();
```

- [x] **Step 3: Record every launcher phase with the existing central logger**

Create one `aiLogger.startOperation("ai.terminal", ...)` scope, then record `task-persisted`, `command-prepared`, `powershell-started`, and `succeeded`; on all failures call `operation.fail(...)`. Log metadata only (runner, template, file name, PID and character count), never the prompt body.

- [x] **Step 4: Return launch metadata only**

Return `{ ok: true, runner, taskFile, pid }`. Do not register an `AiRun`, poll terminal output, or claim that an AI/Figma task completed.

### Task 3: Expose the launcher through the local Relay HTTP API

**Files:**
- Modify: `src/httpServer.ts`

- [x] **Step 1: Import the launcher**

Extend the existing `localAiRunner` import with `openLocalAiTerminal`.

- [x] **Step 2: Add the endpoint to the guarded action group**

Include `/ai-runner/open-terminal` in the existing AI-runner route condition, preserving the exact `relay.hasLivePluginSession(payload.sessionId)` check.

- [x] **Step 3: Dispatch terminal requests separately**

Insert the explicit branch before the generic `runLocalAiPrompt(payload)` fallback.

```ts
: pathname === "/ai-runner/open-terminal"
  ? openLocalAiTerminal(payload)
  : runLocalAiPrompt(payload);
```

### Task 4: Add the panel action and centralized UI logging

**Files:**
- Modify: `ui.html`

- [x] **Step 1: Add and bind the button**

Add `<button id="openAiTerminalBtn" class="secondary" type="button">在终端继续</button>` beside the existing prompt actions. Retrieve it with `document.getElementById` and bind it to `openAiTerminal`.

- [x] **Step 2: Resolve the same runner the current template uses**

Implement `runnerForCurrentAiPromptTemplate(template)` so cleanup maps `cleanupProviderSelect` through `runnerIdForCleanupProvider`, while every other template uses `aiRunnerSelect.value`.

```js
function runnerForCurrentAiPromptTemplate(template) {
  return template === "cleanup"
    ? runnerIdForCleanupProvider(cleanupProviderSelect.value)
    : aiRunnerSelect.value;
}
```

- [x] **Step 3: Implement the terminal request lifecycle**

Validate the preview, start a `uiLogger` operation, submit `{ template, prompt, runner, sessionId: relaySessionId, unityProject: selectedUnityProject }` to `/ai-runner/open-terminal`, validate `result.ok`, and display Chinese success/error text. The success message states only that the terminal was opened and includes the returned task path.

- [x] **Step 4: Keep controls coherent**

Disable the terminal button while prompt generation or an existing cleanup is busy, and while the preview is empty. Refresh it whenever the preview/template/provider state changes.

### Task 5: Verify and deliver

**Files:**
- Modify: `docs/superpowers/plans/2026-07-20-ai-terminal-launch.md` (mark completed steps)

- [x] **Step 1: Run focused Node tests**

Run: `node --test tests/local-ai-cleanup-plan.test.mjs tests/cleanup-plan-ui.test.mjs`

Expected: PASS.

- [x] **Step 2: Run the repository validation commands**

Run the package test command, TypeScript check, plugin build, and `git diff --check` found in `package.json`.

Expected: all configured checks pass; if a broader pre-existing failure appears, report it separately.

Result: TypeScript check, focused terminal tests, build, and diff check passed. The broad `*.test.mjs` run has seven pre-existing static-plugin assertion failures in PSD and provider-refresh tests; the same required `code.js` patterns are absent from `HEAD`, so they are outside this terminal-launch change.

- [x] **Step 3: Smoke test launch plumbing without sending a real AI task**

Use a test double or inspect the encoded script to verify it contains the task-file read and CLI invocation while the prompt itself is absent from the process arguments/log metadata.

- [x] **Step 4: Commit the scoped implementation**

Stage only `src/localAiRunner.ts`, `src/httpServer.ts`, `ui.html`, the two tests, and this plan. Use the repository Lore commit trailers and leave unrelated untracked diagnostic files untouched.
