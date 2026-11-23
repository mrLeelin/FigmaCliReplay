import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const ui = read("../ui.html");
const skill = "ai/skills/figma-to-interactive-html/SKILL.md";
const template = "ai/skills/figma-to-interactive-html/assets/interactive-ui-template.html";
const block = ui.split("// BEGIN_AI_PROMPT_TEMPLATES")[1].split("// END_AI_PROMPT_TEMPLATES")[0];
const templates = Function(block + "; return AiPromptTemplates;")();

function uiFunction(name) {
  const start = ui.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert.notEqual(start, -1, name);
  const end = ui.indexOf("\n    }", start);
  assert.notEqual(end, -1, name);
  return ui.slice(start, end + "\n    }".length);
}

function buildPrompt(selection, overrides = {}) {
  const deps = {
    lastSelectionData: selection,
    relayRuntimePaths: { pluginRoot: "C:/Portable Relay" },
    relaySessionId: "relay-session-example",
    AiPromptTemplates: templates,
    ...overrides,
  };
  const names = ["getHtmlMotionSelection", "buildHtmlMotionPrompt", "renderAiPromptTemplate", "readAiPromptTemplate"];
  return Function(...Object.keys(deps), names.map(uiFunction).join("\n") + "\nreturn buildHtmlMotionPrompt();")(
    ...Object.values(deps),
  );
}

function promptContext(prompt) {
  return JSON.parse(prompt.split("```json\n")[1].split("\n```")[0]);
}

test("HTML motion tab is wired and the referenced skill and template are shipped", () => {
  assert.match(ui, /data-prompt="htmlMotion"[^>]*>HTML 动态效果<\/button>/);
  assert.match(ui, /id="copyHtmlMotionPromptBtn"[^>]*>复制提示词<\/button>/);
  assert.match(ui, /copyHtmlMotionPromptBtn\.addEventListener\("click", copyHtmlMotionPrompt\)/);
  assert.doesNotMatch(block, /<\/script[\s>]|<!--/i);
  assert.equal(templates.htmlMotion, read("../prompts/html-motion.md").trim());
  assert.ok(fs.statSync(new URL("../" + skill, import.meta.url)).isFile());
  assert.ok(fs.statSync(new URL("../" + template, import.meta.url)).isFile());
});

test("short prompt links local files and uses only a uniquely selected node", () => {
  const node = { id: "12:34", type: "FRAME", name: "反馈 {{skillPath}}", width: 640, height: 804 };
  const selection = { fileKey: "file-key", pageId: "0:1", pageName: "Page 1", nodes: [node] };
  const prompt = buildPrompt(selection);

  assert.ok(prompt.includes("C:/Portable Relay/" + skill));
  assert.ok(prompt.includes("C:/Portable Relay/" + template));
  assert.match(prompt, /本机绝对路径/);
  assert.doesNotMatch(prompt, /--job-type relay\.status/);
  assert.doesNotMatch(prompt, /<!doctype html>|^name: figma-to-interactive-html/m);
  assert.ok(prompt.length < 1400, "prompt stays compact");
  assert.deepEqual(promptContext(prompt), {
    pluginRoot: "C:/Portable Relay",
    sessionId: "relay-session-example",
    selection: { fileKey: "file-key", pageId: "0:1", pageName: "Page 1", nodeId: "12:34",
      type: "FRAME", name: node.name, width: 640, height: 804 },
  });
  assert.equal(promptContext(buildPrompt({ ...selection, nodes: [node, node] })).selection, null);
  const portable = buildPrompt(null, { relayRuntimePaths: null, relaySessionId: "" });
  assert.ok(portable.includes("技能：`" + skill));
  assert.ok(portable.includes("模板：`" + template));
  assert.match(portable, /figma-relay control --job-type relay\.status --payload-file/);
  assert.match(portable, /result\.gateway\.pluginRoot/);
  assert.deepEqual(promptContext(portable), {
    pluginRoot: null, sessionId: null, selection: null,
  });
  const windows = buildPrompt(null, { relayRuntimePaths: { pluginRoot: "C:\\Portable Relay\\" } });
  assert.ok(windows.includes("C:/Portable Relay/" + skill));
});

test("a denied clipboard shows the complete prompt in a selected text area", async () => {
  const prompt = buildPrompt(null);
  const status = {};
  const manual = {
    hidden: true,
    focus() { this.focused = true; },
    select() { this.selected = true; },
  };
  const deps = {
    buildHtmlMotionPrompt: () => prompt,
    htmlMotionManualPrompt: manual,
    htmlMotionStatus: status,
    copyTextWithFallback: async (text) => {
      assert.equal(text, prompt);
      return false;
    },
  };
  const copy = Function(...Object.keys(deps), uiFunction("copyHtmlMotionPrompt") + "\nreturn copyHtmlMotionPrompt;")(
    ...Object.values(deps),
  );
  await copy();
  assert.equal(manual.hidden, false);
  assert.equal(manual.value, prompt);
  assert.equal(manual.focused, true);
  assert.equal(manual.selected, true);
  assert.match(status.textContent, /手动复制/);
});
