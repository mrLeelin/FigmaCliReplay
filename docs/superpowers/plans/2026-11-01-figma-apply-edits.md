# FIGMA_APPLY_EDITS：白名单批量编辑计划

日期：2026-11-01。状态：待确认，尚未修改代码。

## 目标

让 Claude 通过 figma-relay CLI 完成 Figma agent 式的通用设计修改：改颜色、改文字、加 auto layout、调间距、新建 frame、放组件实例、绑定变量。

所有写入走一个新 job `FIGMA_APPLY_EDITS`。它只接受白名单内的操作，由 Relay 用 zod 严格校验，插件按事务执行，失败时整批回滚。

另加一个只读 job `FIGMA_INSPECT_NODES`，让 Claude 修改前能读到节点的视觉属性。

## 不做的事

- 不做「执行任意 Plugin API 代码」，这和 Relay 闸门是安全边界的原则冲突。
- 第一批不做：矢量路径编辑、图片上传、原型交互、导出、删除页面。删除节点继续用现有 `DELETE_NODE_BY_ID`。
- 不改现有 job 的行为。

## 1. 读取：FIGMA_INSPECT_NODES（只读）

输入：`{ nodeIds: string[1..50], depth: 0..3（默认 1）, includeText: boolean }`

每个节点返回：
- 公共字段：`id`、`name`、`type`、`x`、`y`、`width`、`height`、`visible`、`opacity`、`parentId`
- `fills` / `strokes`：只返回 SOLID 的 `#RRGGBB` 和 alpha；其他类型只标注 `type`
- `cornerRadius`、`strokeWeight`
- auto layout：`layoutMode`、`itemSpacing`、`padding*`、`primaryAxisAlignItems`、`counterAxisAlignItems`、`primaryAxisSizingMode`、`counterAxisSizingMode`、子节点的 `layoutSizingHorizontal/Vertical`
- TEXT：`characters`（截断到 2000 字）、`fontName`、`fontSize`、`textAlignHorizontal`、`lineHeight`
- INSTANCE：`mainComponentId`、`componentProperties`（名称、类型、当前值）
- `boundVariables`：属性名映射到变量 ID
- 子节点按 `depth` 递归，单次最多返回 500 个节点，超过则返回 `truncated: true`

截图继续用现有 `FIGMA_EXPORT_NODE_SCREENSHOT`。它已经把 PNG 存成文件、从结果里去掉 base64，不需要改。

## 2. 写入：FIGMA_APPLY_EDITS

输入：
```json
{
  "dryRun": false,
  "edits": [
    { "op": "setFill", "nodeId": "1:2", "color": "#FF6600", "opacity": 1 },
    { "op": "setText", "nodeId": "1:3", "characters": "购买" }
  ]
}
```

单次最多 100 条 edit。

### 第一批白名单操作

| op | 参数 | 说明 |
|---|---|---|
| `setFill` | `nodeId`, `color` #RRGGBB, `opacity` 0..1 | 替换为单一纯色填充 |
| `setStroke` | `nodeId`, `color`, `weight` 0..100 | 单一纯色描边 |
| `setCornerRadius` | `nodeId`, `radius` 0..10000 | |
| `setOpacity` | `nodeId`, `opacity` 0..1 | |
| `setVisible` | `nodeId`, `visible` | |
| `rename` | `nodeId`, `name` 1..200 字 | |
| `setText` | `nodeId`, `characters` 0..5000 字 | 先加载原字体；有混合字体时拒绝 |
| `setTextStyle` | `nodeId`, `fontSize` 1..1000, `fontFamily`/`fontStyle`（可选）, `align`（可选） | 字体加载失败则拒绝，不做替换 |
| `setAutoLayout` | `nodeId`, `mode` NONE/HORIZONTAL/VERTICAL, `itemSpacing`, `padding`, `primaryAlign`, `counterAlign`, `sizing` | 仅 FRAME / COMPONENT / INSTANCE |
| `setLayoutSizing` | `nodeId`, `horizontal`/`vertical` FIXED/HUG/FILL | 父节点必须是 auto layout |
| `createFrame` | `parentId`, `tempId`, `name`, `width`, `height`, `x`/`y`（可选）, `index`（可选） | `tempId` 供同批后续 edit 引用 |
| `createText` | `parentId`, `tempId`, `characters`, `fontSize`, `fontFamily`/`fontStyle` | |
| `createInstance` | `parentId`, `tempId`, `componentId`, `index`（可选） | 组件必须在当前文件中 |
| `setInstanceProperties` | `nodeId`, `properties`（名称映射到值） | 只能设置组件上已定义的属性 |
| `bindVariable` | `nodeId`, `field`（白名单字段）, `variableId` | 用于 fills、itemSpacing、padding*、cornerRadius 等 |

`nodeId` 也可以写成 `"temp:<tempId>"`，引用同一批里刚创建的节点。

### 约束

- 不允许修改 PAGE 和 DOCUMENT。
- 不能对远程库组件的主组件做写入。
- 所有 `nodeId` 必须在同一页面。
- 同一节点的同一属性在一批里只能出现一次，否则直接拒绝。

## 3. 执行模型

1. **Relay 校验**：在 `relayProtocol.ts` 新增 `figmaApplyEditsJobSchema`（zod `discriminatedUnion("op")` + `.strict()`）。在 `relayCliEndpoint.ts` 派发前校验，不通过则返回 `INVALID_REQUEST`，并给出第几条 edit、哪个字段出错。
2. **插件预检**（不写入）：解析全部节点、检查类型和字体，并预加载字体。任一条失败则整批拒绝，返回 `blockingErrors`，画布不变。
3. **快照**：对每个被修改的节点，记录将要修改的属性的原值。记录新创建的节点。
4. **执行**：按顺序逐条应用。
5. **失败回滚**：任一条出错时，删除新建节点，恢复所有原值，然后核对恢复结果。结果返回 `rollback: { pass, errors, mismatches }`。
6. **成功**：调用一次 `figma.commitUndo()`，让你在 Figma 里按一次 Ctrl+Z 就能撤销整批修改。返回每条 edit 的 `before`/`after` 摘要，以及 `tempId` 到真实 ID 的映射。
7. **`dryRun: true`**：只做 1–2 步，返回将修改的内容，不写入。

## 4. 写入闸门

在 `cleanupAiWriteGuard.ts` 中：
- `FIGMA_INSPECT_NODES` 加入 `ReadOnlyJobTypes`。
- `FIGMA_APPLY_EDITS` 不加入 `HierarchyJobTypes` 和 `VariantJobTypes`。

效果：AI 整理会话进行中时，`FIGMA_APPLY_EDITS` 一律被拒绝，避免绕过分阶段确认。

整理会话之外，这一层是否需要额外加闸门，作为下面的「待你决定 #1」。

## 5. Skill：figma-design-edit

新增 `ai/skills/figma-design-edit/SKILL.md`，规定 Claude 的工作流：

1. `selection` 获取目标节点 → `FIGMA_INSPECT_NODES` 读属性 → 必要时截图。
2. 用中文列出修改计划：每条写清楚改哪个节点、从什么改成什么。
3. **等用户明确确认后**，先用 `dryRun: true` 跑一次，再正式写入。
4. 写入后重新截图，并用 `FIGMA_INSPECT_NODES` 核对；不一致时说明原因，不自动连续重试。
5. 告诉用户可以在 Figma 里按 Ctrl+Z 撤销。

Skill 只描述流程，安全由 Relay 校验和插件事务保证。

## 6. 日志点

同一个 `operationId` 贯穿 CLI → Relay → UI → 插件。

| 位置 | 记录内容 |
|---|---|
| Relay 校验 | started；edit 总数、各 op 计数；失败时记录第几条、字段、原因 |
| 插件预检 | 解析的节点数、缺失节点、类型不符、字体加载结果 |
| 插件执行 | 每条 edit 的 op、nodeId、成功/失败（不记文字原文，只记长度） |
| 回滚 | 恢复数、失败数、mismatch 数、残留风险 |
| 结果 | succeeded / failed / dry-run；耗时；新建节点数 |

## 7. 代码改动

| 文件 | 改动 |
|---|---|
| `src/relayProtocol.ts` | 新增两个 job 的 zod schema |
| `src/relayCliEndpoint.ts` | 针对这两个 jobType 在派发前调用 schema 校验 |
| `src/cleanupAiWriteGuard.ts` | `FIGMA_INSPECT_NODES` 加入只读集合 |
| `code/10_apply_edits.mjs`（新） | 纯函数：预检、快照、应用、回滚；不直接依赖全局 `figma`，便于测试 |
| `code/01_handlers.js` | 注册两个 message type，转发到新模块 |
| `scripts/build.py` | 把 `10_apply_edits.mjs` 加入构建顺序 |
| `ai/skills/figma-design-edit/SKILL.md`（新） | 工作流 |
| `tests/figma-apply-edits-schema.test.mjs`（新） | Relay 校验测试 |
| `tests/figma-apply-edits.test.mjs`（新） | 用假节点测试插件模块 |

不改 `ui.html`：它已经原样转发任意 job，`_RESULT` 消息也会自动回传。

## 8. 测试

**单元测试**
- schema：合法批次通过；未知 op、多余字段、颜色格式错误、超过 100 条、同一属性重复，均被拒绝。
- 插件模块（假节点）：
  - 每种 op 应用成功
  - 预检失败时不写入
  - 第 N 条失败时完整回滚，包括删除新建节点
  - `temp:` 引用解析
  - `dryRun` 不写入
  - 混合字体的文字被拒绝
- 闸门：整理会话进行中，`FIGMA_APPLY_EDITS` 被拒绝；`FIGMA_INSPECT_NODES` 允许。

**回归**：`tsc`、现有 CLI 测试、`cleanup-ai-write-guard` 测试、`cleanup-transaction` 测试。

**实测**（在「推币机_资源库」上，只操作克隆体）：克隆节点 → inspect → 改填充、改文字、加 auto layout → 截图核对 → 故意制造一条失败、确认整批回滚 → 删除克隆体。

## 9. 分步执行（每步完成后给你看 diff，确认后再继续）

1. Relay：两个 schema + 校验 + 闸门 + schema 测试。
2. 插件只读：`FIGMA_INSPECT_NODES` + 测试 + 构建 + 实测读取。
3. 插件写入：`FIGMA_APPLY_EDITS` 中的属性修改类 op + 事务回滚 + 测试。
4. 插件写入：创建类 op（frame、text、instance）和 `bindVariable` + 测试。
5. Skill 文件 + 完整实测。

## 决定

1. **整理会话之外的写入不加闸门**（2026-11-01 用户选择 A）。靠 skill 要求先确认，再由 Relay 白名单校验、`dryRun`、事务回滚和一键撤销兜底。AI 整理会话进行中时，`FIGMA_APPLY_EDITS` 仍被现有闸门拒绝。
2. **第一批范围**：按第 9 节分 5 步执行，每步完成后等用户确认。
