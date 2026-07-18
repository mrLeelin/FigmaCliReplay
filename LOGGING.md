# 日志系统文档

## 概述

Figma MCP Relay 使用基于 Pino 的结构化日志系统，支持多级别日志记录、美化输出和性能优化。

## 日志级别

系统支持以下日志级别（从详细到严重）：

| 级别 | 用途 | 示例场景 |
|------|------|----------|
| `trace` | 最详细的调试信息 | 函数调用跟踪、变量值详细记录 |
| `debug` | 调试信息 | 中间状态、条件分支 |
| `info` | 一般信息（默认） | 操作开始/完成、状态变化 |
| `warn` | 警告信息 | 可恢复的错误、降级操作 |
| `error` | 错误信息 | 操作失败、异常捕获 |
| `fatal` | 致命错误 | 系统崩溃、无法恢复 |

## 环境变量配置

### LOG_LEVEL

设置日志输出的最低级别。

```bash
# 开发环境 - 显示所有日志
LOG_LEVEL=debug npm run dev

# 生产环境 - 只显示警告和错误
LOG_LEVEL=warn npm start

# 详细跟踪 - 显示所有细节
LOG_LEVEL=trace npm run dev
```

### NODE_ENV

控制日志输出格式。

```bash
# 开发环境 - 使用 pino-pretty 美化输出
NODE_ENV=development npm run dev

# 生产环境 - 使用 JSON 格式输出
NODE_ENV=production npm start
```

## 使用方法

### 基本用法

```typescript
import { logInfo, logWarn, logError } from "./utils/logger.js";

// 简单日志
logInfo("服务器已启动");

// 带上下文的日志
logInfo("用户登录成功", {
  userId: "123",
  timestamp: Date.now()
});

// 警告日志
logWarn("配置文件缺失，使用默认值", {
  configPath: "/path/to/config.json"
});

// 错误日志
logError("数据库连接失败", {
  error: error.message,
  retryCount: 3
});
```

### 创建子日志实例

为特定模块创建带有模块标识的日志实例：

```typescript
import { createLogger } from "./utils/logger.js";

const logger = createLogger("CleanupPlanner");

logger.info("开始执行清理计划");
// 输出: [module: CleanupPlanner] 开始执行清理计划
```

### 在关键路径中使用

#### 1. CleanupPlanner

```typescript
// src/cleanup/cleanupPlanner.ts
import { logInfo, logError } from "../utils/logger.js";

async plan(request: CleanupPlannerRequest): Promise<CleanupPlanningResult> {
  logInfo("Starting cleanup planning", {
    providerId: request.providerId,
    snapshotNodeCount: request.snapshot.nodes.length,
  });

  try {
    const plan = await this.executePlan(request);
    logInfo("Cleanup plan validated successfully", {
      operationCount: plan.operations.length,
    });
    return plan;
  } catch (error) {
    logError("Cleanup plan validation failed", {
      reason: error.message
    });
    throw error;
  }
}
```

#### 2. ProviderRegistry

```typescript
// src/ai/providerRegistry.ts
import { logInfo, logDebug, logError } from "../utils/logger.js";

async function list(): Promise<ProviderAvailability[]> {
  logInfo("Refreshing provider availability list");

  for (const provider of Providers) {
    logDebug("Provider availability checked", {
      providerId: provider.id,
      available: true,
      version: "1.0.0"
    });
  }

  logInfo("Provider availability refreshed", {
    availableCount: results.filter(r => r.available).length
  });

  return results;
}
```

#### 3. CliPlanningTransport

```typescript
// src/ai/cliPlanningTransport.ts
import { logInfo, logError, logWarn } from "../utils/logger.js";

async run(options: RunOptions): Promise<string> {
  logInfo("Starting CLI planning transport", {
    command: command,
    totalTimeoutMs: this.totalTimeoutMs
  });

  try {
    const result = await execute(command);
    logInfo("CLI planning transport completed", {
      resultLength: result.length
    });
    return result;
  } catch (error) {
    logError("CLI planning transport failed", {
      error: error.message
    });
    throw error;
  }
}
```

## 前端日志系统

### UI 日志查看器

前端 UI (`ui.html`) 包含日志查看和下载功能：

- **日志显示区域**: 实时显示操作日志
- **下载日志按钮**: 导出服务器端和客户端日志
- **清空日志按钮**: 清空当前显示的日志

### 客户端日志存储

```javascript
// ui.html
var clientLogs = []; // 存储最近 1000 条客户端日志

function appendLog(message, isError) {
  clientLogs.push({
    timestamp: new Date().toISOString(),
    level: isError ? "error" : "info",
    message: message
  });
}
```

### 日志下载

点击"下载日志"按钮将：

1. 从 `/log` 端点获取服务器日志
2. 合并客户端日志
3. 生成带时间戳的日志文件 `figma-mcp-relay-log-YYYY-MM-DD-HH-MM-SS.txt`

日志文件格式：

```
=== Figma MCP Relay 日志 ===
生成时间: 2026-07-18 14:30:00

=== 服务器日志 ===
[2026-07-18T06:30:00.000Z] [INFO] 服务器已启动
[2026-07-18T06:30:05.123Z] [ERROR] 连接失败

=== 客户端日志 ===
[2026-07-18T06:30:10.456Z] [INFO] 用户点击导出按钮
[2026-07-18T06:30:15.789Z] [ERROR] 导出失败: 网络错误
```

## HTTP 端点

### GET /log

返回服务器端日志记录。

**响应格式:**

```json
{
  "logs": [
    {
      "timestamp": "2026-07-18T06:30:00.000Z",
      "level": "info",
      "message": "服务器已启动"
    }
  ]
}
```

## 性能优化

### 开发环境

- 使用 `pino-pretty` 美化输出，提升可读性
- 彩色输出，便于快速定位
- 时间戳格式: `HH:MM:ss.l`
- 隐藏 `pid` 和 `hostname` 减少噪音

### 生产环境

- 使用 JSON 格式输出，便于日志聚合工具解析
- 高性能输出，最小化 CPU 开销
- 结构化数据，便于查询和分析

### 日志限制

- 客户端日志最多保留 1000 条
- UI 日志显示最多 12000 字符
- 超出限制自动清理旧日志

## 日志最佳实践

### 1. 使用结构化日志

✅ 推荐:
```typescript
logInfo("用户认证成功", {
  userId: user.id,
  duration: Date.now() - startTime
});
```

❌ 不推荐:
```typescript
logInfo(`用户 ${user.id} 认证成功，耗时 ${Date.now() - startTime}ms`);
```

### 2. 选择合适的日志级别

- `info`: 正常业务流程
- `warn`: 可恢复的异常情况
- `error`: 需要关注的错误
- `debug`: 仅在调试时需要的信息

### 3. 避免敏感信息

❌ 不要记录:
```typescript
logInfo("用户登录", {
  password: user.password,  // 敏感
  token: user.apiToken      // 敏感
});
```

✅ 安全记录:
```typescript
logInfo("用户登录", {
  userId: user.id,
  loginMethod: "password"
});
```

### 4. 记录操作上下文

```typescript
logInfo("开始执行清理", {
  nodeCount: nodes.length,
  providerId: provider.id,
  startTime: Date.now()
});

// ... 执行操作 ...

logInfo("清理执行完成", {
  processedCount: processed.length,
  duration: Date.now() - startTime
});
```

## 故障排查

### 问题: 日志未显示

**检查步骤:**

1. 确认 `LOG_LEVEL` 环境变量设置正确
2. 检查日志级别是否高于当前级别
3. 验证日志文件是否正确导入

```bash
# 设置为 trace 查看所有日志
LOG_LEVEL=trace npm run dev
```

### 问题: 日志格式不正确

**检查步骤:**

1. 确认 `NODE_ENV` 环境变量
2. 开发环境应该显示美化输出
3. 生产环境应该显示 JSON 格式

```bash
# 开发环境
NODE_ENV=development npm run dev

# 生产环境
NODE_ENV=production npm start
```

### 问题: 日志性能影响

**优化建议:**

1. 生产环境使用 `info` 或更高级别
2. 避免在高频循环中记录 `debug` 日志
3. 使用条件日志记录

```typescript
// 避免
for (const item of largeArray) {
  logDebug("处理项目", { item }); // 高频日志
}

// 推荐
logDebug("开始批量处理", { count: largeArray.length });
for (const item of largeArray) {
  // 处理逻辑
}
logDebug("批量处理完成");
```

## 扩展日志系统

### 添加日志持久化

目前日志仅输出到控制台。如需持久化，可以添加 Pino 传输:

```typescript
import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: {
    targets: [
      {
        target: "pino-pretty",
        level: "debug",
        options: { colorize: true }
      },
      {
        target: "pino/file",
        level: "info",
        options: { destination: "./logs/app.log" }
      }
    ]
  }
});
```

### 集成日志聚合服务

对于生产环境，可以集成日志聚合服务（如 ELK、Datadog）:

```typescript
import pino from "pino";
import pinoElasticsearch from "pino-elasticsearch";

const streamToElastic = pinoElasticsearch({
  node: "http://localhost:9200",
  index: "figma-mcp-relay"
});

export const logger = pino(streamToElastic);
```

## 相关文件

- `src/utils/logger.ts` - 日志系统核心实现
- `src/cleanup/cleanupPlanner.ts` - 清理规划器日志集成
- `src/ai/providerRegistry.ts` - Provider 注册表日志集成
- `src/ai/cliPlanningTransport.ts` - CLI 传输层日志集成
- `src/cleanupPlan.ts` - 清理计划验证日志集成
- `src/httpServer.ts` - HTTP 服务器日志端点
- `ui.html` - 前端日志查看器

## 版本历史

- **v1.0.0** (2026-07-18) - 初始日志系统实现
  - 基于 Pino 的结构化日志
  - 多级别日志支持
  - 开发/生产环境配置
  - 前端日志查看和下载功能
  - HTTP 日志端点
