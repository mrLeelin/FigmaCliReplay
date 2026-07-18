# 日志查看脚本使用说明

## 功能
用于查看和分析 Figma MCP Relay 的日志文件，支持过滤、实时跟踪和导出。

## 使用方法

### 基本用法

```powershell
# 查看最近 50 条日志
.\scripts\view-logs.ps1

# 查看最近 100 条日志
.\scripts\view-logs.ps1 -Last 100

# 查看最近 5 分钟的日志
.\scripts\view-logs.ps1 -Minutes 5
```

### 过滤日志

```powershell
# 只显示错误
.\scripts\view-logs.ps1 -ErrorOnly

# 只显示错误和警告
.\scripts\view-logs.ps1 -Level warn

# 过滤特定类别
.\scripts\view-logs.ps1 -Category "cleanup"
.\scripts\view-logs.ps1 -Category "ai-provider"
.\scripts\view-logs.ps1 -Category "validation"
```

### 实时跟踪

```powershell
# 实时查看新日志（类似 tail -f）
.\scripts\view-logs.ps1 -Follow

# 实时查看错误日志
.\scripts\view-logs.ps1 -Follow -ErrorOnly
```

### 导出日志

```powershell
# 导出错误日志到文件
.\scripts\view-logs.ps1 -ErrorOnly -Export

# 导出到指定文件
.\scripts\view-logs.ps1 -ErrorOnly -Export -ExportPath "errors-$(Get-Date -Format 'yyyy-MM-dd').txt"
```

### 组合使用

```powershell
# 查看最近 5 分钟的清理相关错误
.\scripts\view-logs.ps1 -Minutes 5 -Category "cleanup" -ErrorOnly

# 实时跟踪 AI provider 相关日志
.\scripts\view-logs.ps1 -Follow -Category "ai-provider"

# 导出最近 30 分钟的所有错误
.\scripts\view-logs.ps1 -Minutes 30 -ErrorOnly -Export
```

## 参数说明

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `-Last` | int | 50 | 显示最近 N 条日志 |
| `-Minutes` | int | 10 | 显示最近 N 分钟的日志 |
| `-Level` | string | "all" | 日志级别：trace, debug, info, warn, error, fatal, all |
| `-Category` | string | "" | 过滤类别关键字 |
| `-ErrorOnly` | switch | false | 只显示错误日志 |
| `-Follow` | switch | false | 实时跟踪模式 |
| `-Export` | switch | false | 导出到文件 |
| `-ExportPath` | string | "error-report.txt" | 导出文件路径 |

## 输出格式

```
[HH:mm:ss.fff] [LEVEL] 消息内容
  字段1: 值1
  字段2: 值2
  ...
```

### 颜色说明
- 🔴 **红色** - ERROR/FATAL
- 🟡 **黄色** - WARN
- 🔵 **青色** - INFO
- ⚪ **灰色** - DEBUG/TRACE

## 常见用例

### 1. 诊断当前错误
```powershell
.\scripts\view-logs.ps1 -ErrorOnly -Last 20
```

### 2. 监控服务运行
```powershell
.\scripts\view-logs.ps1 -Follow
```

### 3. 分析清理计划问题
```powershell
.\scripts\view-logs.ps1 -Category "cleanup" -Minutes 15
```

### 4. 生成错误报告
```powershell
.\scripts\view-logs.ps1 -ErrorOnly -Export -ExportPath "error-report-$(Get-Date -Format 'yyyyMMdd-HHmmss').txt"
```

## 快捷命令（添加到 package.json）

```json
{
  "scripts": {
    "logs": "pwsh scripts/view-logs.ps1",
    "logs:error": "pwsh scripts/view-logs.ps1 -ErrorOnly",
    "logs:follow": "pwsh scripts/view-logs.ps1 -Follow",
    "logs:cleanup": "pwsh scripts/view-logs.ps1 -Category cleanup"
  }
}
```

然后可以使用：
```bash
npm run logs
npm run logs:error
npm run logs:follow
npm run logs:cleanup
```

## 注意事项

1. **日志文件位置**: `.logs/app-YYYY-MM-DD.log`
2. **权限要求**: 需要读取日志文件的权限
3. **实时模式**: 按 `Ctrl+C` 退出
4. **大文件**: 对于大日志文件，建议使用 `-Last` 限制数量

## 故障排查

### 脚本无法运行
```powershell
# 设置执行策略
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

### 日志文件不存在
- 确保服务已启动
- 检查 `.logs/` 目录是否存在
- 确认日志系统已初始化

### 输出乱码
- 确保终端支持 UTF-8 编码
- 使用 Windows Terminal 或 PowerShell 7+
