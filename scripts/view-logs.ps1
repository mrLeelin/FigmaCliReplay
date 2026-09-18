#!/usr/bin/env pwsh
# Figma Relay - 错误日志查看器
# 用于查看和分析日志文件中的错误信息

param(
    [int]$Last = 50,              # 显示最近 N 条日志
    [int]$Minutes = 10,           # 显示最近 N 分钟的日志
    [string]$Level = "all",       # 日志级别: all, error, warn, info
    [string]$Category = "",       # 过滤类别: cleanup, ai-provider, ui 等
    [switch]$Follow,              # 实时跟踪日志（类似 tail -f）
    [switch]$ErrorOnly,           # 只显示错误
    [switch]$Export,              # 导出到文件
    [string]$ExportPath = "error-report.txt"
)

$ErrorActionPreference = "Stop"

# 颜色配置
$Colors = @{
    Error = "Red"
    Warn = "Yellow"
    Info = "Cyan"
    Debug = "Gray"
    Success = "Green"
    Header = "Magenta"
}

# 日志级别映射
$LevelMap = @{
    10 = "TRACE"
    20 = "DEBUG"
    30 = "INFO"
    40 = "WARN"
    50 = "ERROR"
    60 = "FATAL"
}

function Get-LogFilePath {
    $today = Get-Date -Format "yyyy-MM-dd"
    $logFile = ".logs/app-$today.log"

    if (-not (Test-Path $logFile)) {
        Write-Host "❌ 日志文件不存在: $logFile" -ForegroundColor Red
        Write-Host "   请确保服务已启动" -ForegroundColor Yellow
        exit 1
    }

    return $logFile
}

function Format-LogEntry {
    param($entry)

    $time = [DateTimeOffset]::FromUnixTimeMilliseconds($entry.time).LocalDateTime.ToString('HH:mm:ss.fff')
    $levelNum = [int]$entry.level
    $levelName = $LevelMap[$levelNum]
    $msg = $entry.msg

    # 确定颜色
    $color = switch ($levelNum) {
        { $_ -ge 50 } { $Colors.Error }
        { $_ -ge 40 } { $Colors.Warn }
        { $_ -ge 30 } { $Colors.Info }
        default { $Colors.Debug }
    }

    # 显示基本信息
    Write-Host "[$time] " -NoNewline
    Write-Host "[$levelName] " -NoNewline -ForegroundColor $color
    Write-Host $msg -ForegroundColor $color

    # 显示详细字段
    $excludeFields = @('time', 'level', 'msg', 'pid', 'hostname')
    $details = $entry.PSObject.Properties | Where-Object { $_.Name -notin $excludeFields }

    foreach ($detail in $details) {
        $value = if ($detail.Value -is [array]) {
            $detail.Value | ForEach-Object { "    - $_" }
            $detail.Value -join "`n"
        } elseif ($detail.Value -is [hashtable] -or $detail.Value -is [PSCustomObject]) {
            ($detail.Value | ConvertTo-Json -Depth 2 -Compress)
        } else {
            $detail.Value
        }

        Write-Host "  $($detail.Name): " -NoNewline -ForegroundColor Gray
        Write-Host $value -ForegroundColor White
    }

    Write-Host ""
}

function Get-FilteredLogs {
    param(
        [string]$logFile,
        [int]$last,
        [int]$minutes,
        [string]$level,
        [string]$category,
        [bool]$errorOnly
    )

    # 读取并解析日志
    $logs = Get-Content $logFile | ForEach-Object {
        try {
            $_ | ConvertFrom-Json
        } catch {
            # 忽略无法解析的行
        }
    } | Where-Object { $_ -ne $null }

    # 时间过滤
    if ($minutes -gt 0) {
        $cutoffTime = ([DateTimeOffset]::Now.AddMinutes(-$minutes)).ToUnixTimeMilliseconds()
        $logs = $logs | Where-Object { $_.time -gt $cutoffTime }
    }

    # 级别过滤
    if ($errorOnly) {
        $logs = $logs | Where-Object { $_.level -ge 50 }
    } elseif ($level -ne "all") {
        $levelNum = switch ($level.ToLower()) {
            "trace" { 10 }
            "debug" { 20 }
            "info" { 30 }
            "warn" { 40 }
            "error" { 50 }
            "fatal" { 60 }
            default { 30 }
        }
        $logs = $logs | Where-Object { $_.level -ge $levelNum }
    }

    # 类别过滤
    if ($category) {
        $logs = $logs | Where-Object {
            $_.msg -like "*$category*" -or
            $_.module -like "*$category*" -or
            $_.category -like "*$category*"
        }
    }

    # 限制数量
    if ($last -gt 0) {
        $logs = $logs | Select-Object -Last $last
    }

    return $logs
}

function Show-LogSummary {
    param([array]$logs)

    Write-Host "`n" -NoNewline
    Write-Host "=" -NoNewline -ForegroundColor $Colors.Header
    Write-Host ("=" * 78) -ForegroundColor $Colors.Header
    Write-Host "📊 日志统计" -ForegroundColor $Colors.Header
    Write-Host ("=" * 80) -ForegroundColor $Colors.Header

    $total = $logs.Count
    $errors = ($logs | Where-Object { $_.level -ge 50 }).Count
    $warnings = ($logs | Where-Object { $_.level -eq 40 }).Count
    $infos = ($logs | Where-Object { $_.level -eq 30 }).Count

    Write-Host "总计: $total 条" -ForegroundColor White
    Write-Host "错误: $errors 条" -ForegroundColor $(if($errors -gt 0){$Colors.Error}else{$Colors.Success})
    Write-Host "警告: $warnings 条" -ForegroundColor $(if($warnings -gt 0){$Colors.Warn}else{$Colors.Success})
    Write-Host "信息: $infos 条" -ForegroundColor $Colors.Info

    if ($logs.Count -gt 0) {
        $firstTime = [DateTimeOffset]::FromUnixTimeMilliseconds($logs[0].time).LocalDateTime.ToString('HH:mm:ss')
        $lastTime = [DateTimeOffset]::FromUnixTimeMilliseconds($logs[-1].time).LocalDateTime.ToString('HH:mm:ss')
        Write-Host "时间范围: $firstTime - $lastTime" -ForegroundColor Gray
    }

    Write-Host ("=" * 80) -ForegroundColor $Colors.Header
    Write-Host ""
}

function Export-LogReport {
    param(
        [array]$logs,
        [string]$path
    )

    $report = @"
# Figma Relay 错误日志报告
生成时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')

## 统计信息
- 总日志数: $($logs.Count)
- 错误数: $(($logs | Where-Object { $_.level -ge 50 }).Count)
- 警告数: $(($logs | Where-Object { $_.level -eq 40 }).Count)

## 详细日志

"@

    foreach ($log in $logs) {
        $time = [DateTimeOffset]::FromUnixTimeMilliseconds($log.time).LocalDateTime.ToString('HH:mm:ss.fff')
        $levelName = $LevelMap[[int]$log.level]

        $report += "[$time] [$levelName] $($log.msg)`n"

        $excludeFields = @('time', 'level', 'msg', 'pid', 'hostname')
        $details = $log.PSObject.Properties | Where-Object { $_.Name -notin $excludeFields }

        foreach ($detail in $details) {
            $value = if ($detail.Value -is [array]) {
                ($detail.Value | ForEach-Object { "  - $_" }) -join "`n"
            } else {
                $detail.Value
            }
            $report += "  $($detail.Name): $value`n"
        }

        $report += "`n"
    }

    $report | Out-File -FilePath $path -Encoding UTF8
    Write-Host "✅ 日志已导出到: $path" -ForegroundColor $Colors.Success
}

# 主程序
try {
    $logFile = Get-LogFilePath

    Write-Host "`n📁 日志文件: $logFile" -ForegroundColor $Colors.Info

    if ($Follow) {
        Write-Host "🔄 实时跟踪模式 (按 Ctrl+C 退出)..." -ForegroundColor $Colors.Info
        Write-Host ""

        Get-Content $logFile -Wait -Tail $Last | ForEach-Object {
            try {
                $entry = $_ | ConvertFrom-Json
                Format-LogEntry $entry
            } catch {
                # 忽略无法解析的行
            }
        }
    } else {
        $logs = Get-FilteredLogs -logFile $logFile -last $Last -minutes $Minutes -level $Level -category $Category -errorOnly $ErrorOnly

        Show-LogSummary $logs

        if ($logs.Count -eq 0) {
            Write-Host "ℹ️  没有找到匹配的日志" -ForegroundColor $Colors.Warn
            exit 0
        }

        Write-Host "📋 日志详情：" -ForegroundColor $Colors.Header
        Write-Host ""

        foreach ($log in $logs) {
            Format-LogEntry $log
        }

        if ($Export) {
            Export-LogReport -logs $logs -path $ExportPath
        }
    }

} catch {
    Write-Host "`n❌ 错误: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
