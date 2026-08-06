# Figma AI 整理性能优化方案

## 🐌 当前性能问题

### 实测数据（58个节点）
- **快照采集**: 0.6秒 ✅
- **AI 规划**: ~7分钟 ❌ **主要瓶颈！**
- **执行清理**: 6秒 ✅
- **总耗时**: ~7.1分钟

### 问题根源
`buildCleanupPlanV2ReviewTask()` 在第117行将整个快照 JSON 序列化到提示词：
```typescript
JSON.stringify(snapshot)  // 可能有几十KB甚至几百KB！
```

对于大型节点树：
- 58个节点 → ~10KB 快照 → AI 需要 7 分钟
- 100+个节点 → ~50KB 快照 → AI 可能需要 15+ 分钟

## 🎯 优化方案

### **方案 A：压缩快照数据（推荐）**

**思路：** 只保留 AI 规划需要的核心字段，删除冗余信息。

**当前快照包含：**
```typescript
interface CleanupSnapshotNodeV1 {
  id: string;
  parentId: string;
  type: string;
  name: string;
  siblingIndex: number;
  depth: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  visible?: boolean;
  opacity?: number;
  childCount?: number;
  characters?: string;
  roles?: unknown;
  psd?: unknown;
  [key: string]: unknown;  // 其他字段！
}
```

**优化后：只保留核心字段**
```typescript
interface CompactCleanupSnapshot {
  id: string;
  parentId: string;
  type: string;
  name: string;
  siblingIndex: number;
  depth: number;
  // 删除：x, y, w, h（不影响逻辑分组）
  // 删除：opacity（不影响分组）
  // 保留：visible（可能影响分组决策）
  // 保留：childCount（帮助判断是否需要分组）
  // 删除：characters（文本内容，不影响层级整理）
  // 删除：roles, psd（元数据，不影响分组）
}
```

**实现：**
```typescript
export function buildCleanupPlanV2ReviewTask(snapshot: CleanupSnapshotV1, providerId: PlanningProviderId): string {
  const snapshotHash = computeCleanupSnapshotHash(snapshot);
  
  // 压缩快照：只保留核心字段
  const compactSnapshot = {
    schemaVersion: snapshot.schemaVersion,
    rootNodeId: snapshot.rootNodeId,
    nodes: snapshot.nodes.map(node => ({
      id: node.id,
      parentId: node.parentId,
      type: node.type,
      name: node.name,
      siblingIndex: node.siblingIndex,
      depth: node.depth,
      visible: node.visible,
      childCount: node.childCount
    }))
  };
  
  return [
    "# Figma cleanup PlanReview V2",
    // ... 省略其他指令 ...
    "## Snapshot",
    JSON.stringify(compactSnapshot),  // 使用压缩版本
  ].join("\n");
}
```

**预期效果：**
- 快照大小减少 **60-70%**
- AI 处理时间减少 **50-60%**
- 58个节点：从 7分钟 → **2-3分钟**

---

### **方案 B：使用更快的 AI 模型**

**当前模型：** Claude Opus（最强但最慢）

**可选模型：**
1. **Claude Sonnet** - 速度 3-5x，质量略低 10-15%
2. **Codex** - 如果可用，专为代码优化

**实现：** 在 UI 中添加"快速模式"选项

**预期效果：**
- 使用 Sonnet：**2-3分钟** （从 7分钟）
- 质量权衡：可能生成的分组策略稍微保守

---

### **方案 C：增加进度反馈**

**问题：** 用户不知道 AI 在做什么，只能干等。

**方案：** 显示实时进度：
```
⏳ AI 分析中...
   ✓ 已读取 58 个节点
   ⏳ 正在生成清理计划...
   ⌛ 预计还需 2-3 分钟
```

**实现：** 修改 `cliPlanningTransport.ts`，流式输出进度

---

### **方案 D：客户端预处理（长期方案）**

**思路：** 在 Figma 插件端先做简单分组，AI 只需微调。

**步骤：**
1. 插件端检测明显的模式（九宫格、重复元素）
2. 生成初步分组建议
3. AI 只需验证和优化，而不是从零开始

**预期效果：**
- AI 处理时间 → **30秒 - 1分钟**

---

## ⚡ 立即实施：方案 A + C

### 修改 1: `src/cleanup/cleanupPlanner.ts`
压缩快照数据。

### 修改 2: `src/ai/cliPlanningTransport.ts`
添加进度反馈。

---

## 📊 优化效果预测

| 节点数 | 当前耗时 | 方案A | 方案A+B | 方案A+B+C |
|--------|----------|-------|---------|-----------|
| 58     | 7分钟    | 3分钟 | 1.5分钟 | 1.5分钟+进度 |
| 100    | 15分钟   | 6分钟 | 3分钟   | 3分钟+进度   |
| 200    | 30分钟   | 12分钟| 6分钟   | 6分钟+进度   |

---

## 🚀 实施决策

你想要：

**A. 立即实施方案 A（压缩快照）** - 快速优化，风险低
**B. 实施方案 A + 添加进度反馈** - 用户体验最佳
**C. 研究方案 D（预处理）** - 长期优化方案
**D. 暂不优化，先看看其他节点树的表现**

**请告诉我选择哪个方案，或者我立即实施方案 A？**
