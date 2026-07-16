# Unity Gateway Configuration Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Figma UI read the selected Unity project's actual gateway address before using bounded port scanning as a fallback.

**Architecture:** Unity writes its actual post-bind URL to a git-ignored per-process project-local discovery record. The Node Companion resolves a registered project id, validates the newest record, and exposes it through a read-only local endpoint. The UI queries that endpoint first, validates `/health.projectPath`, and only then falls back to the existing scan.

**Tech Stack:** Unity Editor C#, Node.js/TypeScript HTTP server, single-file HTML/JavaScript UI, Node test runner.

---

## File map

- Create `unity/Assets/Editor/FigmaBridge/FigmaBridgeGatewayDiscovery.cs`: atomic discovery-record write and ownership-safe deletion.
- Modify `unity/Assets/Editor/FigmaBridge/FigmaBridgeServer.cs`: publish after successful bind and remove before clearing the active port.
- Create `src/unityGatewayDiscovery.ts`: project-scoped record loading and local-URL validation.
- Modify `src/httpServer.ts`: expose `GET /unity-projects/{id}/gateway`.
- Modify `ui.html`: query project gateway configuration before scanning.
- Modify `tests/figma-bridge-project-health.test.mjs`: lock Unity publication and cleanup wiring.
- Modify `tests/unity-project-http.test.mjs`: cover valid, missing, and invalid project discovery records.
- Modify `tests/settings-tab-ui.test.mjs`: lock config-first UI behavior and fallback logging.

### Task 1: Unity publishes the actual bound gateway

**Files:**
- Create: `unity/Assets/Editor/FigmaBridge/FigmaBridgeGatewayDiscovery.cs`
- Modify: `unity/Assets/Editor/FigmaBridge/FigmaBridgeServer.cs:129-199`
- Test: `tests/figma-bridge-project-health.test.mjs`

- [ ] **Step 1: Write the failing structural test**

Assert that the package contains `FigmaBridgeGatewayDiscovery.cs`, that `TryStartOnPort` calls `FigmaBridgeGatewayDiscovery.Publish(CurrentGatewayUrl)`, and that `Stop` calls `RemoveOwned(CurrentGatewayUrl)` before `_currentPort = 0`.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/figma-bridge-project-health.test.mjs`

Expected: FAIL because the discovery helper and calls do not exist.

- [ ] **Step 3: Implement the helper**

Implement a `[Serializable]` record with `version`, `projectPath`, `gatewayUrl`, `processId`, and `updatedAtUtc`. Write JSON atomically to `Path.Combine(projectRoot, "Library", "FigmaBridge", "gateways", processId + ".json")` using a temporary file and replacement. `RemoveOwned` deletes only the current process's record. All failures use `ZLog.LogWarning` and do not throw into server startup/shutdown.

- [ ] **Step 4: Wire server lifecycle and verify GREEN**

Call `Publish(CurrentGatewayUrl)` only after `_currentPort` is assigned and the listener is running. Capture `CurrentGatewayUrl` in `Stop`, call `RemoveOwned` before resetting `_currentPort`, then run the targeted test.

### Task 2: Companion exposes validated project discovery

**Files:**
- Create: `src/unityGatewayDiscovery.ts`
- Modify: `src/httpServer.ts:94-140`
- Test: `tests/unity-project-http.test.mjs`

- [ ] **Step 1: Write failing HTTP tests**

Create a temporary Unity project, register it, and write two records under `Library/FigmaBridge/gateways/<processId>.json`. Assert `GET /unity-projects/{id}/gateway` returns the newest valid record and falls back to the older record after the newer one is removed. Add cases for missing files, invalid URLs/timestamps, unavailable registered projects, and a record whose `projectPath` differs; invalid data returns `{ found: false }` or falls back without leaking disk paths.

- [ ] **Step 2: Build and verify RED**

Run: `npm run build && node --test tests/unity-project-http.test.mjs`

Expected: HTTP tests FAIL with 404 for the new endpoint.

- [ ] **Step 3: Implement validation**

Export `readUnityGatewayDiscovery(projectPath)`. Enumerate only numeric `.json` records under `Library/FigmaBridge/gateways`; require the filename to match `processId`, version `1`, normalized project-path equality, an ISO UTC timestamp string, and an HTTP URL whose hostname is `localhost`, `127.0.0.1`, or `::1` and whose port is `32129-32135`. Return the newest valid record or `{ found: false }` when none remain.

- [ ] **Step 4: Add the GET route and verify GREEN**

Match `^/unity-projects/([^/]+)/gateway$`, decode the id, resolve it with `unityProjects.snapshot(id)`, and return the validated discovery result. Return 404 only for an unknown registered id. Rebuild and run the targeted HTTP tests.

### Task 3: UI uses configuration before scanning

**Files:**
- Modify: `ui.html:3320-3400`
- Test: `tests/settings-tab-ui.test.mjs`

- [ ] **Step 1: Write the failing UI contract test**

Assert that `readSelectedUnityGatewayConfig` requests `/unity-projects/{id}/gateway`, `connectUnity` logs `正在读取 Unity 网关配置`, passes a configured URL to `probeUnityHealth` without expanding the scan list, and logs `项目配置不可用，开始兜底扫描` before using `buildUnityProbeUrls`.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/settings-tab-ui.test.mjs`

Expected: FAIL because config-first helpers and logs do not exist.

- [ ] **Step 3: Implement config-first probing**

Add `readSelectedUnityGatewayConfig()` using the selected registered project id and the relay endpoint. Split probing into `probeUnityUrl(url)` for one address and `scanUnityGateways(preferredUrl)` for the existing bounded scan. `connectUnity` first reads and probes the configured URL, verifies health project path, and scans only when configuration is absent, invalid, unreachable, or mismatched.

- [ ] **Step 4: Verify GREEN**

Run the targeted UI test and ensure the configured path contains no scan loop before its failure branch.

### Task 4: Full verification and scope review

**Files:**
- Verify all files above plus existing uncommitted settings-alert changes.

- [ ] **Step 1: Run complete automated verification**

Run: `npm run build && node --test tests/*.test.mjs && npm run typecheck`

Expected: all Node tests pass and TypeScript exits `0`.

- [ ] **Step 2: Check formatting and encoding**

Run `git diff --check` and reopen modified Chinese files as UTF-8, rejecting `???`, escaped Chinese text, or mojibake.

- [ ] **Step 3: Review dirty scope**

Use `git status --short` and `git diff --stat` to confirm only the discovery implementation, tests, plan, and the already-present settings alert files are changed. Do not commit or push implementation unless the user requests it.
