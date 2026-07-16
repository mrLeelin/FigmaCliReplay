# Bridge Version Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce exact release-version equality between the Figma plugin and Unity Bridge, and expose a one-click Bridge synchronization state when they differ.

**Architecture:** `package.json.version` remains the release source. The existing Python build synchronizer updates both the UI release marker and a new Bridge release marker. The UI reads its rendered release badge, validates `/health.version` before accepting a connection, stores a terminal version-mismatch state, and reuses the existing Bridge installer button as “同步 Bridge”.

**Tech Stack:** Python build script, Unity Editor C#, single-file HTML/JavaScript UI, Node test runner.

---

## File map

- Modify `scripts/build.py`: synchronize package version into UI and Bridge markers.
- Modify `unity/Assets/Editor/FigmaBridge/FigmaBridgeServer.cs`: replace `1.0.0` with the synchronized release marker.
- Modify `ui.html`: compare versions, block mismatched connections, render the error and synchronization button.
- Create `tests/bridge-version-sync.test.mjs`: execute version comparison and verify build/source synchronization contracts.
- Modify `tests/settings-tab-ui.test.mjs`: verify mismatch state reaches Settings and the existing install button.
- Modify `tests/figma-bridge-project-health.test.mjs`: verify Bridge health uses the marked release version.

### Task 1: Synchronize Bridge release version during builds

**Files:**
- Modify: `scripts/build.py:15-130`
- Modify: `unity/Assets/Editor/FigmaBridge/FigmaBridgeServer.cs:34-38`
- Create: `tests/bridge-version-sync.test.mjs`

- [ ] **Step 1: Write the failing release synchronization test**

Read `package.json`, `ui.html`, `FigmaBridgeServer.cs`, and `scripts/build.py`. Assert the UI marker and Bridge constant both equal `package.json.version`; assert Bridge has exactly one `BEGIN_RELEASE_VERSION`/`END_RELEASE_VERSION` pair; assert the Python synchronizer declares a Bridge path and replaces both marker blocks.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/bridge-version-sync.test.mjs`

Expected: FAIL because Bridge reports `1.0.0` and `build.py` only synchronizes UI.

- [ ] **Step 3: Implement the marked Bridge constant and Python sync**

Set the current Bridge version to `0.1.37` inside stable release markers. Add a Bridge marker regex to `build.py`, factor marker replacement into a helper that requires exactly one match, and update both UI and Bridge from the validated package version. Keep the existing UI output format `v<version>` and Bridge format `"<version>"`.

- [ ] **Step 4: Run the release synchronization test and verify GREEN**

Run: `node --test tests/bridge-version-sync.test.mjs`

Expected: PASS with package, UI, and Bridge all at `0.1.37`.

### Task 2: Reject Bridge version mismatch before connection

**Files:**
- Modify: `ui.html:1000-1160,1320-1360,3345-3440`
- Modify: `tests/bridge-version-sync.test.mjs`

- [ ] **Step 1: Add failing executable comparison tests**

Extract and execute the pure `evaluateBridgeVersion(pluginVersion, bridgeVersion)` function from `ui.html`. Assert equal versions return `matches:true`; `1.0.0`, empty text, and missing values return `matches:false` with normalized display text `未报告` for missing Bridge versions.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/bridge-version-sync.test.mjs`

Expected: FAIL because the comparison function does not exist.

- [ ] **Step 3: Implement terminal mismatch handling**

Read the plugin version from `.release-version`. Add pure comparison and mismatch-error helpers. In `probeUnityUrl`, validate project path first and version second. Mark mismatch errors with `bridgeVersionMismatch`, expected/actual versions, and current project id. In `scanUnityGateways`, immediately rethrow mismatch instead of trying other ports. At connection start clear stale mismatch; on mismatch keep `unityConnected=false`, store the mismatch, and render the exact plugin/Bridge versions.

- [ ] **Step 4: Run comparison tests and verify GREEN**

Run: `node --test tests/bridge-version-sync.test.mjs`

Expected: all comparison cases PASS.

### Task 3: Render Settings error and reuse the synchronization button

**Files:**
- Modify: `ui.html:790-805,1320-1360,1430-1540,3420-3470`
- Modify: `tests/settings-tab-ui.test.mjs`
- Modify: `tests/figma-bridge-project-health.test.mjs`

- [ ] **Step 1: Write failing UI state tests**

Assert the mismatch state adds `Unity Bridge 版本不一致` to `refreshSettingsConnectionAlert`, changes `installUnityBridgeBtn` to `同步 Bridge` with the danger style, keeps it enabled for a valid selected project, and changes the Unity badge to `版本错误`. Assert install success reports `Bridge 已同步到 <pluginVersion>，等待 Unity 编译后重新连接` without clearing mismatch.

- [ ] **Step 2: Run targeted tests and verify RED**

Run: `node --test tests/settings-tab-ui.test.mjs tests/figma-bridge-project-health.test.mjs`

Expected: FAIL because mismatch-specific UI state does not exist.

- [ ] **Step 3: Implement mismatch rendering**

Add `refreshUnityBridgeVersionState()` and call it from project rendering, mismatch updates, and Unity control refresh. Use the existing install button and endpoint; do not create a second button. On successful installation, retain mismatch until a later health check succeeds. Clear mismatch only on matching connection or when switching to a different project.

- [ ] **Step 4: Run targeted tests and verify GREEN**

Run: `node --test tests/settings-tab-ui.test.mjs tests/figma-bridge-project-health.test.mjs`

Expected: targeted UI and Bridge health tests PASS.

### Task 4: Full verification and review

**Files:**
- Verify all files above together with the existing uncommitted gateway-discovery work.

- [ ] **Step 1: Run complete automated verification**

Run: `npm run build && node --test tests/*.test.mjs && npm run typecheck`

Expected: build succeeds, all Node tests pass, and TypeScript exits `0`.

- [ ] **Step 2: Check Python and source integrity**

Run: `python -m py_compile scripts/build.py`, `git diff --check`, and UTF-8 checks over modified Chinese files. Verify no escaped Chinese text, `???`, mojibake, or duplicate release markers exist.

- [ ] **Step 3: Request independent code review**

Review exact-version behavior, terminal mismatch ordering, button-state lifecycle, release synchronization drift prevention, and interaction with config-first gateway discovery. Fix all Critical/Important findings and repeat targeted verification.

- [ ] **Step 4: Report scope without committing implementation**

Use `git status --short` and `git diff --stat`. Keep implementation uncommitted and unpushed unless the user explicitly requests Git actions.
