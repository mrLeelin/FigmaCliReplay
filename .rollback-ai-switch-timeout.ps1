# 回滚 AI 切换超时修复
# 将超时从 30 秒恢复到 6 秒

Write-Host "开始回滚 AI 切换超时修复..." -ForegroundColor Cyan

# 备份当前版本
Copy-Item -Path "ui.html" -Destination "ui.html.30s-backup" -Force

# 读取文件内容
$content = Get-Content -Path "ui.html" -Raw

# 回滚修改（30000 -> 6000）
$content = $content -replace '(fetchWithTimeout\(normalizeRelayUrl\(relayUrl\) \+ "/ai-runner/config", \{ method: "POST", headers: \{ "Content-Type": "application/json" \}, body: JSON\.stringify\(payload\) \}, )30000', '$16000'

# 写回文件
Set-Content -Path "ui.html" -Value $content -NoNewline

Write-Host "✅ 回滚完成！" -ForegroundColor Green
Write-Host "   - 超时时间已恢复为 6 秒"
Write-Host "   - 当前版本已备份到 ui.html.30s-backup"
