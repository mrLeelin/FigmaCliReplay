import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const ui = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");

function extractNamedFunction(source, name) {
  const functionStart = source.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `${name} should exist`);
  const start = source.slice(Math.max(0, functionStart - 6), functionStart) === "async " ? functionStart - 6 : functionStart;
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`${name} should have a complete body`);
}

function aiPromptTemplates() {
  const start = ui.indexOf("const AiPromptTemplates = {");
  const end = ui.indexOf("// END_AI_PROMPT_TEMPLATES", start);
  return Function(`${ui.slice(start, ui.lastIndexOf(";", end) + 1)}; return AiPromptTemplates;`)();
}

function controls(overrides = {}) {
  return {
    imageDecomposeModelSelect: { value: "seedream55" },
    imageDecomposeSizeSelect: { value: "auto" },
    imageDecomposeMaxImagesInput: { value: "30" },
    imageDecomposeFormatSelect: { value: "png" },
    ...overrides,
  };
}

function buildArgs(overrides) {
  const names = Object.keys(controls());
  const values = controls(overrides);
  return Function(...names, `${extractNamedFunction(ui, "buildImageDecomposeArgs")}; return buildImageDecomposeArgs();`)(
    ...names.map((name) => values[name]),
  );
}

function buildAiPromptForTest() {
  const templates = aiPromptTemplates();
  const readAiPromptTemplate = Function(
    "AiPromptTemplates",
    `${extractNamedFunction(ui, "readAiPromptTemplate")}; return readAiPromptTemplate;`,
  )(templates);
  const renderAiPromptTemplate = Function(
    "readAiPromptTemplate",
    `${extractNamedFunction(ui, "renderAiPromptTemplate")}; return renderAiPromptTemplate;`,
  )(readAiPromptTemplate);
  const deps = {
    renderAiPromptTemplate,
    readAiPromptTemplate,
    getAiPromptFigmaKey: (info) => info.fileKey,
    selectedAiPromptPsdFile: null,
    selectedUnityFolder: "",
    selectedUnityProject: null,
    relayRuntimePaths: {},
    selectedUnityPrefabPath: "",
    buildUnitySelectedPrefabBlock: () => "",
    formatFileSize: () => "0 B",
    aiPromptSubAgentCheck: { checked: true },
    appendLog: () => {},
  };
  return Function(...Object.keys(deps), `${extractNamedFunction(ui, "buildAiPrompt")}; return buildAiPrompt;`)(
    ...Object.values(deps),
  );
}

const selection = {
  docName: "Doc", fileKey: "KEY123", pageName: "Page",
  nodes: [{ id: "12:34", name: "活动页背景", type: "RECTANGLE", width: 1081, height: 1529, path: "Page/活动页背景", parentType: "FRAME" }],
};

function buildPrompt(state) {
  const deps = {
    lastSelectionData: selection,
    imageDecomposeHintInput: { value: "" },
    buildImageDecomposeArgs: () => "--model seedream55 --size auto",
    relayRuntimePaths: { pluginRoot: "C:/Portable Relay" },
    relaySessionId: "figma-relay-session-1",
    buildAiPrompt: buildAiPromptForTest(),
    ...state,
  };
  return Function(
    ...Object.keys(deps),
    `${extractNamedFunction(ui, "buildImageDecomposePrompt")}; return buildImageDecomposePrompt();`,
  )(...Object.values(deps));
}

test("tools page has a 拆图 tab that copies a prompt instead of starting an AI run", () => {
  assert.match(ui, /data-tools-tab="image-decompose-tab"[^>]*>拆图<\/button>/);
  assert.match(ui, /<div class="sync-sub-page" id="image-decompose-tab">/);
  for (const id of [
    "imageDecomposeSourceBox", "imageDecomposeModelSelect", "imageDecomposeSizeSelect",
    "imageDecomposeMaxImagesInput", "imageDecomposeFormatSelect", "imageDecomposeHintInput",
    "copyImageDecomposePromptBtn", "image-decompose-status",
  ]) {
    assert.match(ui, new RegExp(`id="${id}"`), id);
  }
  assert.match(ui, /id="copyImageDecomposePromptBtn"[^>]*>复制提示词<\/button>/);
  assert.match(ui, /<option value="seedream55" selected>Seedream 5\.5<\/option>/);
  assert.match(ui, /id="imageDecomposeHintInput"[^>]*maxlength="2000"/);
  for (const removed of ["startImageDecomposeBtn", "imageDecomposeTextRecognitionCheck", "imageDecomposeNativeTextCheck",
    "imageDecomposeComposeCheck", "imageDecomposeHierarchyCheck"]) {
    assert.doesNotMatch(ui, new RegExp(removed), `${removed} is no longer offered`);
  }
  assert.doesNotMatch(ui, /startAiRun\("imageDecompose"/);
  assert.match(ui, /copyImageDecomposePromptBtn\.addEventListener\("click", copyImageDecomposePrompt\)/);
});

test("decompose args come only from fixed options and omit server defaults", () => {
  assert.equal(buildArgs(), "--model seedream55 --size auto");
  assert.equal(
    buildArgs({
      imageDecomposeSizeSelect: { value: "2K" },
      imageDecomposeMaxImagesInput: { value: "12" },
      imageDecomposeFormatSelect: { value: "jpeg" },
    }),
    "--model seedream55 --size 2K --max-images 12 --output-format jpeg",
  );
  assert.equal(
    buildArgs({
      imageDecomposeModelSelect: { value: "seedream50pro" },
      imageDecomposeSizeSelect: { value: "1.5K" },
      imageDecomposeMaxImagesInput: { value: "12" },
    }),
    "--model seedream50pro --size 1.5K",
  );
});

test("invalid decompose options are rejected before a prompt is produced", () => {
  const cases = [
    { imageDecomposeModelSelect: { value: "seedream60" } },
    { imageDecomposeModelSelect: { value: "seedream50pro" }, imageDecomposeSizeSelect: { value: "auto" } },
    { imageDecomposeMaxImagesInput: { value: "1" } },
    { imageDecomposeMaxImagesInput: { value: "65" } },
    { imageDecomposeMaxImagesInput: { value: "2.5" } },
    { imageDecomposeFormatSelect: { value: "webp; rm -rf" } },
  ];
  for (const overrides of cases) {
    assert.throws(() => buildArgs(overrides), Error, JSON.stringify(overrides));
  }
});

test("copied prompt renders every placeholder from cached state, with node id and session routing", () => {
  const prompt = buildPrompt({ imageDecomposeHintInput: { value: "  人物和按钮分开 {{decomposeArgs}}  " } });

  assert.doesNotMatch(prompt.replace("{{decomposeArgs}}", ""), /\{\{\w+\}\}/);
  assert.match(prompt, /nodeId：12:34/);
  assert.match(prompt, /Relay 插件根目录：C:\/Portable Relay/);
  assert.match(prompt, /本次插件会话：`figma-relay-session-1`/);
  assert.match(prompt, /DXX 参数：`--model seedream55 --size auto`/);
  assert.match(prompt, /```text\n人物和按钮分开 \{\{decomposeArgs\}\}\n```/, "user text is fenced and inserted verbatim");
  assert.doesNotMatch(prompt, /SubAgent：已启用/);
  assert.match(buildPrompt({}), /```text\n未填写；按 image-layer-to-figma 的默认资源粒度规划。\n```/);
});

test("prompt building is synchronous and refuses incomplete state", () => {
  const two = { ...selection, nodes: [selection.nodes[0], selection.nodes[0]] };
  assert.throws(() => buildPrompt({ lastSelectionData: two }), /只选择 1 个图片节点/);
  assert.throws(() => buildPrompt({ imageDecomposeHintInput: { value: "x".repeat(2001) } }), /最多 2000 字/);
  assert.throws(() => buildPrompt({ relayRuntimePaths: {} }), (error) => error.relayPluginRootMissing === true);

  const copy = extractNamedFunction(ui, "copyImageDecomposePrompt");
  const beforeCopy = copy.slice(0, copy.indexOf("var copied = await copyTextWithFallback("));
  assert.ok(beforeCopy.length > 0);
  assert.doesNotMatch(beforeCopy, /await /, "nothing is awaited before the clipboard write, so the click gesture is kept");
  assert.match(copy, /error\.relayPluginRootMissing[\s\S]*refreshRelayRuntimePaths\(\)[\s\S]*请再点一次/);
  assert.match(copy, /已复制提示词（" \+ prompt\.length \+ " 字）/);
});

test("clipboard helper falls back to execCommand when the Clipboard API is rejected", async () => {
  const helper = extractNamedFunction(ui, "copyTextWithFallback");
  let execCalls = 0;
  const appended = [];
  const textarea = { value: "", style: {}, setAttribute() {}, focus() {}, select() {}, setSelectionRange() {}, parentNode: null };
  const documentStub = {
    createElement: () => textarea,
    body: { appendChild(node) { appended.push(node); node.parentNode = { removeChild() { appended.pop(); } }; } },
    queryCommandSupported: () => true,
    execCommand: () => { execCalls += 1; return true; },
  };
  const navigatorStub = { clipboard: { writeText: async () => { throw new Error("NotAllowedError"); } } };
  const copy = Function("navigator", "document", `${helper}; return copyTextWithFallback;`)(navigatorStub, documentStub);

  assert.equal(await copy("prompt text", null), true);
  assert.equal(execCalls, 1);
  assert.equal(textarea.value, "prompt text");
  assert.equal(appended.length, 0, "temporary textarea is removed");
});

test("refresh disables 5.5-only options for 5.0 Pro and requires exactly one selected node", () => {
  const element = () => ({ disabled: false, textContent: "", classList: { toggle(name, on) { this[name] = on; } } });
  const autoOption = { disabled: false };
  const state = {
    imageDecomposeModelSelect: { value: "seedream50pro" },
    imageDecomposeSizeSelect: { value: "auto", querySelector: () => autoOption },
    imageDecomposeMaxImagesInput: element(),
    imageDecomposeFormatSelect: element(),
    imageDecomposeSourceBox: element(),
    copyImageDecomposePromptBtn: element(),
    lastSelectionData: { nodes: [] },
  };
  const refresh = Function(
    ...Object.keys(state),
    `${extractNamedFunction(ui, "refreshImageDecomposeControls")}; return refreshImageDecomposeControls;`,
  )(...Object.values(state));
  refresh();
  assert.equal(autoOption.disabled, true);
  assert.equal(state.imageDecomposeSizeSelect.value, "1K");
  assert.equal(state.imageDecomposeMaxImagesInput.disabled, true);
  assert.equal(state.imageDecomposeFormatSelect.disabled, true);
  assert.equal(state.copyImageDecomposePromptBtn.disabled, true);
  assert.equal(state.imageDecomposeSourceBox.classList.missing, true);

  state.lastSelectionData.nodes.push({ name: "背景", width: 1081, height: 1529 });
  refresh();
  assert.equal(state.copyImageDecomposePromptBtn.disabled, false);
  assert.equal(state.imageDecomposeSourceBox.textContent, "来源：背景  1081×1529");
  assert.match(extractNamedFunction(ui, "refreshAiPromptControls"), /refreshImageDecomposeControls\(\)/);
});
