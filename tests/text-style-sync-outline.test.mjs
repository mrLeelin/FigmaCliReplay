import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

// 从插件源码片段中取出「字体同步」材质构建所需函数，在独立 VM 中执行，不依赖 Figma 运行时。
const sources = ["../code/05_utils.js", "../code/04_hierarchy.js"].map(path => fs.readFileSync(new URL(path, import.meta.url), "utf8"));
function functionSource(name) {
  for (const source of sources) {
    const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
    if (!match) continue;
    const remainder = source.slice(match.index + match[0].length);
    const next = /\n(?:async )?function [A-Za-z]|\n\/\*\*/.exec(remainder);
    return source.slice(match.index, next ? match.index + match[0].length + next.index : undefined);
  }
  assert.fail(`missing runtime function ${name}`);
}

const context = vm.createContext({});
vm.runInContext(["buildSelectedTextMaterialSpec", "findFirstVisibleDropShadow", "clampNumber", "roundDigits",
  "colorToMaterialHex", "toHex2", "pad3", "readFigmaTextStrokeAlign"].map(functionSource).join("\n"), context);
const build = (...args) => JSON.parse(JSON.stringify(context.buildSelectedTextMaterialSpec(...args)));
const stroke = { r: 0.427, g: 0.082, b: 0.082, a: 1 };

test("outside text stroke matches the Python import rule and keeps the glyph face", () => {
  const material = build(stroke, 4, [], 42, "OUTSIDE");
  assert.equal(material.outlineWidth, 0.28);
  assert.equal(material.faceDilate, 0.28);
  assert.equal(material.strokeAlign, "OUTSIDE");
  assert.equal(material.signature, "o_6d1515ff_w_028_a_out_u_none_x_100_y_100_s_000_d_000");
  assert.equal(material.materialName, "CommonFont_figma_" + material.signature);
});

test("center and inside strokes share the width and move the face dilate", () => {
  const center = build(stroke, 4, [], 42, "CENTER");
  const inside = build(stroke, 4, [], 42, "INSIDE");
  assert.deepEqual([center.outlineWidth, center.faceDilate], [0.28, 0]);
  assert.deepEqual([inside.outlineWidth, inside.faceDilate], [0.28, -0.28]);
  assert.match(center.signature, /_w_028_a_ctr_/);
  assert.match(inside.signature, /_w_028_a_in_/);
});

test("lowercase alignment is normalized like the Python import rule", () => {
  const material = build(stroke, 4, [], 42, "outside");
  assert.deepEqual([material.strokeAlign, material.outlineWidth, material.faceDilate], ["OUTSIDE", 0.28, 0.28]);
});

test("requests without alignment keep the legacy formula and signature", () => {
  for (const align of [undefined, null, 42, "", "MIXED"]) {
    const material = build(stroke, 4, [], 35, align);
    assert.equal(material.outlineWidth, 0.27);
    assert.equal(material.faceDilate, 0.135);
    assert.equal(material.strokeAlign, "");
    assert.equal(material.signature, "o_6d1515ff_w_027_u_none_x_100_y_100_s_000_d_000");
  }
});

test("shadow-only and empty styles carry the new fields without an alignment token", () => {
  const shadow = [{ type: "DROP_SHADOW", visible: true, radius: 0, spread: 0, offset: { x: 0, y: 3 },
    color: { r: 0.56, g: 0.01, b: 0.01, a: 1 } }];
  const shadowOnly = build(null, 0, shadow, 50, "OUTSIDE");
  assert.equal(shadowOnly.hasOutline, false);
  assert.deepEqual([shadowOnly.strokeAlign, shadowOnly.faceDilate], ["", 0]);
  assert.doesNotMatch(shadowOnly.signature, /_a_/);
  const empty = build(null, 0, [], 50, "OUTSIDE");
  assert.equal(empty.enabled, false);
  assert.deepEqual([empty.strokeAlign, empty.faceDilate], ["", 0]);
});

test("text style sync sends the node stroke alignment to Unity", () => {
  const handler = functionSource("handleExportSelectedTextStyleToUnity");
  assert.match(handler, /const strokeAlign = readFigmaTextStrokeAlign\(node\);/);
  assert.match(handler, /buildSelectedTextMaterialSpec\(strokeColor, strokeWeight, effects, fontSize, strokeAlign\)/);
});

test("Unity text style sync applies face dilate by alignment and calibrates with the font asset", () => {
  const sync = fs.readFileSync(new URL("../unity/Assets/Editor/FigmaBridge/FigmaTextStyleSyncUtility.cs", import.meta.url), "utf8");
  assert.match(sync, /public string strokeAlign;/);
  assert.match(sync, /public float faceDilate;/);
  assert.match(sync, /SetMaterialFloat\(material, "_FaceDilate", hasOutline \? ResolveFaceDilate\(spec\) : 0f\)/);
  assert.match(sync, /HasStrokeAlign\(spec\)\s*&& !MaterialFloatApprox\(material, "_FaceDilate", ResolveFaceDilate\(spec\)\)/);
  assert.match(sync, /CalibrateOutlineForFont\(style\.textMaterial, style\.fontSize\);/);
  assert.match(sync, /sourceStrokeWeight \* pointSize \/ \(2f \* padding \* fontSize\)/);
});
