# Figma 整理模块 V2 设计

## 1. 文档状态

本文定义 FigmaMcpRelay 中“AI 整理节点”功能的下一版边界、状态机、AI Provider 抽象、计划契约、事务执行、错误恢复和验收标准。

本文覆盖并取代 `2026-07-17-cleanup-plan-performance-design.md` 中与整理确认、AI 续跑、自动组件化和应用流程有关的设计；原文关于有界快照和只读 PlanReview 的原则继续保留。

## 2. 目标

整理模块必须满足以下目标：

1. AI 只生成完整、可验证的层级整理计划，不直接修改 Figma。
2. 用户看到并确认的计划必须等于最终执行的全部修改。
3. 整理仅处理层级、顺序、命名和必要的 Auto Layout，不自动创建 Component 或 ComponentSet。
4. 支持 Codex、Claude Code，以及未来其他 AI Provider，整理业务不依赖任何 Provider 的会话能力。
5. 不在 Figma 节点上长期挂载自定义 `FigmaNodeID`，也不把本地 JSON 作为第二份业务源数据。
6. 同一结构重复整理应返回 no-op，不得继续套壳。
7. 应用失败或取消时优先自动回滚，并明确报告是否已经恢复。
8. 不使用隐藏任务队列，用户始终能看到当前任务和可执行动作。

## 3. 非目标

本次改造不包括：

- 自动 Component/ComponentSet/Variant 创建；
- PSD 增量身份体系的重新设计；
- 九宫格识别或 Unity 导入流程修改；
- 通用持久化任务系统；
- Web 前端框架或打包体系迁移；
- Provider 失败后的静默自动切换。

组件化后续作为独立功能、独立计划和独立确认流程设计。

## 4. 总体架构

```text
Figma UI
  -> CleanupController
      -> CleanupPlanner
          -> PlanningProviderRegistry
              -> CodexCliProvider
              -> ClaudeCodeCliProvider
      -> CleanupPlanValidator
      -> CleanupRunStore
      -> CleanupExecutor
          -> apply_cleanup_plan.py
              -> FIGMA_HIERARCHY_CLEANUP_TRANSACTION
                  -> preflight / apply / verify / rollback
```

核心约束是：规划层只能产生计划，验证层决定计划是否可确认，执行层只能消费已经确认的计划。任何阶段都不得在确认后重新发现并追加写操作。

## 5. 模块边界

### 5.1 整理领域模块

新增目录：

```text
src/cleanup/
  cleanupTypes.ts
  cleanupController.ts
  cleanupPlanner.ts
  cleanupPlanValidator.ts
  cleanupExecutor.ts
  cleanupRunStore.ts
```

职责如下：

- `cleanupTypes.ts`：计划、操作、状态、错误和 HTTP 数据类型。
- `cleanupController.ts`：生命周期、并发锁、确认令牌、状态流转和清理策略。
- `cleanupPlanner.ts`：构造 Provider 无关的整理请求，并将 Provider 原始输出交给公共提取器。
- `cleanupPlanValidator.ts`：结构校验、语义门禁、快照一致性和 no-op 判断。
- `cleanupExecutor.ts`：提交已确认计划、接收结构化进度、处理取消和最终结果。
- `cleanupRunStore.ts`：保存本次进程中的临时运行状态，任务结束后定时清理。

### 5.2 通用 AI Provider 模块

新增目录：

```text
src/ai/
  planningProvider.ts
  providerRegistry.ts
  codexCliProvider.ts
  claudeCodeCliProvider.ts
```

统一接口：

```ts
interface PlanningProvider {
  readonly id: string;
  readonly label: string;

  detectAvailability(): Promise<ProviderAvailability>;

  generatePlan(
    request: PlanningRequest,
    context: {
      signal: AbortSignal;
      onProgress: (event: PlanningProgress) => void;
    },
  ): Promise<PlanningResult>;
}
```

Provider 只负责 CLI 可用性检测、进程启动、Prompt 输入、输出收集、取消和诊断信息。它不负责解析整理计划、保存整理状态、用户确认或修改 Figma。

Codex session ID、Claude conversation ID 和 resume 能力只能写入诊断信息，不参与确认按钮、计划授权或执行判断。

### 5.3 现有模块收缩

`src/localAiRunner.ts` 最终只保留通用子进程能力：启动、输出捕获、心跳、总超时、空闲超时、取消和进程树终止。整理专用状态、followup、`sessionAvailable` 和 Provider 会话恢复逻辑迁移出去。

`src/httpServer.ts` 只负责路由、鉴权和输入边界，整理请求全部委托给 `CleanupController`。

`run_cleanup_pipeline.py` 在迁移期保留兼容入口，但新整理流程改用薄脚本 `apply_cleanup_plan.py`。新脚本只读取已确认计划、提交一个事务 Job，并转发进度和结果；它不再规划嵌套结构或自动组件化。

Figma 侧新增 `code/08_cleanup_transaction.mjs`，复用 `code/04_hierarchy.js` 中的底层创建、移动和布局能力，并集中实现 preflight、逆操作记录、执行、验证和回滚。

## 6. AI Provider 选择

整理面板在“AI 整理”按钮旁显示 Provider 下拉框，首批支持：

- Codex
- Claude Code

服务端提供只读可用性接口：

```http
GET /ai-runner/providers
```

返回 Provider ID、显示名称、是否可用、版本和不可用原因。检测结果短时间缓存，避免每次刷新 UI 都启动 CLI。

用户的上次选择由插件主线程通过 `figma.clientStorage` 保存，例如键名 `cleanup.preferredPlanningProvider`。该值属于本机用户偏好，不写入 Figma 文档，不参与整理计划，也不是 PSD/Figma 数据源。参考：https://developers.figma.com/docs/plugins/api/figma/

恢复规则：

1. 上次选择仍可用时继续使用。
2. 上次选择不可用时保留选择并显示原因，但禁止开始。
3. 用户必须主动选择可用 Provider。
4. Provider 启动失败、超时或输出非法时，不静默切换到其他 Provider。

开始整理时请求必须携带 `providerId`，服务端仅接受注册表中的允许值，不能执行 UI 传入的任意命令。

## 7. 状态机与并发

整理使用唯一状态枚举：

```text
idle
  -> capturing
  -> planning
  -> validating
  -> review
  -> applying
  -> verifying
  -> succeeded
```

异常终态：

```text
failed
cancelled
rolled_back
recovery_required
```

不再使用 `status=completed + phase=awaiting-approval` 之类的组合状态，也不再依赖 `sessionAvailable`。

每个 Figma 插件会话同时只允许一个整理任务。再次点击时不创建隐藏队列：

- `planning`：重新显示当前进度和取消按钮；
- `review`：重新打开同一确认窗口；
- `applying/verifying`：显示当前执行进度；
- 终态：清理旧控制状态后允许新建任务。

服务端同时以插件会话和根节点建立锁，防止重复 HTTP 请求绕过 UI。

## 8. 快照与计划契约

### 8.1 快照

继续使用有界层级快照，保留现有节点数、深度、文本长度和序列化大小限制。快照只包含层级规划所需字段，不包含图片字节、令牌、无关页面或机器路径。

`snapshotHash` 对规范化后的结构字段计算，包括节点 ID、父节点、兄弟顺序、名称、类型、几何、布局、截断后的文本内容和相关角色标志；排除时间戳、当前选择和日志字段。

快照是一次事务输入，不是长期数据源。服务重启后旧计划失去执行授权，必须重新抓取快照和生成计划。

### 8.2 CleanupPlanV2

```ts
interface CleanupPlanV2 {
  schemaVersion: 2;
  rootNodeId: string;
  snapshotHash: string;
  operations: CleanupOperation[];
  preconditions: CleanupPrecondition[];
  verification: CleanupVerification;
  warnings: string[];
}
```

允许的操作类型：

```text
CREATE_GROUP
RENAME_NODE
MOVE_NODE
REORDER_CHILDREN
SET_AUTO_LAYOUT
```

计划中禁止 Component、ComponentSet、Variant、图片替换、删除原始内容以及任何未声明的任意属性写入。

公共提取器接受纯 JSON，或只包裹一个 JSON 对象的 `json` Markdown 围栏。它不从说明文字中猜测或修复损坏 JSON。

### 8.3 语义门禁

验证器必须保证：

- 根节点和 `snapshotHash` 匹配；
- 所有节点都属于快照；
- 每个节点的使用次数、父子关系和相对顺序合法；
- 计划没有未声明或被禁止的操作；
- 已有语义容器不会被同义容器再次包装；
- 默认禁止只有一个子节点的新分组；
- 计划不能增加无收益的层级深度；
- 验证条件必须约束节点绝对位置和尺寸在允许误差内不变；
- 文本、图片内容和 PSD SharedPluginData 不得被层级整理操作修改；
- 如果当前结构已满足目标，则返回 no-op；
- 同一快照重复整理时，第二次必须得到 no-op。

## 9. 确认与执行一致性

UI 预览展示所有精确操作、受影响节点、警告和验证摘要。确认按钮只在 `state=review` 且计划通过验证时启用。

确认请求携带 `runId`、一次性确认令牌和 `snapshotHash`。执行前 Figma 端重新读取结构并运行 preflight；任何节点、父级、顺序、名称、几何或布局前置条件发生变化时，整个计划在写入前失败，并要求重新规划。

执行器只能逐条消费 `CleanupPlanV2.operations`，不得调用 `plan_root`、自动嵌套发现、自动组件候选发现或其他会增加写操作的分析函数。

## 10. 事务、取消与恢复

Figma 事务 Job 在写入前创建不可见且锁定的临时根节点副本，名称使用 `__cleanup_backup__<runId>`。它同时在内存中记录每个操作的逆操作，包括原父节点、原索引、原名称、原布局属性和本次创建的节点。

临时副本可能包含克隆得到的 PSD SharedPluginData，因此 PSD 增量更新、Unity 导出和其他节点发现逻辑必须忽略位于 `__cleanup_backup__` 根节点之下的所有节点。这样画布上虽然短暂存在恢复副本，业务上仍只有非备份树可以成为活动数据源；遗留备份没有处理完成前也不得启动新的增量更新或整理任务。

正常失败或取消时：

1. 停止后续操作；
2. 逆序执行内存中的逆操作；
3. 验证结构是否恢复；
4. 回滚成功后删除临时副本；
5. 回滚失败时保留临时副本并进入 `recovery_required`。

正常回滚以逆操作为主，因此保留原节点 ID。临时副本只用于进程崩溃或逆操作失败后的人工确认恢复，不作为长期业务数据。若最终选择用副本替换损坏根节点，Figma 会生成不同的节点 ID；在“不持久化自定义节点映射”的约束下，硬崩溃后的身份完全无损恢复不作为保证。

取消规则：

- `planning`：终止对应 Provider 进程树；
- `review`：丢弃一次性授权，不修改 Figma；
- `applying`：设置 `cancelRequested`，在当前原子操作结束后回滚；
- 优雅取消超过宽限期后才强制终止，并保留故障恢复副本。

插件启动时检测遗留 `__cleanup_backup__` 节点，并提供恢复、保留当前结果并删除备份、暂不处理三个选项。

## 11. HTTP 接口

新接口：

```text
GET  /ai-runner/providers
POST /cleanup/runs
GET  /cleanup/runs/:runId
POST /cleanup/runs/:runId/approve
POST /cleanup/runs/:runId/cancel
```

旧 `/ai-runner/run-cleanup` 和整理 followup 接口在迁移期保留兼容转发，UI 切换完成并通过发布验证后删除。

运行访问继续使用不可猜测 capability token。日志可以记录 Provider ID、版本、阶段、耗时、退出码和 `runId`，但不得记录访问令牌、完整环境变量或其他凭证。

## 12. 错误模型

稳定错误码：

```text
CLEANUP_ALREADY_RUNNING
SNAPSHOT_TOO_LARGE
PROVIDER_UNAVAILABLE
PROVIDER_START_FAILED
PLANNING_TIMEOUT
PLAN_JSON_INVALID
PLAN_SEMANTIC_INVALID
SNAPSHOT_CHANGED
APPLY_FAILED_ROLLED_BACK
APPLY_FAILED_RECOVERY_REQUIRED
CANCELLED
CANCELLED_ROLLED_BACK
PLUGIN_DISCONNECTED
```

UI 展示中文说明、当前阶段和可执行动作；技术细节写入对应 `runId` 的诊断日志。

## 13. 超时与进度

超时由 `CleanupController` 统一编排，外层工作流超时必须大于内部步骤上限与回滚余量，不能再由多个固定 5 分钟计时器互相抢占。

| 阶段 | 正常目标 | 超时上限 |
| --- | ---: | ---: |
| 快照采集 | 5 秒内 | 15 秒 |
| AI 规划 | 60-120 秒 | 180 秒 |
| 100 节点应用 | 30 秒内 | 120 秒 |
| 验证 | 15 秒内 | 45 秒 |
| 回滚 | 30 秒内 | 60 秒 |

UI 每 1-2 秒获得状态或心跳，并显示具体进度，例如“正在执行 7/23”或“正在回滚 4/7”。有心跳但没有新文本输出时，不判定为卡死。

## 14. 临时数据策略

`task.md`、原始 Provider 输出、验证后的计划和报告可以继续写入 `.tmp/ai-runs/<runId>/` 作为诊断回执，但必须满足：

- 不作为 PSD/Figma 的长期身份来源；
- 不允许服务重启后直接恢复执行；
- 运行授权只存在于当前进程；
- 按保留周期自动清理；
- 文件丢失只影响诊断，不影响真实 Figma 数据。

## 15. 迁移顺序

1. 建立 `CleanupPlanV2`、Provider 接口和契约测试，不改变现有发布行为。
2. 拆出 `CleanupController` 和唯一状态机，修复 UI 对 `sessionAvailable` 的依赖。
3. 接入 Provider 可用性接口、UI 下拉框和 `figma.clientStorage` 偏好保存。
4. 禁用旧应用路径中的自动嵌套发现和自动组件化，执行内容严格来自计划。
5. 接入单次 Figma 事务 Job、逆操作回滚和取消语义。
6. 增加幂等门禁、并发锁、故障备份检测和恢复 UI。
7. 删除旧 followup、死代码和过期测试，更新使用文档。
8. 完成打包发布和真实 50-100 节点端到端验证。

每一步必须保持可独立测试和回退，不能在同一个提交中同时重写 Provider、UI、事务执行和旧管线删除。

## 16. 验收标准

自动化测试必须覆盖：

- Codex 和 Claude Code 输出都进入同一个 `CleanupPlanV2` 契约；
- 两种 Provider 的纯 JSON 和单一 Markdown JSON 围栏均可解析；
- Provider 不可用、非法 `providerId`、启动失败、超时和取消行为明确；
- Provider 失败后不会静默切换；
- 上次 Provider 选择能够恢复，且不依赖 WebView `localStorage`；
- 没有任何 AI session ID 也能确认和执行；
- UI 预览操作集合与执行操作集合完全相同；
- 计划不能包含组件化或确认后新增的写操作；
- 已有语义容器不会重复包装，单子节点分组被拒绝；
- 同一结构连续整理两次，第二次返回 no-op；
- 确认前改变节点、顺序、名称、几何或布局后，旧计划被拒绝；
- 在第一个、中间和最后一个操作注入失败时均能回滚；
- 应用中取消能够回滚；
- 重复点击不会创建隐藏队列；
- 插件断开或服务重启后不存在可继续应用的旧授权；
- 崩溃遗留备份能够被检测并进入恢复流程。

发布验证必须在一次性测试页面上使用 50-100 个节点完成：

1. Codex 规划、确认、应用和验证；
2. Claude Code 规划、确认、应用和验证；
3. 第二次整理 no-op；
4. 中途取消并回滚；
5. 注入失败并回滚；
6. 记录快照、规划、应用、验证和回滚耗时；
7. 确认 PSD SharedPluginData 和原始业务节点在正常成功及普通回滚后保持完整。

## 17. 已知限制

- AI 规划耗时仍受所选 Provider 的 CLI 启动和模型响应影响，设计只能提供上限、取消和可观察性。
- 不自动切换 Provider 意味着失败后需要用户主动重试，但可以避免同一任务被不同模型静默改写。
- 在插件硬崩溃且内存逆操作日志丢失时，临时副本只能提供恢复材料；完全保留所有原节点 ID 的自动恢复不在本次保证内。
- 组件化不属于本次整理确认，未来必须使用独立计划和独立确认。
