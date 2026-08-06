// 诊断脚本 - 在 Figma 插件控制台运行
console.log('=== Figma MCP Relay 面板诊断 ===');

// 1. 检查对话框状态
const dialog = document.getElementById('cleanupRunDialog');
console.log('1. 对话框状态:', {
  exists: !!dialog,
  hidden: dialog ? dialog.hidden : 'N/A',
  display: dialog ? window.getComputedStyle(dialog).display : 'N/A',
  zIndex: dialog ? window.getComputedStyle(dialog).zIndex : 'N/A'
});

// 2. 检查是否有覆盖层
const allElements = document.querySelectorAll('*');
const highZIndex = Array.from(allElements)
  .map(el => ({
    tag: el.tagName,
    id: el.id,
    class: el.className,
    zIndex: window.getComputedStyle(el).zIndex,
    position: window.getComputedStyle(el).position,
    display: window.getComputedStyle(el).display
  }))
  .filter(el => parseInt(el.zIndex) > 1000 && el.display !== 'none')
  .sort((a, b) => parseInt(b.zIndex) - parseInt(a.zIndex));

console.log('2. 高 z-index 元素:', highZIndex);

// 3. 检查 pointer-events
const body = document.body;
console.log('3. Body pointer-events:', window.getComputedStyle(body).pointerEvents);

// 4. 测试点击事件
const testBtn = document.querySelector('button');
console.log('4. 第一个按钮:', {
  exists: !!testBtn,
  text: testBtn ? testBtn.textContent : 'N/A',
  disabled: testBtn ? testBtn.disabled : 'N/A',
  pointerEvents: testBtn ? window.getComputedStyle(testBtn).pointerEvents : 'N/A'
});

// 5. 检查 JavaScript 错误
console.log('5. 如果上面都正常，尝试手动触发点击：');
console.log('   在控制台运行: document.querySelector("button").click()');

console.log('=== 诊断完成，请截图发给开发者 ===');
