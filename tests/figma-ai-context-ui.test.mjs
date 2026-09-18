import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const ui = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");

test("Figma 定位区域提供复制给 AI 按钮并绑定处理器", () => {
  assert.match(ui, /id="copyFigmaAiContextBtn"[^>]*>复制给 AI<\/button>/);
  assert.match(ui, /const copyFigmaAiContextBtn = document\.getElementById\("copyFigmaAiContextBtn"\)/);
  assert.match(ui, /copyFigmaAiContextBtn\.addEventListener\("click", copyFigmaAiContext\)/);
  assert.match(ui, /copyFigmaAiContextBtn\.disabled = !\(lastSelectionData/);
  assert.match(ui, /copyFigmaAiContextBtn\.textContent = "已复制给 AI"/);
  assert.match(ui, /copyFigmaAiContextBtn\.classList\.add\("copy-success"\)/);
});

test("复制给 AI 的上下文包含可执行的 Figma、Relay、Skill 和 Unity 定位", () => {
  const start = ui.indexOf("function buildFigmaAiContext");
  const end = ui.indexOf("function buildFigmaShareUrl", start);
  assert.ok(start >= 0 && end > start);
  const contextBuilder = ui.slice(start, end);

  assert.match(contextBuilder, /buildFigmaShareUrlFromSelection\(info\)/);
  assert.match(contextBuilder, /node\.id/);
  assert.match(contextBuilder, /node\.urlNodeId/);
  assert.match(contextBuilder, /figmaRelay/);
  assert.match(contextBuilder, /relayRuntimePaths\.pluginRoot/);
  assert.match(contextBuilder, /figma-hierarchy-cleanup\/SKILL\.md/);
  assert.match(contextBuilder, /figma_hierarchy_cleanup_cli\.py/);
  assert.match(contextBuilder, /figma-to-prefab\/SKILL\.md/);
  assert.match(contextBuilder, /未解析绝对路径（请先连接 Relay 查询 relay.status）/);
  assert.doesNotMatch(contextBuilder, /\? "ai\/skills\//);
  assert.match(contextBuilder, /selectedUnityProject && selectedUnityProject\.path/);
  assert.match(contextBuilder, /selectedUnityFolder/);
  assert.match(contextBuilder, /sessions 和 selection/);
  assert.match(contextBuilder, /analyze -> plan -> apply -> verify/);
  assert.match(contextBuilder, /请在这段上下文之后继续描述任务:/);
});

test("选区快照保留页面 ID 和文件名，供复制上下文使用", () => {
  const start = ui.indexOf("lastSelectionData = {");
  const end = ui.indexOf("};", start);
  const snapshot = ui.slice(start, end);
  assert.match(snapshot, /fileName: result\.fileName \|\| result\.docName/);
  assert.match(snapshot, /pageId: result\.pageId/);
});

test("无输入框时剪贴板降级创建临时文本框并清理", () => {
  const start = ui.indexOf("async function copyTextWithFallback");
  const end = ui.indexOf("async function fetchWithTimeout", start);
  const copyHelper = ui.slice(start, end);
  assert.match(copyHelper, /if \(!sourceElement\)/);
  assert.match(copyHelper, /document\.createElement\("textarea"\)/);
  assert.match(copyHelper, /temporaryElement\.parentNode\) temporaryElement\.parentNode\.removeChild/);
});
