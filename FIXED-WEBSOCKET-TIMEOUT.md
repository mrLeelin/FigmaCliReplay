# Figma 节点 AI 整理超时问题 - 修复完成报告

## ✅ 问题已解决

**修复时间:** 2026-07-17  
**影响文件:** `ui.html`  
**测试状态:** ✅ 全部通过 (47个测试)

---

## 🔍 问题回顾

### 症状
- 用户选择 Figma 节点后，使用 AI 整理功能
- 任务被服务器接收并分发给插件
- 插件开始执行，但 5 分钟后服务器报告 "Relay job lease expired"
- 实际上清理可能还在执行或已经完成，但服务器认为任务超时

### 根本原因
UI 端在将任务转发给插件后**立即**向服务器发送 `command.response`（表示任务完成），但插件端的异步清理工作才刚开始。服务器收到响应后认为任务完成并释放资源，但实际清理还在进行中。

**错误的时序：**
```
1. WebSocket 收到任务
2. UI: executeJob() → 转发消息给插件
3. UI: 立即发送 command.response ❌ (这里就出问题了！)
4. 插件: handleFigmaHierarchyCleanupTransaction() 开始执行
5. 服务器: 认为任务完成，5分钟后清理租约
6. 插件: 执行完成，发送 RESULT
7. 服务器: 但租约已过期！
```

---

## 🔧 修复方案

### 修改 1: `ui.html` 第4145-4150行
**移除过早的 command.response**

```diff
  executeJob(payload)
    .then(function () {
-     if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
-       relaySocket.send(JSON.stringify({ 
-         type: "command.response", 
-         id: payload.requestId, 
-         requestId: payload.requestId, 
-         accepted: true 
-       }));
-     }
+     // 不再立即发送 command.response，等待插件端的 _RESULT 消息
    })
```

### 修改 2: `ui.html` 第5810-5821行
**在实际结果回传后发送 command.response**

```diff
  (async function () {
    try {
      await postResult(message.requestId, result);
      var summary = ...;
      appendLog("任务完成 (" + message.type + ")：...");
      setAiStatus("任务完成：" + (result.status || "unknown"));
+     
+     // 在结果回传成功后发送 command.response
+     if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
+       relaySocket.send(JSON.stringify({
+         type: "command.response",
+         id: message.requestId,
+         requestId: message.requestId,
+         accepted: true
+       }));
+     }
    } catch (e) {
      appendLog("任务完成但结果回传失败：" + (e.message || e));
    }
    scheduleNextPoll(500);
    processRelaySocketQueue();
  })();
```

**正确的时序：**
```
1. WebSocket 收到任务
2. UI: executeJob() → 转发消息给插件
3. 插件: handleFigmaHierarchyCleanupTransaction() 执行
4. 插件: 执行完成，发送 FIGMA_HIERARCHY_CLEANUP_TRANSACTION_RESULT
5. UI: 收到 RESULT，通过 HTTP 回传服务器
6. UI: 回传成功后发送 command.response ✅ (正确时机！)
7. 服务器: 任务完成，清理租约
```

---

## 🧪 测试验证

### 运行的测试
```bash
node --test tests/*.test.mjs
```

### 测试结果
```
✅ 47 个测试全部通过
- AI provider 集成测试: 通过
- Cleanup planner 测试: 通过
- Cleanup controller 测试: 通过
- WebSocket 任务执行测试: 通过
- HTTP API 测试: 通过
- UI 集成测试: 通过
```

**关键测试：**
- ✅ `websocket jobs remain executing until the Figma main-thread result arrives` - 验证 WebSocket 任务等待插件结果
- ✅ `approved cleanup executes and reaches a terminal state` - 验证清理任务正确执行到终态
- ✅ `execution report accepts only explicit terminal transaction states` - 验证只接受显式终态

---

## 📊 影响范围

### 受益的功能
1. **AI 层级整理** - 主要修复目标 ✅
2. **PSD 导入** - 同样受益
3. **Prefab 导出** - 同样受益
4. **所有通过 WebSocket 执行的长时间任务**

### 不受影响的功能
- HTTP 轮询模式 (fallback)
- 同步操作（选区更新、配置读取等）
- Unity Bridge 连接

---

## 🔄 回滚方案

如果需要回滚此修复：

```bash
# 方式 1: 使用 Git
git checkout ui.html

# 方式 2: 使用保存的补丁
git apply --reverse .rollback-websocket-fix.patch

# 方式 3: 使用回滚脚本
bash .rollback-websocket-fix.sh
```

---

## 📝 使用说明

### 对用户的影响
**✅ 无需任何操作！** 修复完全向后兼容。

### 预期行为变化
1. **之前:** AI 整理任务可能在 5 分钟后超时
2. **现在:** AI 整理任务会等待实际完成后才标记为完成

### 性能影响
- **延迟:** 无显著变化（只是改变了响应时机）
- **超时保护:** 依然保留 8 秒 watchdog 超时
- **错误处理:** 保持不变

---

## 🎯 下一步建议

### 立即行动
1. ✅ **重启服务** - 让修复生效
   ```bash
   npm run oneclick
   ```

2. ✅ **测试场景** - 选择一个复杂的 Figma 节点进行 AI 整理

3. ✅ **监控日志** - 确认不再出现 "lease expired" 警告

### 长期改进
1. 考虑为超大节点树增加进度反馈
2. 优化清理算法性能
3. 添加更详细的执行时间统计

---

## 📞 技术支持

如果修复后仍有问题：

1. **检查日志**
   - `.logs/figma-mcp-relay.stdout.log`
   - `.logs/figma-mcp-relay.stderr.log`

2. **验证 WebSocket 连接**
   - 打开插件 UI，查看 "WebSocket 已连接" 消息

3. **尝试回滚**
   - 使用上述回滚方案恢复原始代码
   - 报告问题以便进一步诊断

---

## ✨ 总结

**问题：** AI 整理节点时任务超时  
**原因：** UI 过早告知服务器任务完成  
**修复：** 等待插件实际完成后再响应  
**验证：** 47 个测试全部通过  
**状态：** ✅ **修复完成，可以使用！**

---

*修复完成时间: 2026-07-17 13:20 UTC+8*
