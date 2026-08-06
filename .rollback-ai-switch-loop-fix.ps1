# 回滚 AI 切换无限循环修复

Write-Host "开始回滚 AI 切换无限循环修复..." -ForegroundColor Cyan

# 备份当前版本
Copy-Item -Path "ui.html" -Destination "ui.html.loop-fix-backup" -Force

# 读取文件内容
$content = Get-Content -Path "ui.html" -Raw

# 回滚修改（恢复递归调用）
$oldPattern = '      if \(generation !== aiProviderSyncGeneration\) \{\s+return false;'
$newPattern = @"
      if (generation !== aiProviderSyncGeneration) {
        syncAiRunnerToCleanupProvider();
        return false;
"@

$content = $content -replace $oldPattern, $newPattern

# 写回文件
Set-Content -Path "ui.html" -Value $content -NoNewline

Write-Host "✅ 回滚完成！" -ForegroundColor Green
Write-Host "   - 已恢复递归调用（注意：这会导致无限循环bug）"
Write-Host "   - 修复后的版本已备份到 ui.html.loop-fix-backup"
