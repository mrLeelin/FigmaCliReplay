# 踩坑规则: Figma documentAccess dynamic-page 模式下 findAll 必须先 loadAllPagesAsync

## 发现时间

2026-05-14，UI_Buff_1 导入

## 错误现象

Figma Relay 插件执行 `figma.root.findAll()` 时抛出异常：

```
in findAll: Cannot call with documentAccess: dynamic-page without calling figma.loadAllPagesAsync() first.
```

## 根本原因

Figma 插件 manifest `documentAccess: "dynamic-page"` 模式下，`findAll` 只能访问当前已加载页面的节点。要搜索所有页面（如查找已有 Component），必须先调用 `figma.loadAllPagesAsync()` 加载全部页面内容。

## 修复

在 `writePrefabToFigmaJob` 函数开头添加：

```javascript
// dynamic-page documentAccess 下 findAll 需要先加载所有页面
try { await figma.loadAllPagesAsync(); } catch (e) { /* 非 dynamic-page 模式可忽略 */ }
```

## 影响范围

- 文件：`<relay-root>/code.js`
- 所有涉及 `figma.root.findAll` 搜索已有 Component 的导入流程
- 搜索范围覆盖全文件时都需要此调用

## 预防

1. 所有新的 Relay 操作（PREFAB_TO_FIGMA_WRITE、PREFAB_CHECK 等）在需要搜索全文件组件时，必须先 `loadAllPagesAsync()`
2. 插件 manifest 保持 `documentAccess: "dynamic-page"`（不对文件做全量加载，只在需要时主动加载）
