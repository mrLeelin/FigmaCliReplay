#!/bin/bash
# 回滚 WebSocket command.response 时机修复

echo "正在回滚 WebSocket 修复..."
git checkout ui.html
echo "回滚完成！"
echo ""
echo "如果需要重新应用修复，运行："
echo "  git apply .rollback-websocket-fix.patch"
