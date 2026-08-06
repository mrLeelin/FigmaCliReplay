// 测试日志系统
import { logInfo, logDebug, logWarn, logError } from './src/utils/logger.js';

console.log('开始测试日志系统...\n');

// 测试各种日志级别
logInfo('test', 'testLogging', { message: '这是一条 INFO 日志' });
logDebug('test', 'testLogging', { message: '这是一条 DEBUG 日志' });
logWarn('test', 'testLogging', { message: '这是一条 WARN 日志' });
logError('test', 'testLogging', { message: '这是一条 ERROR 日志' }, new Error('测试错误'));

console.log('\n✅ 日志测试完成！');
console.log('📁 请检查 .logs/ 目录下的日志文件');

// 等待日志写入完成
setTimeout(() => {
  process.exit(0);
}, 1000);
