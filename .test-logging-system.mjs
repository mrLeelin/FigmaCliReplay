#!/usr/bin/env node
// 测试日志系统 - 模拟触发各种日志事件

import { logInfo, logDebug, logWarn, logError } from './dist/utils/logger.js';

console.log('🧪 开始测试日志系统...\n');

// 测试 1: 基本日志
console.log('📝 测试 1: 基本日志记录');
logInfo('测试消息', { testId: 1, module: 'test' });
logDebug('调试消息', { testId: 2, details: '详细信息' });
logWarn('警告消息', { testId: 3, warning: '这是一个警告' });
logError('错误消息', { testId: 4, error: '这是一个错误' });

console.log('✅ 测试 1 完成\n');

// 测试 2: 模拟清理计划验证失败
console.log('📝 测试 2: 模拟清理计划验证失败日志');
logError('cleanup no-op is valid only when the root is already organized', {
  rootNodeId: '123:456',
  rootChildrenCount: 5,
  rootChildrenNames: ['Layer 1', 'Frame 2', 'Component 3', 'Background', 'Content'],
  operationsCount: 0,
  semanticNamedCount: 0
});

console.log('✅ 测试 2 完成\n');

// 测试 3: 模拟 AI provider 检测
console.log('📝 测试 3: 模拟 AI Provider 检测日志');
logInfo('刷新 provider 可用性', { module: 'providerRegistry' });
logDebug('Provider 检测完成', {
  providerId: 'claude-code',
  command: 'claude',
  available: true,
  version: 'v1.0.0'
});
logInfo('Provider 列表刷新完成', {
  availableCount: 2,
  totalCount: 2
});

console.log('✅ 测试 3 完成\n');

console.log('🎉 所有测试完成！');
console.log('\n📁 请检查以下位置的日志：');
console.log('   - 控制台输出（上面的彩色日志）');
console.log('   - 文件: .logs/app-2026-07-18.log');

setTimeout(() => {
  process.exit(0);
}, 1000);
