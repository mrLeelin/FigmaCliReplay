import assert from "node:assert/strict";
import test from "node:test";

import { designEditApplyEdits, designEditRollback } from "../code/10_design_edit.mjs";

const MIXED = Symbol("mixed");

function page(...children) {
  const node = { id: "0:1", type: "PAGE", name: "Page", children: [], parent: null };
  for (const child of children) adopt(node, child);
  return node;
}

function adopt(parent, child) {
  child.parent = parent;
  parent.children.push(child);
  return child;
}

function frame(id, extra = {}) {
  return {
    id, name: id, type: "FRAME", parent: null, children: [],
    x: 0, y: 0, width: 100, height: 50, visible: true, opacity: 1,
    fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: 1, visible: true }],
    strokes: [], strokeWeight: 1, cornerRadius: 0,
    layoutMode: "NONE", itemSpacing: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
    primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED",
    layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED",
    resize(width, height) { this.width = width; this.height = height; },
    ...extra,
  };
}

/** 模拟 Figma 规则：TEXT 的 characters/fontSize/fontName 只有在相关字体加载后才可写。 */
function text(id, loaded, extra = {}) {
  const state = { characters: "旧文字", fontSize: 16, fontName: { family: "Inter", style: "Regular" } };
  const node = {
    id, name: id, type: "TEXT", parent: null,
    x: 0, y: 0, width: 80, height: 20, visible: true, opacity: 1,
    fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1, visible: true }],
    strokes: [], strokeWeight: 1, textAlignHorizontal: "LEFT", layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED",
    resize(width, height) { this.width = width; this.height = height; },
    ...extra,
  };
  const guard = (key, fontName) => {
    const font = fontName || state.fontName;
    if (font !== MIXED && !loaded.has(font.family + "/" + font.style)) throw new Error("unloaded font " + font.family + " " + font.style + " for " + key);
  };
  for (const key of ["characters", "fontSize"]) {
    Object.defineProperty(node, key, { enumerable: true, get: () => state[key], set: (value) => { guard(key); state[key] = value; } });
  }
  Object.defineProperty(node, "fontName", {
    enumerable: true,
    get: () => state.fontName,
    set: (value) => { guard("fontName", value); state.fontName = value; },
  });
  if (extra.fontName) state.fontName = extra.fontName;
  return node;
}

function runtime(roots, options = {}) {
  const map = new Map();
  const add = (node) => { map.set(node.id, node); for (const child of node.children || []) add(child); };
  roots.forEach(add);
  const loaded = options.loaded || new Set();
  const logs = [];
  return {
    loaded,
    logs,
    mixed: MIXED,
    getNodeById: async (id) => map.get(id) || null,
    loadFont: async (font) => {
      const key = font.family + "/" + font.style;
      if (options.unavailableFonts && options.unavailableFonts.has(key)) throw new Error("font not available");
      loaded.add(key);
    },
    log: (stage, data) => logs.push({ stage, data }),
    getMainComponent: async (node) => node.mainComponentNode || null,
    getVariableById: async (id) => (options.variables && options.variables[id]) || null,
    createFrame: () => {
      return container(createdNode(frame("new:" + (map.size + 1)), map));
    },
    createText: () => createdNode(text("new:" + (map.size + 1), loaded), map),
    bindPaint: (paint, field, variable) => ({ ...paint, boundVariables: { [field]: { type: "VARIABLE_ALIAS", id: variable.id } } }),
  };
}

/** 模拟新建节点：可插入父容器、可删除（remove 后从父级摘除并标记 removed）。 */
function createdNode(node, map) {
  map.set(node.id, node);
  node.removed = false;
  node.remove = () => {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = null;
    node.removed = true;
  };
  return node;
}

/** 给模拟容器加上 appendChild/insertChild。 */
function container(node) {
  node.appendChild = (child) => adopt(node, child);
  node.insertChild = (index, child) => {
    if (index > node.children.length) throw new Error("index out of range");
    child.parent = node;
    node.children.splice(index, 0, child);
  };
  return node;
}

/** 模拟数值属性的变量绑定：setBoundVariable 写 boundVariables[field]。 */
function bindable(node) {
  node.boundVariables = {};
  node.setBoundVariable = (field, variable) => {
    if (variable) node.boundVariables[field] = { type: "VARIABLE_ALIAS", id: variable.id };
    else delete node.boundVariables[field];
  };
  return node;
}

test("property edits apply and report before/after", async () => {
  const loaded = new Set();
  const card = frame("1:2");
  const label = text("1:3", loaded);
  const rt = runtime([page(card, label)], { loaded });
  const result = await designEditApplyEdits({
    edits: [
      { op: "setFill", nodeId: "1:2", color: "#FF6600", opacity: 0.5 },
      { op: "setStroke", nodeId: "1:2", color: "#000000", weight: 2 },
      { op: "setCornerRadius", nodeId: "1:2", radius: 12 },
      { op: "setOpacity", nodeId: "1:3", opacity: 0.8 },
      { op: "rename", nodeId: "1:2", name: "卡片" },
      { op: "setText", nodeId: "1:3", characters: "购买" },
      { op: "setTextStyle", nodeId: "1:3", fontSize: 20, align: "CENTER" },
    ],
  }, rt);
  assert.equal(result.status, "completed", JSON.stringify(result.errors));
  assert.equal(result.applied, 7);
  assert.equal(card.fills[0].opacity, 0.5);
  assert.equal(Math.round(card.fills[0].color.g * 255), 0x66);
  assert.equal(card.strokeWeight, 2);
  assert.equal(card.cornerRadius, 12);
  assert.equal(card.name, "卡片");
  assert.equal(label.characters, "购买");
  assert.equal(label.fontSize, 20);
  assert.equal(label.textAlignHorizontal, "CENTER");
  assert.deepEqual(result.edits[0].after.fills, [{ type: "SOLID", color: "#FF6600", opacity: 0.5, visible: true }]);
  assert.deepEqual(result.edits[5].before.characters, { length: 3 });
  assert.deepEqual(result.edits[5].after.characters, { length: 2 });
});

test("dry run validates and previews without writing", async () => {
  const card = frame("1:2");
  const rt = runtime([page(card)]);
  const result = await designEditApplyEdits({ dryRun: true, edits: [{ op: "setCornerRadius", nodeId: "1:2", radius: 9 }] }, rt);
  assert.equal(result.status, "completed");
  assert.equal(result.dryRun, true);
  assert.equal(result.applied, 0);
  assert.equal(card.cornerRadius, 0);
  assert.deepEqual(result.edits[0].before, { cornerRadius: 0 });
});

test("precheck blocks the whole batch without writing anything", async () => {
  const card = frame("1:2");
  const group = frame("1:4", { type: "GROUP" });
  delete group.layoutMode;
  const rt = runtime([page(card, group)]);
  const result = await designEditApplyEdits({
    edits: [
      { op: "setFill", nodeId: "1:2", color: "#000000" },
      { op: "setText", nodeId: "1:2", characters: "x" },
      { op: "setAutoLayout", nodeId: "1:4", mode: "VERTICAL" },
      { op: "setOpacity", nodeId: "9:9", opacity: 1 },
    ],
  }, rt);
  assert.equal(result.status, "blocked");
  assert.equal(result.applied, 0);
  assert.deepEqual(result.blockingErrors.map((item) => item.index), [1, 2, 3]);
  assert.match(result.errors[0], /requires a TEXT node/);
  assert.equal(Math.round(card.fills[0].color.r * 255), 255, "first edit must not be applied");
});

test("pages, cross-page targets and temp references are refused", async () => {
  const a = frame("1:2");
  const b = frame("2:2");
  const pageA = page(a);
  const pageB = page(b);
  pageB.id = "0:2";
  const rt = runtime([pageA, pageB]);
  const result = await designEditApplyEdits({
    edits: [
      { op: "rename", nodeId: "1:2", name: "A" },
      { op: "rename", nodeId: "2:2", name: "B" },
      { op: "rename", nodeId: "0:1", name: "Page" },
      { op: "setOpacity", nodeId: "temp:x", opacity: 1 },
    ],
  }, rt);
  assert.equal(result.status, "blocked");
  const messages = result.blockingErrors.map((item) => item.message).join(" | ");
  assert.match(messages, /not on the same page/);
  assert.match(messages, /refuse to edit PAGE/);
  assert.match(messages, /temp reference used before creation: temp:x/);
  assert.equal(a.name, "1:2");
});

test("changing a font loads both the original and the new font before writing", async () => {
  const loaded = new Set();
  const label = text("1:3", loaded);
  const rt = runtime([page(label)], { loaded });
  const result = await designEditApplyEdits({ edits: [{ op: "setTextStyle", nodeId: "1:3", fontFamily: "Inter", fontStyle: "Bold" }] }, rt);
  assert.equal(result.status, "completed", JSON.stringify(result.errors));
  assert.deepEqual(label.fontName, { family: "Inter", style: "Bold" });
  assert.ok(loaded.has("Inter/Regular") && loaded.has("Inter/Bold"));
});

test("mixed-font text and unavailable fonts are blocked", async () => {
  const mixedText = text("1:3", new Set(), { fontName: MIXED });
  const plain = text("1:5", new Set());
  const rt = runtime([page(mixedText, plain)], { unavailableFonts: new Set(["Nope/Bold"]) });
  const result = await designEditApplyEdits({
    edits: [
      { op: "setText", nodeId: "1:3", characters: "x" },
      { op: "setTextStyle", nodeId: "1:5", fontFamily: "Nope", fontStyle: "Bold" },
    ],
  }, rt);
  assert.equal(result.status, "blocked");
  const messages = result.blockingErrors.map((item) => item.message).join(" | ");
  assert.match(messages, /mixed fonts/);
  assert.match(messages, /font unavailable: Nope Bold/);
});

test("a failure during apply rolls back every earlier edit", async () => {
  const card = frame("1:2", { cornerRadius: 4 });
  const other = frame("1:6", { opacity: 1 });
  // 预检通过、执行时抛错：模拟 Figma 在赋值时拒绝（例如只读实例子层）。
  Object.defineProperty(other, "visible", { enumerable: true, get: () => true, set: () => { throw new Error("cannot hide this layer"); } });
  // 同一节点先改过尺寸再失败时，回滚必须用改动前的几何信息。
  card.width = 100;
  const rt = runtime([page(card, other)]);
  const result = await designEditApplyEdits({
    edits: [
      { op: "setCornerRadius", nodeId: "1:2", radius: 30 },
      { op: "setFill", nodeId: "1:2", color: "#123456" },
      { op: "setOpacity", nodeId: "1:6", opacity: 0.2 },
      { op: "setVisible", nodeId: "1:6", visible: false },
    ],
  }, rt);
  assert.equal(result.status, "error");
  assert.equal(result.failedIndex, 3);
  assert.equal(result.rollback.pass, true, JSON.stringify(result.rollback));
  assert.equal(card.cornerRadius, 4);
  assert.equal(Math.round(card.fills[0].color.r * 255), 255);
  assert.equal(other.opacity, 1);
  assert.match(result.errors[0], /cannot hide this layer; batch rolled back/);
  assert.ok(rt.logs.some((entry) => entry.stage === "rollback" && entry.data.pass === true));
});

test("auto layout edits restore mode, padding and child geometry on rollback", async () => {
  const child = frame("1:7", { x: 40, y: 30 });
  const box = frame("1:2", { width: 300, height: 200, children: [] });
  adopt(box, child);
  const blocker = frame("1:8");
  Object.defineProperty(blocker, "name", { enumerable: true, get: () => "1:8", set: () => { throw new Error("locked"); } });
  const rt = runtime([page(box, blocker)]);
  const result = await designEditApplyEdits({
    edits: [
      { op: "setAutoLayout", nodeId: "1:2", mode: "VERTICAL", itemSpacing: 8, padding: 16, primaryAlign: "CENTER", sizing: { primary: "AUTO" } },
      { op: "rename", nodeId: "1:8", name: "x" },
    ],
  }, rt);
  assert.equal(result.status, "error");
  assert.equal(result.rollback.pass, true, JSON.stringify(result.rollback));
  assert.equal(box.layoutMode, "NONE");
  assert.equal(box.paddingTop, 0);
  assert.equal(box.primaryAxisAlignItems, "MIN");
  assert.equal(box.primaryAxisSizingMode, "FIXED");
  assert.equal(child.x, 40);
  assert.equal(child.y, 30);
});

test("layout sizing requires the right auto layout context", async () => {
  const child = frame("1:7");
  const box = frame("1:2", { layoutMode: "HORIZONTAL" });
  adopt(box, child);
  const loose = frame("1:9");
  const rt = runtime([page(box, loose)]);
  const ok = await designEditApplyEdits({ edits: [{ op: "setLayoutSizing", nodeId: "1:7", horizontal: "FILL" }] }, rt);
  assert.equal(ok.status, "completed");
  assert.equal(child.layoutSizingHorizontal, "FILL");
  const bad = await designEditApplyEdits({ edits: [{ op: "setLayoutSizing", nodeId: "1:9", horizontal: "FILL" }] }, rt);
  assert.equal(bad.status, "blocked");
  assert.match(bad.errors[0], /FILL requires an auto layout parent/);
});

test("rollback restores the original geometry when an auto layout edit resized the frame", async () => {
  const child = frame("1:7", { x: 40, y: 30 });
  const box = frame("1:2", { width: 300, height: 200 });
  adopt(box, child);
  // 模拟 Figma：开启 auto layout + AUTO 尺寸时，frame 会按内容收缩，子节点被重新排布。
  let mode = "NONE";
  Object.defineProperty(box, "layoutMode", {
    enumerable: true,
    get: () => mode,
    set: (value) => {
      mode = value;
      if (value !== "NONE") { box.width = 120; box.height = 80; child.x = 0; child.y = 0; }
    },
  });
  const blocker = frame("1:8");
  Object.defineProperty(blocker, "name", { enumerable: true, get: () => "1:8", set: () => { throw new Error("locked"); } });
  const rt = runtime([page(box, blocker)]);
  const result = await designEditApplyEdits({
    edits: [
      { op: "setAutoLayout", nodeId: "1:2", mode: "VERTICAL", itemSpacing: 8 },
      { op: "setCornerRadius", nodeId: "1:2", radius: 6 },
      { op: "rename", nodeId: "1:8", name: "x" },
    ],
  }, rt);
  assert.equal(result.status, "error");
  assert.equal(result.rollback.pass, true, JSON.stringify(result.rollback));
  assert.equal(box.layoutMode, "NONE");
  assert.equal(box.width, 300);
  assert.equal(box.height, 200);
  assert.equal(box.cornerRadius, 0);
  assert.equal(child.x, 40);
  assert.equal(child.y, 30);
});

test("rollback reports values that could not be restored", async () => {
  const node = frame("1:2", { cornerRadius: 5 });
  const entries = new Map([["1:2", {
    node, values: new Map([["cornerRadius", 5]]), bindings: new Map(), geometry: { x: 0, y: 0, width: 100, height: 50 }, children: null,
  }]]);
  Object.defineProperty(node, "cornerRadius", { enumerable: true, get: () => 99, set: () => {} });
  const rollback = await designEditRollback({ entries, created: [] }, { mixed: MIXED });
  assert.equal(rollback.pass, false);
  assert.deepEqual(rollback.mismatches, [{ nodeId: "1:2", key: "cornerRadius" }]);
});

/** 返回一个调用 name setter 就抛错的节点，用来在指定位置制造执行期失败。 */
function lockedFrame(id) {
  const node = frame(id);
  Object.defineProperty(node, "name", { enumerable: true, get: () => id, set: () => { throw new Error("locked"); } });
  return node;
}

test("precheck simulates earlier edits in the same batch", async () => {
  const child = frame("1:7");
  const box = frame("1:2", { layoutMode: "HORIZONTAL" });
  adopt(box, child);
  const rt = runtime([page(box)]);
  // 先关掉父级 auto layout 再对子节点设 FILL：执行前就应被拦下，而不是执行时失败再回滚。
  const blocked = await designEditApplyEdits({
    edits: [
      { op: "setAutoLayout", nodeId: "1:2", mode: "NONE" },
      { op: "setLayoutSizing", nodeId: "1:7", horizontal: "FILL" },
    ],
  }, rt);
  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.blockingErrors.map((item) => item.index), [1]);
  assert.match(blocked.errors[0], /at this point in the batch/);
  assert.equal(box.layoutMode, "HORIZONTAL");

  // 反过来：先开 auto layout 再设 FILL，预检应放行。
  const loose = frame("1:3");
  const holder = frame("1:4");
  adopt(holder, loose);
  const ok = await designEditApplyEdits({
    dryRun: true,
    edits: [
      { op: "setAutoLayout", nodeId: "1:4", mode: "VERTICAL" },
      { op: "setLayoutSizing", nodeId: "1:3", horizontal: "FILL" },
    ],
  }, runtime([page(holder)]));
  assert.equal(ok.status, "completed", JSON.stringify(ok.errors));
});

test("create ops build a subtree, resolve temp ids and report created ids", async () => {
  const loaded = new Set();
  const root = container(frame("1:2"));
  const rt = runtime([page(root)], { loaded });
  const result = await designEditApplyEdits({
    edits: [
      { op: "createFrame", parentId: "1:2", tempId: "card", name: "卡片", width: 200, height: 80, x: 10, y: 20 },
      { op: "setAutoLayout", nodeId: "temp:card", mode: "HORIZONTAL", itemSpacing: 6 },
      { op: "createText", parentId: "temp:card", tempId: "title", characters: "标题", fontSize: 18 },
      { op: "setFill", nodeId: "temp:title", color: "#FF0000" },
      { op: "setLayoutSizing", nodeId: "temp:title", horizontal: "FILL" },
    ],
  }, rt);
  assert.equal(result.status, "completed", JSON.stringify(result.errors));
  assert.equal(root.children.length, 1);
  const card = root.children[0];
  assert.equal(card.name, "卡片");
  assert.equal(card.width, 200);
  assert.equal(card.x, 10);
  assert.equal(card.layoutMode, "HORIZONTAL");
  const title = card.children[0];
  assert.equal(title.characters, "标题");
  assert.equal(title.fontSize, 18);
  assert.equal(title.layoutSizingHorizontal, "FILL");
  assert.deepEqual(result.createdIds, { card: card.id, title: title.id });
  assert.ok(loaded.has("Inter/Regular"), "default font must be loaded before writing characters");
});

test("create ops are refused under pages, inside instances and past the child count", async () => {
  const inst = container(frame("1:5", { type: "INSTANCE" }));
  const host = container(frame("1:2"));
  const rt = runtime([page(host, inst)]);
  const result = await designEditApplyEdits({
    edits: [
      { op: "createFrame", parentId: "0:1", tempId: "a", name: "a", width: 10, height: 10 },
      { op: "createFrame", parentId: "1:5", tempId: "b", name: "b", width: 10, height: 10 },
      { op: "createFrame", parentId: "1:2", tempId: "c", name: "c", width: 10, height: 10, index: 3 },
    ],
  }, rt);
  assert.equal(result.status, "blocked");
  const messages = result.blockingErrors.map((item) => item.message).join(" | ");
  assert.match(messages, /parent must be FRAME/);
  assert.match(messages, /got INSTANCE/);
  assert.match(messages, /exceeds child count 0/);
  assert.equal(host.children.length, 0);
});

test("a failure after create ops removes created nodes and restores the parent", async () => {
  const sibling = frame("1:7", { x: 50, y: 0 });
  const root = container(frame("1:2", { layoutMode: "HORIZONTAL", width: 300 }));
  adopt(root, sibling);
  const rt = runtime([page(root, lockedFrame("1:8"))]);
  const result = await designEditApplyEdits({
    edits: [
      { op: "createFrame", parentId: "1:2", tempId: "box", name: "box", width: 40, height: 40, index: 0 },
      { op: "createText", parentId: "temp:box", tempId: "t", characters: "x" },
      { op: "rename", nodeId: "1:8", name: "y" },
    ],
  }, rt);
  assert.equal(result.status, "error");
  assert.equal(result.rollback.pass, true, JSON.stringify(result.rollback));
  assert.equal(result.rollback.removedNodes, 2);
  assert.deepEqual(root.children.map((child) => child.id), ["1:7"]);
  assert.equal(root.width, 300);
  assert.equal(sibling.x, 50);
});
/** 模拟组件集合：定义在 COMPONENT_SET 上，变体读定义会抛错（与 Figma 一致）。 */
function componentSet() {
  const set = { id: "5:1", type: "COMPONENT_SET", parent: null, componentPropertyDefinitions: {
    State: { type: "VARIANT", variantOptions: ["Default", "Pressed"] },
    "Label#1:0": { type: "TEXT" },
    "Icon#2:0": { type: "BOOLEAN" },
  } };
  const created = [];
  const variant = {
    id: "5:2", type: "COMPONENT", parent: set, name: "State=Default",
    get componentPropertyDefinitions() { throw new Error("read definitions from the component set"); },
    createInstance() {
      const props = { State: { type: "VARIANT", value: "Default" }, "Label#1:0": { type: "TEXT", value: "按钮" }, "Icon#2:0": { type: "BOOLEAN", value: true } };
      const node = frame("9:" + (created.length + 1), { type: "INSTANCE", componentProperties: props, mainComponentNode: variant });
      node.remove = () => { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null; node.removed = true; };
      node.setProperties = (next) => { for (const key of Object.keys(next)) props[key] = { ...props[key], value: next[key] }; };
      created.push(node);
      return node;
    },
  };
  return { set, variant, created };
}

test("createInstance and setInstanceProperties are checked against component definitions", async () => {
  const { set, variant, created } = componentSet();
  const root = container(frame("1:2"));
  const rt = runtime([page(root), set, variant]);
  const bad = await designEditApplyEdits({
    edits: [
      { op: "createInstance", parentId: "1:2", tempId: "btn", componentId: "5:1" },
      { op: "createInstance", parentId: "1:2", tempId: "btn2", componentId: "5:2" },
      { op: "setInstanceProperties", nodeId: "temp:btn2", properties: { State: "Hover" } },
      { op: "setInstanceProperties", nodeId: "temp:btn2", properties: { "Icon#2:0": "yes" } },
      { op: "setInstanceProperties", nodeId: "1:2", properties: { State: "Default" } },
    ],
  }, rt);
  assert.equal(bad.status, "blocked");
  const messages = bad.blockingErrors.map((item) => item.message).join(" | ");
  assert.match(messages, /must be a COMPONENT/);
  assert.match(messages, /no variant "Hover"; options: Default, Pressed/);
  assert.match(messages, /Icon#2:0 expects a boolean/);
  assert.match(messages, /requires an INSTANCE/);
  assert.equal(created.length, 0, "blocked batch must not create instances");

  const ok = await designEditApplyEdits({
    edits: [
      { op: "createInstance", parentId: "1:2", tempId: "btn", componentId: "5:2", x: 4 },
      { op: "setInstanceProperties", nodeId: "temp:btn", properties: { State: "Pressed", "Label#1:0": "确定", "Icon#2:0": false } },
    ],
  }, rt);
  assert.equal(ok.status, "completed", JSON.stringify(ok.errors));
  const instance = root.children[0];
  assert.equal(instance.x, 4);
  assert.equal(instance.componentProperties.State.value, "Pressed");
  assert.equal(instance.componentProperties["Icon#2:0"].value, false);
});

test("instance property edits on existing instances roll back", async () => {
  const { set, variant } = componentSet();
  const inst = variant.createInstance();
  const rt = runtime([page(inst, lockedFrame("1:8")), set, variant]);
  const result = await designEditApplyEdits({
    edits: [
      { op: "setInstanceProperties", nodeId: inst.id, properties: { State: "Pressed", "Label#1:0": "改" } },
      { op: "rename", nodeId: "1:8", name: "y" },
    ],
  }, rt);
  assert.equal(result.status, "error");
  assert.equal(result.rollback.pass, true, JSON.stringify(result.rollback));
  assert.equal(inst.componentProperties.State.value, "Default");
  assert.equal(inst.componentProperties["Label#1:0"].value, "按钮");
});

const VARIABLES = {
  "VariableID:1:1": { id: "VariableID:1:1", resolvedType: "COLOR" },
  "VariableID:1:2": { id: "VariableID:1:2", resolvedType: "FLOAT" },
  "VariableID:1:3": { id: "VariableID:1:3", resolvedType: "FLOAT" },
};

test("bindVariable checks types and binds colors to solid paints and numbers to fields", async () => {
  const card = bindable(frame("1:2"));
  const gradient = bindable(frame("1:3", { fills: [{ type: "GRADIENT_LINEAR", visible: true }] }));
  const rt = runtime([page(card, gradient)], { variables: VARIABLES });
  const bad = await designEditApplyEdits({
    edits: [
      { op: "bindVariable", nodeId: "1:2", field: "fills", variableId: "VariableID:1:2" },
      { op: "bindVariable", nodeId: "1:2", field: "cornerRadius", variableId: "VariableID:1:1" },
      { op: "bindVariable", nodeId: "1:3", field: "fills", variableId: "VariableID:1:1" },
      { op: "bindVariable", nodeId: "1:2", field: "itemSpacing", variableId: "VariableID:9:9" },
    ],
  }, rt);
  assert.equal(bad.status, "blocked");
  const messages = bad.blockingErrors.map((item) => item.message).join(" | ");
  assert.match(messages, /fills needs a COLOR variable, got FLOAT/);
  assert.match(messages, /cornerRadius needs a FLOAT variable, got COLOR/);
  assert.match(messages, /single solid paint at this point in the batch/);
  assert.match(messages, /variable not found/);

  // 渐变先改成纯色再绑颜色变量：预检按批次顺序推演，应放行。
  const ok = await designEditApplyEdits({
    edits: [
      { op: "setFill", nodeId: "1:3", color: "#00FF00" },
      { op: "bindVariable", nodeId: "1:3", field: "fills", variableId: "VariableID:1:1" },
      { op: "bindVariable", nodeId: "1:2", field: "cornerRadius", variableId: "VariableID:1:2" },
    ],
  }, rt);
  assert.equal(ok.status, "completed", JSON.stringify(ok.errors));
  assert.equal(gradient.fills[0].boundVariables.color.id, "VariableID:1:1");
  assert.equal(card.boundVariables.cornerRadius.id, "VariableID:1:2");
  assert.equal(ok.edits[1].after["binding:fills"], "VariableID:1:1");
});

test("rollback unbinds new variables and restores the original binding", async () => {
  const card = bindable(frame("1:2"));
  card.boundVariables.cornerRadius = { type: "VARIABLE_ALIAS", id: "VariableID:1:3" };
  const rt = runtime([page(card, lockedFrame("1:8"))], { variables: VARIABLES });
  const result = await designEditApplyEdits({
    edits: [
      { op: "bindVariable", nodeId: "1:2", field: "cornerRadius", variableId: "VariableID:1:2" },
      { op: "bindVariable", nodeId: "1:2", field: "opacity", variableId: "VariableID:1:2" },
      { op: "rename", nodeId: "1:8", name: "y" },
    ],
  }, rt);
  assert.equal(result.status, "error");
  assert.equal(result.rollback.pass, true, JSON.stringify(result.rollback));
  assert.equal(card.boundVariables.cornerRadius.id, "VariableID:1:3");
  assert.equal(card.boundVariables.opacity, undefined);
});
