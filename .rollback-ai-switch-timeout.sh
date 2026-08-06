#!/bin/bash
# 回滚 AI 切换超时修复
# 将超时从 30 秒恢复到 6 秒

echo "开始回滚 AI 切换超时修复..."

# 备份当前版本
cp ui.html ui.html.30s-backup

# 回滚修改
sed -i 's/fetchWithTimeout(normalizeRelayUrl(relayUrl) + "\/ai-runner\/config", { method: "POST", headers: { "Content-Type": "application\/json" }, body: JSON.stringify(payload) }, 30000)/fetchWithTimeout(normalizeRelayUrl(relayUrl) + "\/ai-runner\/config", { method: "POST", headers: { "Content-Type": "application\/json" }, body: JSON.stringify(payload) }, 6000)/g' ui.html

echo "✅ 回滚完成！"
echo "   - 超时时间已恢复为 6 秒"
echo "   - 当前版本已备份到 ui.html.30s-backup"
