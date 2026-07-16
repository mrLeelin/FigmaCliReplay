# Top Bridge Version Badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在插件顶部发布版本右侧常驻显示当前 Unity Bridge 版本及其连接/错误状态。

**Architecture:** 在 `ui.html` 中增加独立的 Bridge 徽标和一个纯状态渲染函数。现有 `/health` 版本比较流程负责传入匹配、不匹配或未报告状态；断开、切换工程和新连接开始时统一重置，且不增加网络接口。

**Tech Stack:** HTML/CSS、原生 JavaScript、Node.js `node:test`、`node:vm`

---

## File Structure

- Modify: `ui.html` — 顶部徽标、样式、状态渲染与连接生命周期更新。
- Modify: `tests/bridge-version-sync.test.mjs` — 执行徽标状态函数并验证连接集成点。
- Modify: `tests/settings-tab-ui.test.mjs` — 验证顶部徽标紧邻插件版本。

### Task 1: Bridge 徽标纯状态渲染

**Files:**
- Modify: `tests/bridge-version-sync.test.mjs`
- Modify: `ui.html`

- [ ] **Step 1: Write the failing executable state test**

在 `tests/bridge-version-sync.test.mjs` 中提取并执行纯函数，验证四种状态：

```js
test("top Bridge badge renders disconnected, connected, mismatch, and missing versions", () => {
  const functionMatch = ui.match(/function getBridgeVersionBadgeState\(bridgeVersion, status\) \{[\s\S]*?\n    \}/);
  assert.ok(functionMatch, "UI should define a Bridge badge state helper");
  const context = {};
  vm.runInNewContext(`${functionMatch[0]}; this.getBridgeVersionBadgeState = getBridgeVersionBadgeState;`, context);

  assert.deepEqual({ ...context.getBridgeVersionBadgeState("", "disconnected") }, { text: "Bridge --", state: "idle" });
  assert.deepEqual({ ...context.getBridgeVersionBadgeState("0.1.37", "connected") }, { text: "Bridge 0.1.37", state: "online" });
  assert.deepEqual({ ...context.getBridgeVersionBadgeState("1.0.0", "mismatch") }, { text: "Bridge 1.0.0", state: "error" });
  assert.deepEqual({ ...context.getBridgeVersionBadgeState("", "mismatch") }, { text: "Bridge 未报告", state: "error" });
});
```

- [ ] **Step 2: Run the targeted test and verify RED**

Run: `node --test tests/bridge-version-sync.test.mjs`

Expected: FAIL with `UI should define a Bridge badge state helper`.

- [ ] **Step 3: Add the badge and minimal pure renderer**

在顶部版本后增加：

```html
<span class="release-version bridge-version idle" id="bridgeVersionBadge" title="Unity Bridge 版本">Bridge --</span>
```

增加状态函数和 DOM 更新函数：

```js
function getBridgeVersionBadgeState(bridgeVersion, status) {
  var reportedVersion = String(bridgeVersion || "").trim();
  if (status === "mismatch") {
    return { text: "Bridge " + (reportedVersion || "未报告"), state: "error" };
  }
  if (status === "connected") {
    return { text: "Bridge " + reportedVersion, state: "online" };
  }
  return { text: "Bridge --", state: "idle" };
}

function setBridgeVersionBadge(bridgeVersion, status) {
  var badgeState = getBridgeVersionBadgeState(bridgeVersion, status);
  bridgeVersionBadge.textContent = badgeState.text;
  bridgeVersionBadge.className = "release-version bridge-version " + badgeState.state;
}
```

CSS 使用现有颜色变量：`.online` 使用 `--accent-2`，`.error` 使用 `--danger`，`.idle` 使用 `--muted`。

- [ ] **Step 4: Run the targeted test and verify GREEN**

Run: `node --test tests/bridge-version-sync.test.mjs`

Expected: PASS.

### Task 2: 接入 Unity 连接生命周期

**Files:**
- Modify: `tests/bridge-version-sync.test.mjs`
- Modify: `tests/settings-tab-ui.test.mjs`
- Modify: `ui.html`

- [ ] **Step 1: Write failing integration assertions**

新增断言验证：徽标位于插件发布版本右侧；成功连接调用 `setBridgeVersionBadge(data.version, "connected")`；版本不一致在抛错前调用 `setBridgeVersionBadge(data.version, "mismatch")`；断开、选择工程和开始连接调用 `setBridgeVersionBadge("", "disconnected")`。

```js
assert.match(ui, /BEGIN_RELEASE_VERSION[\s\S]*?id="bridgeVersionBadge"/);
assert.match(ui, /setBridgeVersionBadge\(data\.version, "connected"\)/);
assert.match(ui, /setBridgeVersionBadge\(data\.version, "mismatch"\)[\s\S]*?throw createBridgeVersionMismatchError/);
assert.match(ui, /setBridgeVersionBadge\("", "disconnected"\)/);
```

- [ ] **Step 2: Run targeted tests and verify RED**

Run: `node --test tests/bridge-version-sync.test.mjs tests/settings-tab-ui.test.mjs`

Expected: FAIL because the lifecycle calls do not exist.

- [ ] **Step 3: Wire the badge into existing control flow**

在 `probeUnityUrl` 的版本比较分支中先显示错误版本再抛错：

```js
if (!bridgeVersion.matches) {
  setBridgeVersionBadge(data.version, "mismatch");
  throw createBridgeVersionMismatchError(data.version);
}
```

在成功连接时显示实际版本：

```js
setBridgeVersionBadge(data.version, "connected");
```

在 `connectUnity` 开始、`disconnectUnity` 和成功切换工程时重置：

```js
setBridgeVersionBadge("", "disconnected");
```

- [ ] **Step 4: Run targeted and full verification**

Run:

```powershell
node --test tests/bridge-version-sync.test.mjs tests/settings-tab-ui.test.mjs
node --test tests/*.test.mjs
npm run typecheck
npm run build
git diff --check
```

Expected: all tests pass, TypeScript checks succeed, and `git diff --check` reports no errors.

- [ ] **Step 5: Review without committing implementation**

检查工作区仅包含本功能和此前用户保留的未提交改动。除非用户另行要求，不提交实现代码。
