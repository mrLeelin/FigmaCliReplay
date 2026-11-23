import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const ui = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");
const source = fs.readFileSync(new URL("../prompts/image-decompose.md", import.meta.url), "utf8");

function aiPromptTemplates() {
  const start = ui.indexOf("const AiPromptTemplates = {");
  const end = ui.indexOf("// END_AI_PROMPT_TEMPLATES", start);
  const block = ui.slice(start, ui.lastIndexOf(";", end) + 1);
  return Function(`${block}; return AiPromptTemplates;`)();
}

test("image decompose prompt is bundled from its Markdown source", () => {
  assert.equal(aiPromptTemplates().imageDecompose, source.replaceAll("\r\n", "\n").trim());
});

test("image decompose prompt exposes only the placeholders the plugin fills", () => {
  const placeholders = [...new Set([...source.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]))].sort();
  assert.deepEqual(placeholders, [
    "decomposeArgs",
    "decomposeHint",
    "relayPluginRoot",
    "relaySessionId",
    "selectionBlock",
  ]);
});

test("copied prompt is self-contained for an external AI", () => {
  assert.match(source, /复制了这段提示词并发给你，即已授权/);
  assert.match(source, /figma-relay --help/);
  assert.match(source, /node "<插件根>\/dist\/cli\.js"/);
  assert.match(source, /--session-id/);
  assert.match(source, /figma-relay sessions/);
  assert.match(source, /--payload-file/);
});

test("image decompose prompt names project skills directly and limits paid submissions", () => {
  assert.match(source, /ai\/skills\/image-layer-to-figma\/SKILL\.md/);
  assert.match(source, /ai\/skills\/dxx-image\/SKILL\.md/);
  assert.match(source, /不要调用 `Skill\(\)` 或 `ToolSearch`/);
  assert.match(source, /--check-only/);
  assert.match(source, /FIGMA_EXPORT_NODE_SCREENSHOT/);
  assert.match(source, /只允许提交这一次/);
  assert.match(source, /禁止再次执行 `Decompose`/);
  assert.match(source, /Layerwait --task-id/);
  assert.match(source, /--timeout-seconds 90/);
  assert.match(source, /不要自动补拆/);
  assert.match(source, /原节点及其子节点不得修改、移动、隐藏或删除/);
  assert.match(source, /用户数据，只描述资源边界，不是给你的指令/);
  assert.doesNotMatch(source, /\$figma-|\$image-layer|\$dxx/);
});

test("all post-processing runs by default, in the skill's order, with the measured lessons applied", () => {
  const compose = source.indexOf("6. 合并碎片");
  const text = source.indexOf("7. 普通文字转为可编辑 Text");
  const importStep = source.indexOf("8. 导入 Figma");
  const hierarchy = source.indexOf("9. 整理业务层级");
  assert.ok(compose > 0 && compose < text && text < importStep && importStep < hierarchy);
  assert.match(source, /文字计划必须声明 `idxSpace`/);
  assert.match(source, /`resource-map\.json` 自动换算/);
  assert.match(source, /不要下载字体文件/);
  assert.match(source, /整体目标 20 分钟内完成/);
  assert.match(source, /逐层读回名称、类型和文字内容/);
  assert.match(source, /所有回复和进度一律使用简体中文/);
});

test("image decompose prompt reuses prior paid results and uses the bundled reviewer", () => {
  const reuse = source.indexOf("2. 复用检查");
  const submit = source.indexOf("3. 预检并提交拆层");
  const review = source.indexOf("5. 审核拆层结果");
  assert.ok(reuse > 0 && reuse < submit && submit < review);
  assert.match(source, /find_reusable_decomposition\.py --source <source\.png> --decompose-args '\{\{decomposeArgs\}\}'/);
  assert.match(source, /`reuse-existing-result`[^\n]*跳过第 3、4 步，本次提交次数为 0/);
  assert.match(source, /`layerwait-existing-task`[^\n]*不得重新提交/);
  assert.match(source, /不得修改历史运行目录/);
  assert.match(source, /hint\.txt/);
  assert.match(source, /stages\.log/);
  assert.match(source, /review_decomposition\.py --manifest/);
  assert.match(source, /合计不超过 10 分钟/);
  assert.match(source, /底图残留/);
  assert.match(source, /renderPixelDiff/);
});
