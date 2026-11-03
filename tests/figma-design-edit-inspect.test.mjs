import assert from "node:assert/strict";
import test from "node:test";

import {
  DESIGN_EDIT_MAX_INSPECT_NODES,
  DESIGN_EDIT_MAX_TEXT_LENGTH,
  designEditDescribeNode,
  designEditInspectNodes,
  designEditRgbToHex,
} from "../code/10_design_edit.mjs";

const MIXED = Symbol("mixed");

function frame(id, extra = {}) {
  const node = {
    id, name: id, type: "FRAME", parent: null, children: [],
    x: 10.4, y: 20.6, width: 100, height: 50, visible: true, opacity: 1,
    fills: [{ type: "SOLID", color: { r: 1, g: 0.4, b: 0 }, opacity: 1, visible: true }],
    strokes: [], strokeWeight: 1, cornerRadius: 8,
    layoutMode: "NONE",
    ...extra,
  };
  for (const child of node.children) child.parent = node;
  return node;
}

function lookup(...roots) {
  const map = new Map();
  const add = (node) => {
    map.set(node.id, node);
    for (const child of node.children || []) add(child);
  };
  roots.forEach(add);
  return async (id) => map.get(id) || null;
}

test("rgb channels convert to #RRGGBB", () => {
  assert.equal(designEditRgbToHex({ r: 1, g: 0.4, b: 0 }), "#FF6600");
  assert.equal(designEditRgbToHex({ r: 0, g: 0, b: 0 }), "#000000");
  assert.equal(designEditRgbToHex({ r: 2, g: -1, b: 0.5 }), "#FF0080");
});

test("a frame reports fills, radius, and rounded geometry", () => {
  const info = designEditDescribeNode(frame("1:2"), { mixed: MIXED });
  assert.equal(info.x, 10.4);
  assert.deepEqual(info.fills, [{ type: "SOLID", color: "#FF6600", opacity: 1, visible: true }]);
  assert.equal(info.cornerRadius, 8);
  assert.deepEqual(info.autoLayout, { layoutMode: "NONE" });
});

test("non-solid paints report only their type", () => {
  const info = designEditDescribeNode(frame("1:2", { fills: [{ type: "IMAGE", imageHash: "abc", visible: true }] }), { mixed: MIXED });
  assert.deepEqual(info.fills, [{ type: "IMAGE", visible: true }]);
});

test("mixed values are reported as mixed", () => {
  const info = designEditDescribeNode(frame("1:2", { fills: MIXED, cornerRadius: MIXED }), { mixed: MIXED });
  assert.equal(info.fills, "mixed");
  assert.equal(info.cornerRadius, "mixed");
});

test("auto layout frames report spacing, padding and alignment", () => {
  const info = designEditDescribeNode(frame("1:2", {
    layoutMode: "VERTICAL", itemSpacing: 12, paddingTop: 4, paddingRight: 8, paddingBottom: 4, paddingLeft: 8,
    primaryAxisAlignItems: "MIN", counterAxisAlignItems: "CENTER", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED",
  }), { mixed: MIXED });
  assert.deepEqual(info.autoLayout, {
    layoutMode: "VERTICAL", itemSpacing: 12, padding: { top: 4, right: 8, bottom: 4, left: 8 },
    primaryAxisAlignItems: "MIN", counterAxisAlignItems: "CENTER", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED",
  });
});

test("text nodes report font and content, truncating long text", () => {
  const long = "字".repeat(DESIGN_EDIT_MAX_TEXT_LENGTH + 5);
  const text = frame("1:3", {
    type: "TEXT", characters: long, fontSize: 18, fontName: { family: "Inter", style: "Bold" },
    textAlignHorizontal: "CENTER", lineHeight: { unit: "AUTO" },
  });
  delete text.layoutMode;
  const info = designEditDescribeNode(text, { mixed: MIXED });
  assert.equal(info.text.length, long.length);
  assert.equal(info.text.characters.length, DESIGN_EDIT_MAX_TEXT_LENGTH);
  assert.equal(info.text.truncated, true);
  assert.deepEqual(info.text.fontName, { family: "Inter", style: "Bold" });
  assert.equal(info.text.lineHeight, "AUTO");
  const hidden = designEditDescribeNode(text, { mixed: MIXED, includeText: false });
  assert.equal(hidden.text.characters, undefined);
  assert.equal(hidden.text.length, long.length);
});

test("instances report the main component and property values", () => {
  const info = designEditDescribeNode(frame("I5:6;7:8", {
    type: "INSTANCE", mainComponent: { id: "7:8" },
    componentProperties: { State: { type: "VARIANT", value: "Active" }, "Icon#1:2": { type: "BOOLEAN", value: true, boundVariables: {} } },
  }), { mixed: MIXED });
  assert.deepEqual(info.instance, {
    mainComponentId: "7:8",
    componentProperties: { State: { type: "VARIANT", value: "Active" }, "Icon#1:2": { type: "BOOLEAN", value: true } },
  });
});

test("inspect resolves the main component asynchronously when sync access throws", async () => {
  // dynamic-page 模式下同步读 mainComponent 会抛错，只能用 getMainComponentAsync。
  const instance = frame("I5:6;7:8", { type: "INSTANCE", componentProperties: {} });
  Object.defineProperty(instance, "mainComponent", { get: () => { throw new Error("use getMainComponentAsync"); } });
  const root = frame("1:2", { children: [instance] });
  const result = await designEditInspectNodes({ nodeIds: ["1:2"], depth: 1 }, lookup(root), MIXED, async () => ({ id: "7:8" }));
  assert.equal(result.status, "completed");
  assert.equal(result.nodes[0].children[0].instance.mainComponentId, "7:8");
});

test("bound variables are reported as ids", () => {
  const info = designEditDescribeNode(frame("1:2", {
    boundVariables: { itemSpacing: { type: "VARIABLE_ALIAS", id: "VariableID:1:1" }, fills: [{ type: "VARIABLE_ALIAS", id: "VariableID:2:2" }] },
  }), { mixed: MIXED });
  assert.deepEqual(info.boundVariables, { itemSpacing: "VariableID:1:1", fills: ["VariableID:2:2"] });
});

test("inspect expands children up to the requested depth and reports missing ids", async () => {
  const grandchild = frame("1:4");
  const child = frame("1:3", { children: [grandchild] });
  const root = frame("1:2", { children: [child] });
  const result = await designEditInspectNodes({ nodeIds: ["1:2", "9:9"], depth: 1 }, lookup(root), MIXED);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.missing, ["9:9"]);
  assert.equal(result.nodes[0].children.length, 1);
  assert.equal(result.nodes[0].children[0].id, "1:3");
  assert.equal(result.nodes[0].children[0].children, undefined);
  assert.equal(result.nodes[0].children[0].childCount, 1);
  assert.deepEqual(result.summary, { requested: 2, found: 1, missing: 1, described: 2, depth: 1, truncated: false });
});

test("inspect fails when no requested node exists", async () => {
  const result = await designEditInspectNodes({ nodeIds: ["9:9"] }, lookup(), MIXED);
  assert.equal(result.status, "error");
  assert.match(result.errors[0], /9:9/);
});

test("inspect stops at the node cap and marks the result truncated", async () => {
  const children = Array.from({ length: DESIGN_EDIT_MAX_INSPECT_NODES + 20 }, (_, index) => frame(`2:${index + 1}`));
  const root = frame("1:2", { children });
  const result = await designEditInspectNodes({ nodeIds: ["1:2"], depth: 1 }, lookup(root), MIXED);
  assert.equal(result.truncated, true);
  assert.equal(result.summary.described, DESIGN_EDIT_MAX_INSPECT_NODES);
  assert.equal(result.nodes[0].children.length, DESIGN_EDIT_MAX_INSPECT_NODES - 1);
});
