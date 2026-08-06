#!/usr/bin/env node
/**
 * 分析最近清理任务的耗时
 */

const tasks = [
  { name: "cleanup-1784292079277", time: "2026-07-17 20:48:04" },
  { name: "cleanup-1784293268190", time: "2026-07-17 21:10:23" },
  { name: "cleanup-1784294461734", time: "2026-07-17 21:22:19" },
  { name: "cleanup-1784295060656", time: "2026-07-17 21:32:49" }
];

console.log('=== 清理任务完成时间分析 ===\n');

tasks.forEach((task, i) => {
  console.log(`任务 ${i + 1}: ${task.name}`);
  console.log(`  完成时间: ${task.time}`);

  if (i > 0) {
    const prev = new Date(tasks[i - 1].time);
    const curr = new Date(task.time);
    const diff = (curr - prev) / 1000 / 60; // 分钟
    console.log(`  距离上次: ${diff.toFixed(1)} 分钟`);
  }
  console.log('');
});

console.log('问题：这些只是计划生成完成的时间，');
console.log('不包含 AI 规划开始的时间。');
console.log('');
console.log('需要查看：');
console.log('1. 用户点击"AI 整理"的时间');
console.log('2. 计划生成完成的时间');
console.log('3. 两者之间的差值 = AI 规划耗时');
