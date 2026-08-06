# AI 切换卡住问题诊断

## 问题现象
"正在切换 AI..." 卡住 1 分钟

## 根本原因

调用 `/ai-runner/config` 时返回错误：
```
"AI runner actions require a live local Figma plugin session."
```

## 原因分析

从代码分析：
1. UI 生成 `relaySessionId` (第1238行)
2. WebSocket 连接时注册这个 sessionId (第4065行)
3. 调用 `/ai-runner/config` 时传递这个 sessionId (第3247行)

**可能的问题：**
1. **WebSocket 还没连接成功** - UI 加载后立即切换 AI，但 WebSocket 还在连接中
2. **sessionId 不匹配** - UI 的 sessionId 和服务器记录的不一致
3. **超时时间太短** - fetchWithTimeout 设置为 6秒，但请求可能需要更长时间

## 解决方案

### 方案 1: 增加超时时间（临时）
修改第3249行：
```javascript
// 从 6000ms 增加到 30000ms
var response = await fetchWithTimeout(..., 30000);
```

### 方案 2: 等待 WebSocket 连接（推荐）
在 `selectAiRunner()` 前检查 WebSocket 状态：
```javascript
async function selectAiRunner() {
  // 等待 WebSocket 连接
  if (!relaySocket || relaySocket.readyState !== WebSocket.OPEN) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (!relaySocket || relaySocket.readyState !== WebSocket.OPEN) {
      aiRunnerStatusEl.textContent = "WebSocket 未连接，请稍后重试";
      return false;
    }
  }
  // ... 原有逻辑
}
```

### 方案 3: 使用更可靠的 sessionId
使用服务器返回的真实 sessionId，而不是 UI 自己生成的。

## 立即修复

最简单的修复：**增加超时时间**
