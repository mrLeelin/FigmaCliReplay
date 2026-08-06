# AI 切换超时修复 - 2026-07-18

## ✅ 修复完成

**问题:** 切换 AI provider 时一直显示"正在切换 AI..."，无法完成切换

**根本原因:** `/ai-runner/config` API 请求超时时间设置为 6 秒，但 AI provider（特别是 Claude Code CLI）初始化可能需要 10-20 秒

## 🔧 修复内容

### 修改文件: `ui.html`

**位置:** 第 3249 行

**修改前:**
```javascript
var response = await fetchWithTimeout(
  normalizeRelayUrl(relayUrl) + "/ai-runner/config", 
  { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, 
  6000  // ❌ 6 秒超时
);
```

**修改后:**
```javascript
var response = await fetchWithTimeout(
  normalizeRelayUrl(relayUrl) + "/ai-runner/config", 
  { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, 
  30000  // ✅ 30 秒超时
);
```

## 📊 Diff

```diff
--- ui.html (修改前)
+++ ui.html (修改后)
@@ -3246,7 +3246,7 @@
       try {
         var payload = { runner: aiRunnerSelect.value, sessionId: relaySessionId };
         aiRunnerStatusEl.textContent = "正在切换 AI...";
-        var response = await fetchWithTimeout(normalizeRelayUrl(relayUrl) + "/ai-runner/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, 6000);
+        var response = await fetchWithTimeout(normalizeRelayUrl(relayUrl) + "/ai-runner/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, 30000);
         var result = await response.json();
         if (!response.ok || !result.ok) throw new Error(result.error || "本机 AI 请求失败");
         aiRunnerSelect.value = result.config.runner || aiRunnerSelect.value;
```

## 🎯 预期效果

- ✅ AI provider 切换不再超时
- ✅ 有足够时间完成 provider 初始化（最多 30 秒）
- ✅ 用户界面不再卡在"正在切换 AI..."状态

## 🔄 如何回滚

### Windows (PowerShell):
```powershell
.\.rollback-ai-switch-timeout.ps1
```

### Linux/Mac (Bash):
```bash
bash .rollback-ai-switch-timeout.sh
```

## ✅ 验证状态

- **类型检查:** ✅ 通过 (`npm run typecheck`)
- **代码修改:** ✅ 完成
- **回滚脚本:** ✅ 已创建

## 📋 下一步测试

1. 重新加载 Figma 插件
2. 在插件中切换 AI provider (Codex ↔ Claude Code)
3. 观察是否能在 30 秒内完成切换
4. 确认不再显示超时错误

---

**修复时间:** 2026-07-18  
**修改行数:** 1 行  
**影响范围:** AI provider 切换功能
