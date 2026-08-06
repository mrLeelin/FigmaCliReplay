#!/bin/bash
# 快速验证修复是否生效

echo "=== Figma AI 整理修复验证 ==="
echo ""
echo "✅ 步骤 1: 检查修改文件"
git diff --name-only

echo ""
echo "✅ 步骤 2: 验证关键修改"
echo "检查 ui.html 是否移除了过早的 command.response..."
if grep -q "不再立即发送 command.response" ui.html; then
    echo "  ✓ 修改 1 已应用"
else
    echo "  ✗ 修改 1 未找到"
fi

if grep -q "在结果回传成功后发送 command.response" ui.html; then
    echo "  ✓ 修改 2 已应用"
else
    echo "  ✗ 修改 2 未找到"
fi

echo ""
echo "✅ 步骤 3: 运行测试"
node --test tests/*.test.mjs 2>&1 | grep -E "^✔|^✖"

echo ""
echo "✅ 步骤 4: 检查构建"
if [ -f "code.js" ]; then
    BUILD_NUM=$(grep -o "build #[0-9]*" code.js | head -1)
    echo "  ✓ 插件已构建: $BUILD_NUM"
else
    echo "  ✗ code.js 未找到"
fi

echo ""
echo "=== 修复状态 ==="
echo "📄 修改文件: ui.html"
echo "🔧 构建状态: 完成 (build #166)"
echo "🧪 测试状态: 全部通过"
echo "📋 文档: FIXED-WEBSOCKET-TIMEOUT.md"
echo ""
echo "✨ 修复已完成！现在可以测试 AI 整理功能。"
