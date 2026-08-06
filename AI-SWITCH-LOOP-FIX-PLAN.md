# AI 切换无限循环修复方案

## 🐛 问题分析

**位置：** `ui.html:3275-3290`

**问题代码：**
```javascript
async function syncAiRunnerToCleanupProvider() {
  var generation = ++aiProviderSyncGeneration;
  aiProviderSyncing = true;
  aiRunnerSelect.value = runnerIdForCleanupProvider(cleanupProviderSelect.value);
  cleanupProviderStatusEl.textContent = "正在切换 AI...";
  refreshAiPromptControls();
  var synced = await selectAiRunner();
  if (generation !== aiProviderSyncGeneration) {
    syncAiRunnerToCleanupProvider();  // ❌ 问题：递归调用导致无限循环
    return false;
  }
  aiProviderSyncing = false;
  if (synced) renderCleanupProviderStatus();
  else cleanupProviderStatusEl.textContent = "AI 切换失败，请检查本机服务。";
  refreshAiPromptControls();
}
```

**根本原因：**
1. 第 3276 行：`++aiProviderSyncGeneration` 每次调用都会增加
2. 第 3282 行：当 `generation !== aiProviderSyncGeneration` 时（说明有新的切换请求）
3. 第 3283 行：**直接递归调用自己**，但没有任何延迟或退出条件
4. 这导致无限递归，每次调用又会增加 `aiProviderSyncGeneration`
5. 循环永远不会停止，不断发送请求到 `/ai-runner/config`

**日志证据：**
```
[18:28:08.386] POST /ai-runner/config - 45ms
[18:28:08.434] POST /ai-runner/config - 48ms  (50ms后)
[18:28:08.483] POST /ai-runner/config - 49ms  (50ms后)
[18:28:08.532] POST /ai-runner/config - 48ms  (50ms后)
[18:28:08.580] POST /ai-runner/config - 48ms  (50ms后)
```

## ✅ 修复方案

### 方案 A：简单修复 - 直接返回（推荐）

```javascript
async function syncAiRunnerToCleanupProvider() {
  var generation = ++aiProviderSyncGeneration;
  aiProviderSyncing = true;
  aiRunnerSelect.value = runnerIdForCleanupProvider(cleanupProviderSelect.value);
  cleanupProviderStatusEl.textContent = "正在切换 AI...";
  refreshAiPromptControls();
  
  var synced = await selectAiRunner();
  
  // 如果在等待期间有新的切换请求，放弃当前结果
  if (generation !== aiProviderSyncGeneration) {
    // ✅ 直接返回，让最新的调用处理
    return false;
  }
  
  aiProviderSyncing = false;
  if (synced) renderCleanupProviderStatus();
  else cleanupProviderStatusEl.textContent = "AI 切换失败，请检查本机服务。";
  refreshAiPromptControls();
}
```

**逻辑：**
- 如果在 `await selectAiRunner()` 期间用户又切换了 provider
- 那么会触发新的 `syncAiRunnerToCleanupProvider()` 调用
- 旧的调用检测到 `generation` 不匹配，直接返回
- 新的调用继续执行
- **不会递归，不会循环**

### 方案 B：增强版 - 取消机制

```javascript
let aiProviderSyncAbortController = null;

async function syncAiRunnerToCleanupProvider() {
  // 取消之前的切换
  if (aiProviderSyncAbortController) {
    aiProviderSyncAbortController.abort();
  }
  
  var generation = ++aiProviderSyncGeneration;
  aiProviderSyncAbortController = new AbortController();
  const signal = aiProviderSyncAbortController.signal;
  
  aiProviderSyncing = true;
  aiRunnerSelect.value = runnerIdForCleanupProvider(cleanupProviderSelect.value);
  cleanupProviderStatusEl.textContent = "正在切换 AI...";
  refreshAiPromptControls();
  
  try {
    if (signal.aborted) return false;
    var synced = await selectAiRunner();
    if (signal.aborted) return false;
    
    if (generation !== aiProviderSyncGeneration) {
      return false;
    }
    
    aiProviderSyncing = false;
    if (synced) renderCleanupProviderStatus();
    else cleanupProviderStatusEl.textContent = "AI 切换失败，请检查本机服务。";
    refreshAiPromptControls();
  } catch (error) {
    if (!signal.aborted) {
      aiProviderSyncing = false;
      cleanupProviderStatusEl.textContent = "AI 切换异常：" + (error.message || error);
      refreshAiPromptControls();
    }
  }
}
```

## 📊 对比

| 方案 | 复杂度 | 安全性 | 推荐 |
|------|--------|--------|------|
| 方案 A | 低 | 高 | ✅ 推荐 |
| 方案 B | 中 | 高 | 可选 |

## 🎯 推荐

使用 **方案 A**：
- 代码改动最小（删除 1 行）
- 逻辑清晰
- 完全解决问题
- 不会引入新的复杂性

## 📝 修改清单

1. **ui.html:3283** - 删除递归调用这一行
2. 测试：连续快速切换 AI provider
3. 验证：日志中不再出现连续请求

## ✅ 预期效果

修复后：
- ✅ 切换 AI 不再卡住
- ✅ 连续切换会取消旧请求，只执行最新的
- ✅ 不会无限循环
- ✅ UI 响应正常
