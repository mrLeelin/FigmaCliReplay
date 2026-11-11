import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../code/05_utils.js", import.meta.url), "utf8");
function functionSource(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(match, `missing runtime function ${name}`);
  const remainder = source.slice(match.index + match[0].length);
  const next = /\n(?:async )?function [A-Za-z]|\n\/\*\*/.exec(remainder);
  return source.slice(match.index, next ? match.index + match[0].length + next.index : undefined);
}

async function collect(fills, syncColor = true) {
  const messages = [];
  const notifications = [];
  const context = vm.createContext({
    figma: {
      currentPage: { name: "Page 1", selection: [{ id: "1:2", name: "Title", type: "TEXT", fills }] },
      ui: { postMessage: message => messages.push(JSON.parse(JSON.stringify(message))) },
      notify: message => notifications.push(message)
    },
    readFigmaFontSize: () => 42,
    readFigmaStrokeWeight: () => 3,
    readFigmaTextStrokeAlign: () => "OUTSIDE",
    serializeEffects: () => [],
    buildSelectedTextMaterialSpec: () => ({ enabled: true, hasOutline: true }),
    roundNumber: value => value,
    roundDigits: (value, digits) => Number(value.toFixed(digits))
  });
  vm.runInContext(["handleExportSelectedTextStyleToUnity", "readFirstVisibleSolidPaintColor"].map(functionSource).join("\n"), context);
  await context.handleExportSelectedTextStyleToUnity({ requestId: "color-regression", job: { syncColor } });
  return { message: messages[0], notifications };
}

for (const [name, fills] of [
  ["gradient", [{ type: "GRADIENT_LINEAR", visible: true }]],
  ["mixed", Symbol("mixed")],
  ["empty", []],
  ["hidden solid", [{ type: "SOLID", visible: false, color: { r: 1, g: 0, b: 0 } }]]
]) {
  test(`${name} fill preserves Unity color and continues syncing size and material`, async () => {
    const { message, notifications } = await collect(fills);
    assert.equal(message.ok, true, message.error);
    assert.equal(message.requestId, "color-regression");
    assert.equal(message.result.syncColor, false);
    assert.equal(message.result.style.fontSize, 42);
    assert.equal(message.result.style.textMaterial.hasOutline, true);
    assert.match(message.result.warnings.join("\n"), /已跳过颜色同步.*保留 Unity 原颜色/);
    assert.deepEqual(notifications, []);
  });
}

test("solid fill keeps color synchronization including alpha", async () => {
  const { message } = await collect([{ type: "SOLID", color: { r: 0.2, g: 0.4, b: 0.6 }, opacity: 0.5 }]);
  assert.equal(message.ok, true);
  assert.equal(message.result.syncColor, true);
  assert.deepEqual(message.result.style.fillColor, { r: 0.2, g: 0.4, b: 0.6, a: 0.5 });
  assert.deepEqual(message.result.warnings, []);
});

test("disabling color synchronization accepts a gradient without a warning", async () => {
  const { message } = await collect([{ type: "GRADIENT_LINEAR" }], false);
  assert.equal(message.ok, true);
  assert.equal(message.result.syncColor, false);
  assert.deepEqual(message.result.warnings, []);
});

const ui = fs.readFileSync(new URL("../ui.html", import.meta.url), "utf8");
const uiHandler = ui.match(/async function handleTextStyleExportResult\([^]*?\n    \}/)[0];

for (const [name, fills, syncColor, expectedColor] of [
  ["unsupported fill", [{ type: "GRADIENT_LINEAR" }], true, false],
  ["solid fill", [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }], true, true],
  ["unchecked color option", [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }], false, false]
]) {
  test(`UI forwards safe color option and warnings for ${name}`, async () => {
    const { message } = await collect(fills, syncColor);
    const calls = [];
    const rendered = [];
    let finished = 0;
    const context = vm.createContext({
      syncingTextStyle: true,
      pendingTextStyleSyncOptions: { syncColor, syncFontSize: false },
      setTextStyleStatus() {},
      appendLog() {},
      finishTextStyleSync() { finished++; },
      async requestUnityCommand(action, payload) {
        calls.push({ action, payload: JSON.parse(JSON.stringify(payload)) });
        return { ok: true, syncColor: payload.syncColor, warnings: ["Unity warning"] };
      },
      renderTextStyleSyncResult(style, data) { rendered.push(JSON.parse(JSON.stringify(data))); }
    });
    vm.runInContext(uiHandler, context);
    await context.handleTextStyleExportResult(message);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, "unity.sync-selected-text-style");
    assert.equal(calls[0].payload.syncColor, expectedColor, "must not apply fallback black to Unity");
    assert.equal(calls[0].payload.syncFontSize, false);
    assert.deepEqual(rendered[0].warnings, [...message.result.warnings, "Unity warning"]);
    assert.equal(finished, 1);
  });
}
