// ─── 通用设计编辑：只读 inspect（FIGMA_INSPECT_NODES）───
// 纯函数部分不直接依赖全局 figma，便于用假节点测试；handler 负责注入 figma.getNodeByIdAsync 与 figma.mixed。

export const DESIGN_EDIT_MAX_INSPECT_NODES = 500;
export const DESIGN_EDIT_MAX_TEXT_LENGTH = 2000;

/** 把 Figma 0..1 通道转成 #RRGGBB。 */
export function designEditRgbToHex(color) {
  const channel = (value) => {
    const number = Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 255);
    return number.toString(16).padStart(2, "0").toUpperCase();
  };
  return "#" + channel(color && color.r) + channel(color && color.g) + channel(color && color.b);
}

/** 只展开 SOLID；其他 paint 类型只报告 type，避免返回渐变/图片的大载荷。 */
export function designEditSummarizePaints(paints, mixed) {
  if (paints === mixed) return "mixed";
  if (!Array.isArray(paints)) return undefined;
  return paints.map((paint) => {
    if (!paint || paint.type !== "SOLID") return { type: paint && paint.type ? String(paint.type) : "UNKNOWN", visible: paint ? paint.visible !== false : false };
    return {
      type: "SOLID",
      color: designEditRgbToHex(paint.color),
      opacity: designEditRound(paint.opacity === undefined ? 1 : paint.opacity, 3),
      visible: paint.visible !== false,
    };
  });
}

function designEditRound(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  const factor = Math.pow(10, digits);
  return Math.round(number * factor) / factor;
}

/** 读取可能为 figma.mixed 的标量属性。 */
function designEditScalar(node, key, mixed) {
  if (!(key in node)) return undefined;
  const value = node[key];
  if (value === mixed) return "mixed";
  if (typeof value === "number") return designEditRound(value);
  return value;
}

function designEditBoundVariables(node) {
  const bound = node && node.boundVariables;
  if (!bound || typeof bound !== "object") return undefined;
  const result = {};
  for (const key of Object.keys(bound)) {
    const value = bound[key];
    if (Array.isArray(value)) {
      const ids = value.map((item) => item && item.id).filter(Boolean);
      if (ids.length) result[key] = ids;
    } else if (value && value.id) {
      result[key] = value.id;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

function designEditAutoLayout(node) {
  if (!("layoutMode" in node)) return undefined;
  const layout = { layoutMode: node.layoutMode };
  if (node.layoutMode && node.layoutMode !== "NONE") {
    layout.itemSpacing = designEditRound(node.itemSpacing);
    layout.padding = {
      top: designEditRound(node.paddingTop),
      right: designEditRound(node.paddingRight),
      bottom: designEditRound(node.paddingBottom),
      left: designEditRound(node.paddingLeft),
    };
    layout.primaryAxisAlignItems = node.primaryAxisAlignItems;
    layout.counterAxisAlignItems = node.counterAxisAlignItems;
    layout.primaryAxisSizingMode = node.primaryAxisSizingMode;
    layout.counterAxisSizingMode = node.counterAxisSizingMode;
  }
  return layout;
}

function designEditText(node, mixed, includeText) {
  if (node.type !== "TEXT") return undefined;
  const text = {
    length: typeof node.characters === "string" ? node.characters.length : 0,
    fontSize: designEditScalar(node, "fontSize", mixed),
    textAlignHorizontal: node.textAlignHorizontal,
  };
  if (node.fontName === mixed) text.fontName = "mixed";
  else if (node.fontName) text.fontName = { family: node.fontName.family, style: node.fontName.style };
  if (node.lineHeight === mixed) text.lineHeight = "mixed";
  else if (node.lineHeight) text.lineHeight = node.lineHeight.unit === "AUTO" ? "AUTO" : { unit: node.lineHeight.unit, value: designEditRound(node.lineHeight.value) };
  if (includeText && typeof node.characters === "string") {
    text.characters = node.characters.length > DESIGN_EDIT_MAX_TEXT_LENGTH
      ? node.characters.slice(0, DESIGN_EDIT_MAX_TEXT_LENGTH)
      : node.characters;
    text.truncated = node.characters.length > DESIGN_EDIT_MAX_TEXT_LENGTH;
  }
  return text;
}

/** documentAccess 为 dynamic-page 时同步读 mainComponent 会抛错：这里只作兜底，正式值由 inspect 异步补齐。 */
function designEditSyncMainComponentId(node) {
  try {
    return node.mainComponent && node.mainComponent.id ? node.mainComponent.id : "";
  } catch (error) {
    return "";
  }
}

function designEditInstance(node) {
  if (node.type !== "INSTANCE") return undefined;
  const instance = { mainComponentId: designEditSyncMainComponentId(node) };
  const props = node.componentProperties;
  if (props && typeof props === "object") {
    instance.componentProperties = {};
    for (const key of Object.keys(props)) {
      const prop = props[key] || {};
      instance.componentProperties[key] = { type: prop.type, value: prop.value };
    }
  }
  return instance;
}

/** 汇总单个节点的可编辑视觉属性；不展开子节点。 */
export function designEditDescribeNode(node, options) {
  const mixed = options && options.mixed;
  const includeText = !options || options.includeText !== false;
  const info = {
    id: node.id,
    name: node.name || "",
    type: node.type,
    parentId: node.parent && node.parent.id ? node.parent.id : "",
    x: designEditRound(node.x),
    y: designEditRound(node.y),
    width: designEditRound(node.width),
    height: designEditRound(node.height),
    visible: node.visible !== false,
    opacity: designEditRound(node.opacity === undefined ? 1 : node.opacity, 3),
  };
  if ("fills" in node) info.fills = designEditSummarizePaints(node.fills, mixed);
  if ("strokes" in node) info.strokes = designEditSummarizePaints(node.strokes, mixed);
  const strokeWeight = designEditScalar(node, "strokeWeight", mixed);
  if (strokeWeight !== undefined) info.strokeWeight = strokeWeight;
  const cornerRadius = designEditScalar(node, "cornerRadius", mixed);
  if (cornerRadius !== undefined) info.cornerRadius = cornerRadius;
  const layout = designEditAutoLayout(node);
  if (layout) info.autoLayout = layout;
  if ("layoutSizingHorizontal" in node) {
    info.layoutSizing = { horizontal: node.layoutSizingHorizontal, vertical: node.layoutSizingVertical };
  }
  const text = designEditText(node, mixed, includeText);
  if (text) info.text = text;
  const instance = designEditInstance(node);
  if (instance) info.instance = instance;
  const bound = designEditBoundVariables(node);
  if (bound) info.boundVariables = bound;
  if ("children" in node && Array.isArray(node.children)) info.childCount = node.children.length;
  return info;
}

/** 按深度展开节点树；总节点数超过上限时停止展开并标记 truncated。 */
export async function designEditInspectNodes(job, getNodeById, mixed, getMainComponent) {
  const nodeIds = Array.isArray(job && job.nodeIds) ? job.nodeIds.map(String) : [];
  const depth = Math.max(0, Math.min(3, Number(job && job.depth !== undefined ? job.depth : 1) || 0));
  const options = { mixed, includeText: !job || job.includeText !== false };
  const state = { count: 0, truncated: false };
  const missing = [];
  const nodes = [];
  const instances = [];

  const visit = (node, level) => {
    if (state.count >= DESIGN_EDIT_MAX_INSPECT_NODES) {
      state.truncated = true;
      return null;
    }
    state.count += 1;
    const info = designEditDescribeNode(node, options);
    if (info.instance) instances.push({ info, node });
    if (level < depth && "children" in node && Array.isArray(node.children)) {
      info.children = [];
      for (const child of node.children) {
        const childInfo = visit(child, level + 1);
        if (!childInfo) break;
        info.children.push(childInfo);
      }
    }
    return info;
  };

  for (const nodeId of nodeIds) {
    const node = await getNodeById(nodeId);
    if (!node) {
      missing.push(nodeId);
      continue;
    }
    if (node.type === "DOCUMENT") {
      missing.push(nodeId);
      continue;
    }
    const info = visit(node, 0);
    if (!info) break;
    nodes.push(info);
  }
  if (getMainComponent) {
    for (const { info, node } of instances) {
      const main = await getMainComponent(node);
      if (main && main.id) info.instance.mainComponentId = main.id;
    }
  }

  const status = nodes.length === 0 ? "error" : "completed";
  return {
    status,
    nodes,
    missing,
    truncated: state.truncated,
    errors: nodes.length === 0 ? ["no requested node was found: " + missing.join(", ")] : [],
    summary: { requested: nodeIds.length, found: nodes.length, missing: missing.length, described: state.count, depth, truncated: state.truncated },
  };
}

// ─── 通用设计编辑：白名单批量写入（FIGMA_APPLY_EDITS）───
// 流程：模拟预检（按批次顺序推演状态，不写入）→ 逐条应用并记录每个已有节点首次被触碰前的原值
// → 任一条失败则删除新建节点、恢复原值并核对；成功后由 handler 调用 commitUndo 合并为一步撤销。
// runtime 注入：getNodeById、loadFont、getMainComponent、getVariableById、createFrame、createText、bindPaint、mixed、log。

export const DESIGN_EDIT_SUPPORTED_OPS = [
  "setFill", "setStroke", "setCornerRadius", "setOpacity", "setVisible", "rename",
  "setText", "setTextStyle", "setAutoLayout", "setLayoutSizing",
  "createFrame", "createText", "createInstance", "setInstanceProperties", "bindVariable",
];

const DESIGN_EDIT_CREATE_OPS = new Set(["createFrame", "createText", "createInstance"]);
const DESIGN_EDIT_AUTO_LAYOUT_TYPES = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE"]);
const DESIGN_EDIT_STROKE_TYPES_EXCLUDED = new Set(["GROUP", "SLICE", "SECTION"]);
const DESIGN_EDIT_LOCKED_TYPES = new Set(["DOCUMENT", "PAGE"]);
/** 新建节点允许挂载的父节点类型；PAGE 不在内，新节点只能建在已有容器里。 */
const DESIGN_EDIT_CONTAINER_TYPES = new Set(["FRAME", "COMPONENT", "GROUP", "SECTION"]);
/** figma.createText() 的默认字体；未指定字体时沿用它。 */
const DESIGN_EDIT_DEFAULT_FONT = { family: "Inter", style: "Regular" };
/** 可绑定数值变量的属性：快照时同时记录它们的原绑定，回滚时一并恢复。 */
const DESIGN_EDIT_NUMERIC_BINDABLE = new Set([
  "itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "cornerRadius", "opacity", "width", "height", "strokeWeight",
]);
const DESIGN_EDIT_FRAME_KEYS = new Set([
  "fills", "strokes", "strokeWeight", "cornerRadius", "opacity", "visible", "name", "width", "height",
  "layoutMode", "itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "layoutSizingHorizontal", "layoutSizingVertical",
]);
const DESIGN_EDIT_TEXT_KEYS = new Set([
  "fills", "strokes", "strokeWeight", "opacity", "visible", "name", "width", "height",
  "characters", "fontSize", "fontName", "textAlignHorizontal", "layoutSizingHorizontal", "layoutSizingVertical",
]);
const DESIGN_EDIT_COMPONENT_PROPERTY_PREFIX = "componentProperty:";

/** 每种 op 会改动的节点属性；快照与回滚只处理这些键（尺寸与位置另由 geometry 记录）。 */
function designEditPropertyKeys(edit) {
  switch (edit.op) {
    case "setFill": return ["fills"];
    case "setStroke": return edit.weight === undefined ? ["strokes"] : ["strokes", "strokeWeight"];
    case "setCornerRadius": return ["cornerRadius"];
    case "setOpacity": return ["opacity"];
    case "setVisible": return ["visible"];
    case "rename": return ["name"];
    case "setText": return ["characters"];
    case "setTextStyle": return [
      ...(edit.fontFamily || edit.fontStyle ? ["fontName"] : []),
      ...(edit.fontSize === undefined ? [] : ["fontSize"]),
      ...(edit.align ? ["textAlignHorizontal"] : []),
    ];
    case "setAutoLayout": return [
      "layoutMode", "itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
      "primaryAxisAlignItems", "counterAxisAlignItems", "primaryAxisSizingMode", "counterAxisSizingMode",
    ];
    case "setLayoutSizing": return [
      ...(edit.horizontal ? ["layoutSizingHorizontal"] : []),
      ...(edit.vertical ? ["layoutSizingVertical"] : []),
    ];
    case "setInstanceProperties": return Object.keys(edit.properties || {}).map((key) => DESIGN_EDIT_COMPONENT_PROPERTY_PREFIX + key);
    case "bindVariable":
      if (edit.field === "fills" || edit.field === "strokes") return [edit.field];
      return edit.field === "width" || edit.field === "height" ? [] : [edit.field];
    default: return [];
  }
}

/** 需要同时快照变量绑定的键：被改动的可绑定数值属性，以及 bindVariable 的数值字段。 */
function designEditBindingKeys(edit) {
  const keys = designEditPropertyKeys(edit).filter((key) => DESIGN_EDIT_NUMERIC_BINDABLE.has(key));
  if (edit.op === "bindVariable" && DESIGN_EDIT_NUMERIC_BINDABLE.has(edit.field) && !keys.includes(edit.field)) keys.push(edit.field);
  return keys;
}

function designEditHexToRgb(hex) {
  const value = String(hex || "").replace("#", "");
  return {
    r: parseInt(value.slice(0, 2), 16) / 255,
    g: parseInt(value.slice(2, 4), 16) / 255,
    b: parseInt(value.slice(4, 6), 16) / 255,
  };
}

function designEditSolidPaint(color, opacity) {
  return [{ type: "SOLID", color: designEditHexToRgb(color), opacity: opacity === undefined ? 1 : opacity, visible: true }];
}

/** 深拷贝 Figma 属性值；Paint 数组、fontName、lineHeight 等都是可 JSON 化的普通对象。figma.mixed 等 symbol 原样保留。 */
function designEditCloneValue(value) {
  if (value === null || value === undefined || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}

function designEditSameValue(left, right) {
  return JSON.stringify(designEditCloneValue(left)) === JSON.stringify(designEditCloneValue(right));
}

function designEditFontKey(fontName) {
  return fontName ? String(fontName.family) + "\u0000" + String(fontName.style) : "";
}

function designEditErrorMessage(error) {
  return error && error.message ? error.message : String(error);
}

function designEditIsSingleSolid(paints) {
  return Array.isArray(paints) && paints.length === 1 && paints[0] && paints[0].type === "SOLID";
}

function designEditPageOf(node) {
  let current = node;
  while (current && current.type !== "PAGE") current = current.parent;
  return current || null;
}

function designEditInsideInstance(node) {
  for (let current = node; current; current = current.parent) if (current.type === "INSTANCE") return true;
  return false;
}

/** 读取快照键的当前值；组件属性键读 componentProperties。 */
function designEditReadKey(node, key) {
  if (key.startsWith(DESIGN_EDIT_COMPONENT_PROPERTY_PREFIX)) {
    const props = node.componentProperties || {};
    const prop = props[key.slice(DESIGN_EDIT_COMPONENT_PROPERTY_PREFIX.length)];
    return prop ? prop.value : undefined;
  }
  return node[key];
}

function designEditHasKey(node, key) {
  if (key.startsWith(DESIGN_EDIT_COMPONENT_PROPERTY_PREFIX)) return designEditReadKey(node, key) !== undefined;
  return key in node;
}

function designEditBoundId(node, field) {
  const bound = node && node.boundVariables;
  const alias = bound && typeof bound === "object" ? bound[field] : null;
  return alias && !Array.isArray(alias) && alias.id ? String(alias.id) : null;
}

// ─── 模拟预检 ───
// 每个被引用的节点对应一个 view：已有节点读真实值，新建节点读默认值；前序 edit 的效果记入 view.values，
// 所以后续 edit 检查的是「执行到这一条时」的状态（例如先关掉父级 auto layout，再对子节点设 FILL，会在预检被拦下）。

function designEditViewGet(view, key) {
  if (view.values.has(key)) return view.values.get(key);
  if (view.node) return view.node[key];
  if (view.proto && key in view.proto) return view.proto[key];
  return view.defaults ? view.defaults[key] : undefined;
}

function designEditViewHas(view, key) {
  if (view.node) return key in view.node;
  if (view.keys) return view.keys.has(key);
  return Boolean(view.proto) && key in view.proto;
}

function designEditExistingView(sim, node) {
  let view = sim.views.get(node.id);
  if (view) return view;
  view = {
    ref: node.id, node, type: node.type, created: false, values: new Map(),
    childCount: Array.isArray(node.children) ? node.children.length : 0,
    insideInstance: designEditInsideInstance(node), page: designEditPageOf(node),
  };
  sim.views.set(node.id, view);
  return view;
}

function designEditParentView(sim, view) {
  if (view.created) return view.parentView;
  return view.node.parent ? designEditExistingView(sim, view.node.parent) : null;
}

/** 解析 nodeId / parentId：真实节点或同批新建的 temp:<tempId>。返回 view 或阻塞原因字符串。 */
async function designEditResolveRef(ref, ctx, asParent) {
  const id = String(ref || "");
  if (id.startsWith("temp:")) return ctx.sim.temps.get(id.slice(5)) || "temp reference used before creation: " + id;
  const node = await ctx.runtime.getNodeById(id);
  if (!node) return "node not found: " + id;
  if (node.removed) return "node was removed: " + node.id;
  if (!asParent && DESIGN_EDIT_LOCKED_TYPES.has(node.type)) return "refuse to edit " + node.type + " node " + node.id;
  return designEditExistingView(ctx.sim, node);
}

function designEditCheckPage(view, ctx) {
  if (!ctx.page) ctx.page = view.page;
  return view.page === ctx.page ? null : "node " + view.ref + " is not on the same page as the first edit target";
}

/** 组件属性定义：变体组件要从所属 COMPONENT_SET 读取（直接读变体会抛错）。 */
function designEditComponentDefinitions(component) {
  try {
    const owner = component.parent && component.parent.type === "COMPONENT_SET" ? component.parent : component;
    return owner.componentPropertyDefinitions || {};
  } catch (error) {
    return null;
  }
}

/** 实例可设置的属性：名称 → { type, variantOptions? }。已有实例读 componentProperties，新建实例读主组件定义。 */
async function designEditInstancePropertyTypes(view, ctx) {
  if (view.propertyTypes) return view.propertyTypes;
  const types = {};
  let definitions = null;
  if (view.created) {
    definitions = designEditComponentDefinitions(view.component) || {};
    for (const key of Object.keys(definitions)) types[key] = { type: definitions[key].type };
  } else {
    const props = view.node.componentProperties || {};
    for (const key of Object.keys(props)) types[key] = { type: props[key] && props[key].type };
    const main = ctx.runtime.getMainComponent ? await ctx.runtime.getMainComponent(view.node) : null;
    definitions = main ? designEditComponentDefinitions(main) : null;
  }
  for (const key of Object.keys(types)) {
    const definition = definitions && definitions[key];
    if (definition && Array.isArray(definition.variantOptions)) types[key].variantOptions = definition.variantOptions.map(String);
  }
  view.propertyTypes = types;
  return types;
}

function designEditCheckInstanceValue(name, info, value) {
  if (!info) return "instance has no component property " + JSON.stringify(name);
  if (info.type === "BOOLEAN") return typeof value === "boolean" ? null : name + " expects a boolean";
  if (typeof value !== "string") return name + " expects a string";
  if (info.type === "VARIANT" && info.variantOptions && !info.variantOptions.includes(value)) {
    return name + " has no variant " + JSON.stringify(value) + "; options: " + info.variantOptions.join(", ");
  }
  return null;
}

function designEditAddFont(ctx, font, index) {
  if (font && font.family && font.style && !ctx.fonts.has(designEditFontKey(font))) ctx.fonts.set(designEditFontKey(font), { font, index });
}

function designEditCreatedView(ctx, edit, parentView, type, extra) {
  const view = {
    ref: "temp:" + edit.tempId, node: null, type, created: true, values: new Map(), childCount: 0,
    insideInstance: false, page: parentView.page, parentView, ...extra,
  };
  ctx.sim.temps.set(edit.tempId, view);
  parentView.childCount += 1;
  return view;
}

/** 检查父容器并在模拟状态中登记一个新建节点。 */
async function designEditSimulateCreate(edit, index, ctx, step) {
  const parent = await designEditResolveRef(edit.parentId, ctx, true);
  if (typeof parent === "string") return parent;
  const pageReason = designEditCheckPage(parent, ctx);
  if (pageReason) return pageReason;
  if (!DESIGN_EDIT_CONTAINER_TYPES.has(parent.type)) return "parent must be FRAME/COMPONENT/GROUP/SECTION, got " + parent.type;
  if (parent.insideInstance) return "cannot add children inside an instance: " + parent.ref;
  if (edit.index !== undefined && edit.index > parent.childCount) return "index " + edit.index + " exceeds child count " + parent.childCount + " of " + parent.ref;
  step.parentView = parent;
  if (edit.op === "createFrame") {
    step.view = designEditCreatedView(ctx, edit, parent, "FRAME", {
      keys: DESIGN_EDIT_FRAME_KEYS,
      defaults: {
        name: edit.name, width: edit.width, height: edit.height, fills: designEditSolidPaint("#FFFFFF"), strokes: [], strokeWeight: 1,
        cornerRadius: 0, opacity: 1, visible: true, layoutMode: "NONE", layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED",
      },
    });
    return null;
  }
  if (edit.op === "createText") {
    const font = { family: edit.fontFamily || DESIGN_EDIT_DEFAULT_FONT.family, style: edit.fontStyle || DESIGN_EDIT_DEFAULT_FONT.style };
    designEditAddFont(ctx, font, index);
    step.font = font;
    step.view = designEditCreatedView(ctx, edit, parent, "TEXT", {
      keys: DESIGN_EDIT_TEXT_KEYS,
      defaults: {
        name: edit.characters, characters: edit.characters, fontName: font, fontSize: edit.fontSize === undefined ? 12 : edit.fontSize,
        fills: designEditSolidPaint("#000000"), strokes: [], strokeWeight: 1, opacity: 1, visible: true, textAlignHorizontal: "LEFT",
        layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED",
      },
    });
    return null;
  }
  const component = await ctx.runtime.getNodeById(edit.componentId);
  if (!component) return "component not found: " + edit.componentId;
  if (component.type !== "COMPONENT") return "componentId must be a COMPONENT (pick a variant, not the set), got " + component.type;
  let anchor = parent;
  while (anchor.created) anchor = anchor.parentView;
  for (let node = anchor.node; node; node = node.parent) {
    if (node.id === component.id) return "cannot place an instance inside its own component " + component.id;
  }
  step.component = component;
  step.view = designEditCreatedView(ctx, edit, parent, "INSTANCE", { proto: component, component });
  return null;
}

/** 模拟单条属性类 edit：检查「执行到这一条时」的状态，通过后把效果记入 view。返回阻塞原因或 null。 */
async function designEditSimulateProperty(edit, index, ctx, step) {
  const view = await designEditResolveRef(edit.nodeId, ctx, false);
  if (typeof view === "string") return view;
  const pageReason = designEditCheckPage(view, ctx);
  if (pageReason) return pageReason;
  step.view = view;
  const get = (key) => designEditViewGet(view, key);
  const set = (key, value) => view.values.set(key, value);
  switch (edit.op) {
    case "setFill":
      if (!designEditViewHas(view, "fills")) return view.type + " does not support fills";
      set("fills", designEditSolidPaint(edit.color, edit.opacity));
      return null;
    case "setStroke":
      if (!designEditViewHas(view, "strokes") || DESIGN_EDIT_STROKE_TYPES_EXCLUDED.has(view.type)) return view.type + " does not support strokes";
      set("strokes", designEditSolidPaint(edit.color, 1));
      return null;
    case "setCornerRadius":
      return designEditViewHas(view, "cornerRadius") ? null : view.type + " does not support cornerRadius";
    case "setOpacity": case "setVisible": case "rename":
      return null;
    case "setText":
    case "setTextStyle": {
      if (view.type !== "TEXT") return edit.op + " requires a TEXT node, got " + view.type;
      const current = get("fontName");
      const changesFont = edit.op === "setTextStyle" && (edit.fontFamily || edit.fontStyle);
      if (current === ctx.runtime.mixed && !changesFont) return "text " + view.ref + " uses mixed fonts; set fontFamily/fontStyle explicitly or edit it by hand";
      // Figma 写 characters/fontSize/fontName 前要求原字体已加载（回滚写回原字体也一样）；改字体还需新字体。
      if (current && current !== ctx.runtime.mixed) designEditAddFont(ctx, current, index);
      if (changesFont) {
        const base = current && current !== ctx.runtime.mixed ? current : {};
        const next = { family: edit.fontFamily || base.family, style: edit.fontStyle || base.style || "Regular" };
        if (!next.family) return "text " + view.ref + " uses mixed fonts; set fontFamily explicitly";
        designEditAddFont(ctx, next, index);
        set("fontName", next);
      }
      return null;
    }
    case "setAutoLayout":
      if (!DESIGN_EDIT_AUTO_LAYOUT_TYPES.has(view.type)) return "setAutoLayout requires FRAME/COMPONENT/INSTANCE, got " + view.type;
      set("layoutMode", edit.mode);
      return null;
    case "setLayoutSizing": {
      if (!designEditViewHas(view, "layoutSizingHorizontal")) return view.type + " does not support layout sizing";
      const parent = designEditParentView(ctx.sim, view);
      const parentMode = parent ? designEditViewGet(parent, "layoutMode") : "NONE";
      const selfMode = get("layoutMode");
      if ((edit.horizontal === "FILL" || edit.vertical === "FILL") && (!parentMode || parentMode === "NONE")) {
        return "FILL requires an auto layout parent for " + view.ref + " at this point in the batch";
      }
      if ((edit.horizontal === "HUG" || edit.vertical === "HUG") && (!selfMode || selfMode === "NONE") && view.type !== "TEXT") {
        return "HUG requires an auto layout frame or text for " + view.ref + " at this point in the batch";
      }
      return null;
    }
    case "setInstanceProperties": {
      if (view.type !== "INSTANCE") return "setInstanceProperties requires an INSTANCE, got " + view.type;
      const types = await designEditInstancePropertyTypes(view, ctx);
      for (const name of Object.keys(edit.properties)) {
        const reason = designEditCheckInstanceValue(name, types[name], edit.properties[name]);
        if (reason) return reason;
      }
      return null;
    }
    case "bindVariable":
      return designEditSimulateBind(edit, view, ctx, step);
    default:
      return "unsupported op in this build: " + edit.op;
  }
}

/** bindVariable：颜色变量绑到单一纯色填充/描边，数值变量绑到节点数值属性。 */
async function designEditSimulateBind(edit, view, ctx, step) {
  const variable = ctx.runtime.getVariableById ? await ctx.runtime.getVariableById(edit.variableId) : null;
  if (!variable) return "variable not found: " + edit.variableId;
  step.variable = variable;
  if (edit.field === "fills" || edit.field === "strokes") {
    if (variable.resolvedType !== "COLOR") return edit.field + " needs a COLOR variable, got " + variable.resolvedType;
    if (!designEditViewHas(view, edit.field)) return view.type + " does not support " + edit.field;
    if (!designEditIsSingleSolid(designEditViewGet(view, edit.field))) return edit.field + " of " + view.ref + " must be a single solid paint at this point in the batch; setFill/setStroke first";
    return null;
  }
  if (variable.resolvedType !== "FLOAT") return edit.field + " needs a FLOAT variable, got " + variable.resolvedType;
  if (!designEditViewHas(view, edit.field)) return view.type + " does not support " + edit.field;
  if (typeof designEditViewGet(view, edit.field) !== "number" && view.node) return edit.field + " of " + view.ref + " is mixed; set a single value first";
  return null;
}

/** 按批次顺序模拟全部 edit，收集阻塞原因和需要加载的字体；不写入任何节点。 */
async function designEditPrecheck(edits, runtime) {
  const ctx = { runtime, sim: { views: new Map(), temps: new Map() }, page: null, fonts: new Map() };
  const steps = [];
  const blockingErrors = [];
  for (let index = 0; index < edits.length; index += 1) {
    const edit = edits[index];
    const step = { index, edit, view: null };
    steps.push(step);
    let reason;
    if (!DESIGN_EDIT_SUPPORTED_OPS.includes(edit.op)) reason = "unsupported op in this build: " + edit.op;
    else if (DESIGN_EDIT_CREATE_OPS.has(edit.op)) reason = await designEditSimulateCreate(edit, index, ctx, step);
    else reason = await designEditSimulateProperty(edit, index, ctx, step);
    if (reason) blockingErrors.push({ index, op: edit.op, nodeId: edit.nodeId || edit.parentId, message: reason });
  }
  for (const { font, index } of ctx.fonts.values()) {
    try {
      await runtime.loadFont(font);
    } catch (error) {
      const edit = edits[index];
      blockingErrors.push({ index, op: edit.op, nodeId: edit.nodeId || edit.parentId, message: "font unavailable: " + font.family + " " + font.style });
    }
  }
  blockingErrors.sort((left, right) => left.index - right.index);
  return { steps, blockingErrors, fontCount: ctx.fonts.size, nodeCount: ctx.sim.views.size, createCount: ctx.sim.temps.size };
}

// ─── 执行 ───

function designEditInsert(parent, node, index) {
  if (index === undefined) parent.appendChild(node);
  else parent.insertChild(index, node);
}

function designEditPlace(node, edit) {
  if (edit.x !== undefined) node.x = edit.x;
  if (edit.y !== undefined) node.y = edit.y;
}

/** 执行创建类 edit。节点一创建就登记到 created，即使后续插入失败也会在回滚时删除。 */
function designEditApplyCreate(step, parent, state, runtime) {
  const edit = step.edit;
  let node;
  if (edit.op === "createFrame") {
    node = runtime.createFrame();
    state.created.push(node);
    node.name = edit.name;
    node.resize(edit.width, edit.height);
  } else if (edit.op === "createText") {
    node = runtime.createText();
    state.created.push(node);
    node.fontName = step.font;
    node.characters = edit.characters;
    if (edit.fontSize !== undefined) node.fontSize = edit.fontSize;
  } else {
    node = step.component.createInstance();
    state.created.push(node);
  }
  designEditInsert(parent, node, edit.index);
  designEditPlace(node, edit);
  state.temps.set(edit.tempId, node);
  return node;
}

function designEditApplyAutoLayout(edit, node) {
  node.layoutMode = edit.mode;
  if (edit.mode === "NONE") return;
  if (edit.itemSpacing !== undefined) node.itemSpacing = edit.itemSpacing;
  if (edit.padding !== undefined) {
    const padding = typeof edit.padding === "number"
      ? { top: edit.padding, right: edit.padding, bottom: edit.padding, left: edit.padding }
      : edit.padding;
    if (padding.top !== undefined) node.paddingTop = padding.top;
    if (padding.right !== undefined) node.paddingRight = padding.right;
    if (padding.bottom !== undefined) node.paddingBottom = padding.bottom;
    if (padding.left !== undefined) node.paddingLeft = padding.left;
  }
  if (edit.primaryAlign) node.primaryAxisAlignItems = edit.primaryAlign;
  if (edit.counterAlign) node.counterAxisAlignItems = edit.counterAlign;
  if (edit.sizing && edit.sizing.primary) node.primaryAxisSizingMode = edit.sizing.primary;
  if (edit.sizing && edit.sizing.counter) node.counterAxisSizingMode = edit.sizing.counter;
}

/** 颜色变量只能绑到 Paint 上：取当前唯一的纯色 Paint，生成绑定后的副本再整体写回。 */
function designEditBindPaint(node, field, variable, runtime) {
  const paints = node[field];
  if (!designEditIsSingleSolid(paints)) throw new Error(field + " of " + node.id + " is not a single solid paint");
  node[field] = [runtime.bindPaint(designEditCloneValue(paints[0]), "color", variable)];
}

function designEditApplyOne(step, node, runtime) {
  const edit = step.edit;
  switch (edit.op) {
    case "setFill": node.fills = designEditSolidPaint(edit.color, edit.opacity); return;
    case "setStroke":
      node.strokes = designEditSolidPaint(edit.color, 1);
      if (edit.weight !== undefined) node.strokeWeight = edit.weight;
      return;
    case "setCornerRadius": node.cornerRadius = edit.radius; return;
    case "setOpacity": node.opacity = edit.opacity; return;
    case "setVisible": node.visible = edit.visible; return;
    case "rename": node.name = edit.name; return;
    case "setText": node.characters = edit.characters; return;
    case "setTextStyle":
      if (edit.fontFamily || edit.fontStyle) {
        const current = node.fontName && typeof node.fontName === "object" ? node.fontName : {};
        node.fontName = { family: edit.fontFamily || current.family, style: edit.fontStyle || current.style || "Regular" };
      }
      if (edit.fontSize !== undefined) node.fontSize = edit.fontSize;
      if (edit.align) node.textAlignHorizontal = edit.align;
      return;
    case "setAutoLayout": designEditApplyAutoLayout(edit, node); return;
    case "setLayoutSizing":
      if (edit.horizontal) node.layoutSizingHorizontal = edit.horizontal;
      if (edit.vertical) node.layoutSizingVertical = edit.vertical;
      return;
    case "setInstanceProperties": node.setProperties(designEditCloneValue(edit.properties)); return;
    case "bindVariable":
      if (edit.field === "fills" || edit.field === "strokes") designEditBindPaint(node, edit.field, step.variable, runtime);
      else node.setBoundVariable(edit.field, step.variable);
      return;
    default:
      throw new Error("unsupported op in this build: " + edit.op);
  }
}

// ─── 快照与回滚 ───
// 回滚表只登记已有节点；新建节点记在 state.created，回滚时直接删除。

function designEditSnapshotFor(node) {
  return {
    node, values: new Map(), bindings: new Map(),
    geometry: { x: node.x, y: node.y, width: node.width, height: node.height }, children: null,
  };
}

/** 记录单条 edit 将改动的键在执行前的原值、数值变量绑定，以及 auto layout 可能挪动的子节点几何。 */
function designEditCaptureSnapshot(node, edit) {
  const snapshot = designEditSnapshotFor(node);
  for (const key of designEditPropertyKeys(edit)) {
    if (designEditHasKey(node, key)) snapshot.values.set(key, designEditCloneValue(designEditReadKey(node, key)));
  }
  for (const key of designEditBindingKeys(edit)) snapshot.bindings.set(key, designEditBoundId(node, key));
  // 改 auto layout、子节点尺寸模式、宽高都可能重排兄弟或子节点：记录相关容器的子节点位置。
  if (Array.isArray(node.children) && (edit.op === "setAutoLayout" || edit.op === "bindVariable")) {
    snapshot.children = node.children.map((child) => ({ node: child, x: child.x, y: child.y, width: child.width, height: child.height }));
  }
  return snapshot;
}

/** 把执行前快照并入回滚表；同一节点只保留最早的原值、绑定和几何信息。 */
function designEditMergeSnapshot(entries, snapshot) {
  const existing = entries.get(snapshot.node.id);
  if (!existing) {
    entries.set(snapshot.node.id, snapshot);
    return;
  }
  for (const [key, value] of snapshot.values) if (!existing.values.has(key)) existing.values.set(key, value);
  for (const [key, value] of snapshot.bindings) if (!existing.bindings.has(key)) existing.bindings.set(key, value);
  if (!existing.children && snapshot.children) existing.children = snapshot.children;
}

/** 失败那条可能已写入部分属性：只保留实际发生变化的键，避免回滚时重写刚被 Figma 拒绝的属性。 */
function designEditTrimUnchanged(snapshot) {
  const node = snapshot.node;
  for (const key of Array.from(snapshot.values.keys())) {
    if (designEditSameValue(designEditReadKey(node, key), snapshot.values.get(key))) snapshot.values.delete(key);
  }
  for (const key of Array.from(snapshot.bindings.keys())) {
    if (designEditBoundId(node, key) === snapshot.bindings.get(key)) snapshot.bindings.delete(key);
  }
}

function designEditResize(node, width, height) {
  if (typeof node.resize === "function" && (node.width !== width || node.height !== height)) node.resize(width, height);
}

const DESIGN_EDIT_RESTORE_FIRST = ["layoutMode", "primaryAxisSizingMode", "counterAxisSizingMode", "layoutSizingHorizontal", "layoutSizingVertical"];

function designEditRestoreKey(node, key, value) {
  if (key.startsWith(DESIGN_EDIT_COMPONENT_PROPERTY_PREFIX)) {
    node.setProperties({ [key.slice(DESIGN_EDIT_COMPONENT_PROPERTY_PREFIX.length)]: value });
    return;
  }
  node[key] = designEditCloneValue(value);
}

async function designEditRestoreBindings(entry, runtime, errors, phase) {
  for (const [key, originalId] of entry.bindings) {
    if (designEditBoundId(entry.node, key) === originalId) continue;
    try {
      if (phase === "unbind") entry.node.setBoundVariable(key, null);
      else if (originalId) entry.node.setBoundVariable(key, await runtime.getVariableById(originalId));
    } catch (error) {
      errors.push(phase + " " + key + " on " + entry.node.id + ": " + designEditErrorMessage(error));
    }
  }
}

/**
 * 回滚：先删除本批新建的节点（倒序），再恢复已有节点。
 * 已有节点的顺序：解除新绑定 → 结构属性（layoutMode 等）→ 尺寸/位置 → 其余属性 → 重建原绑定 → 子节点位置；最后逐项核对。
 */
export async function designEditRollback(state, runtime) {
  const mixed = runtime.mixed;
  const errors = [];
  const mismatches = [];
  const created = state.created || [];
  for (const node of created.slice().reverse()) {
    try {
      if (!node.removed) node.remove();
    } catch (error) {
      errors.push("remove created " + node.id + ": " + designEditErrorMessage(error));
    }
  }
  const ordered = Array.from(state.entries.values()).reverse();
  for (const entry of ordered) {
    const node = entry.node;
    const restore = (key) => {
      if (!entry.values.has(key)) return;
      const value = entry.values.get(key);
      if (value === mixed) return;
      try {
        designEditRestoreKey(node, key, value);
      } catch (error) {
        errors.push("restore " + key + " on " + node.id + ": " + designEditErrorMessage(error));
      }
    };
    await designEditRestoreBindings(entry, runtime, errors, "unbind");
    DESIGN_EDIT_RESTORE_FIRST.forEach(restore);
    try {
      designEditResize(node, entry.geometry.width, entry.geometry.height);
      node.x = entry.geometry.x;
      node.y = entry.geometry.y;
    } catch (error) {
      errors.push("restore geometry on " + node.id + ": " + designEditErrorMessage(error));
    }
    for (const key of entry.values.keys()) if (!DESIGN_EDIT_RESTORE_FIRST.includes(key)) restore(key);
    await designEditRestoreBindings(entry, runtime, errors, "rebind");
    for (const child of entry.children || []) {
      try {
        designEditResize(child.node, child.width, child.height);
        child.node.x = child.x;
        child.node.y = child.y;
      } catch (error) {
        errors.push("restore child geometry " + child.node.id + ": " + designEditErrorMessage(error));
      }
    }
  }
  for (const node of created) if (!node.removed) mismatches.push({ nodeId: node.id, key: "removed" });
  for (const entry of ordered) {
    for (const [key, expected] of entry.values) {
      if (expected !== mixed && !designEditSameValue(designEditReadKey(entry.node, key), expected)) mismatches.push({ nodeId: entry.node.id, key });
    }
    for (const [key, expected] of entry.bindings) {
      if (designEditBoundId(entry.node, key) !== expected) mismatches.push({ nodeId: entry.node.id, key: "binding:" + key });
    }
  }
  return {
    pass: errors.length === 0 && mismatches.length === 0,
    restoredNodes: ordered.length, removedNodes: created.length, errors, mismatches,
  };
}

function designEditBriefValue(key, value, mixed) {
  if (value === mixed) return "mixed";
  if (key === "characters") return { length: typeof value === "string" ? value.length : 0 };
  if ((key === "fills" || key === "strokes") && Array.isArray(value)) return designEditSummarizePaints(value, mixed);
  return designEditCloneValue(value);
}

/** 单条 edit 的前/后值摘要；新建节点没有 before，只报告 tempId 与新 id。 */
function designEditDescribeStep(step, node, mixed, phase) {
  const edit = step.edit;
  const item = { index: step.index, op: edit.op, nodeId: edit.nodeId || edit.parentId || "" };
  if (DESIGN_EDIT_CREATE_OPS.has(edit.op)) {
    item.tempId = edit.tempId;
    if (node) item.createdId = node.id;
    return item;
  }
  item.nodeName = node ? node.name : "";
  if (node) {
    const values = {};
    for (const key of designEditPropertyKeys(edit)) if (designEditHasKey(node, key)) values[key] = designEditBriefValue(key, designEditReadKey(node, key), mixed);
    if (edit.op === "bindVariable") values["binding:" + edit.field] = designEditBoundId(node, edit.field) || (edit.field === "fills" || edit.field === "strokes" ? designEditPaintBinding(node, edit.field) : null);
    item[phase] = values;
  }
  return item;
}

function designEditPaintBinding(node, field) {
  const paints = Array.isArray(node[field]) ? node[field] : [];
  const bound = paints[0] && paints[0].boundVariables && paints[0].boundVariables.color;
  return bound && bound.id ? String(bound.id) : null;
}

/** 返回 step 当前对应的真实节点：已有节点即 view.node，新建节点按 temp 映射查找。 */
function designEditStepNode(step, state) {
  if (DESIGN_EDIT_CREATE_OPS.has(step.edit.op)) return state.temps.get(step.edit.tempId) || null;
  const view = step.view;
  if (!view) return null;
  return view.created ? state.temps.get(view.ref.slice(5)) || null : view.node;
}

function designEditBlockedResult(status, dryRun, preview, blockingErrors, editCount) {
  return {
    status, allPass: false, dryRun, applied: 0, edits: preview, blockingErrors,
    errors: blockingErrors.slice(0, 5).map((item) => "edit " + item.index + " (" + item.op + "): " + item.message),
    summary: { editCount, applied: 0, blocking: blockingErrors.length, dryRun },
  };
}

/** 执行一批编辑。返回结果对象；不调用 commitUndo（由 handler 在成功后调用）。 */
export async function designEditApplyEdits(job, runtime) {
  const edits = Array.isArray(job && job.edits) ? job.edits : [];
  const dryRun = Boolean(job && job.dryRun);
  const mixed = runtime.mixed;
  const log = runtime.log || function () {};

  // 1. 模拟预检：全部在写入前完成。
  const precheck = await designEditPrecheck(edits, runtime);
  const { steps, blockingErrors } = precheck;
  log("precheck", {
    editCount: edits.length, nodeCount: precheck.nodeCount, createCount: precheck.createCount,
    fontCount: precheck.fontCount, blockingCount: blockingErrors.length, dryRun,
  });
  const preview = steps.map((step) => designEditDescribeStep(step, step.view && !step.view.created ? step.view.node : null, mixed, "before"));
  if (blockingErrors.length > 0) return designEditBlockedResult("blocked", dryRun, preview, blockingErrors, edits.length);
  if (dryRun) {
    return {
      status: "completed", allPass: true, dryRun: true, applied: 0, edits: preview, blockingErrors: [], errors: [],
      summary: { editCount: edits.length, applied: 0, created: 0, blocking: 0, dryRun: true },
    };
  }

  // 2. 逐条应用。已有节点：执行前快照，成功后并入回滚表；新建节点：登记到 created。任一失败即回滚。
  const state = { entries: new Map(), created: [], temps: new Map() };
  let applied = 0;
  for (const step of steps) {
    const edit = step.edit;
    let pending = null;
    try {
      if (DESIGN_EDIT_CREATE_OPS.has(edit.op)) {
        const parent = step.parentView.created ? state.temps.get(step.parentView.ref.slice(5)) : step.parentView.node;
        // 插入新节点会改变 auto layout 父级的尺寸和其余子节点的位置：先记录父级几何。
        if (!step.parentView.created) {
          pending = designEditSnapshotFor(parent);
          pending.children = Array.isArray(parent.children) ? parent.children.map((child) => ({ node: child, x: child.x, y: child.y, width: child.width, height: child.height })) : null;
        }
        designEditApplyCreate(step, parent, state, runtime);
      } else {
        const node = designEditStepNode(step, state);
        if (!node) throw new Error("target node missing at apply time: " + edit.nodeId);
        if (!step.view.created) pending = designEditCaptureSnapshot(node, edit);
        designEditApplyOne(step, node, runtime);
      }
      if (pending) designEditMergeSnapshot(state.entries, pending);
      applied += 1;
    } catch (error) {
      if (pending) {
        designEditTrimUnchanged(pending);
        designEditMergeSnapshot(state.entries, pending);
      }
      const message = designEditErrorMessage(error);
      log("apply-failed", { index: step.index, op: edit.op, nodeId: edit.nodeId || edit.parentId, applied, error: message });
      const rollback = await designEditRollback(state, runtime);
      log("rollback", {
        restoredNodes: rollback.restoredNodes, removedNodes: rollback.removedNodes,
        errorCount: rollback.errors.length, mismatchCount: rollback.mismatches.length, pass: rollback.pass,
      });
      return {
        status: "error", allPass: false, dryRun: false, applied: 0, failedIndex: step.index, edits: preview, rollback,
        blockingErrors: [{ index: step.index, op: edit.op, nodeId: edit.nodeId || edit.parentId, message }],
        errors: ["edit " + step.index + " (" + edit.op + ") failed: " + message + (rollback.pass ? "; batch rolled back" : "; rollback incomplete")],
        summary: { editCount: edits.length, applied: 0, attempted: applied + 1, rolledBack: rollback.pass, dryRun: false },
      };
    }
  }

  const results = steps.map((step, index) => {
    const after = designEditDescribeStep(step, designEditStepNode(step, state), mixed, "after");
    return { ...preview[index], ...after };
  });
  const createdIds = {};
  for (const [tempId, node] of state.temps) createdIds[tempId] = node.id;
  log("applied", { applied, nodeCount: state.entries.size, created: state.created.length });
  return {
    status: "completed", allPass: true, dryRun: false, applied, edits: results, createdIds, blockingErrors: [], errors: [],
    summary: { editCount: edits.length, applied, nodeCount: state.entries.size, created: state.created.length, dryRun: false },
  };
}

/** 插件 handler：成功写入后 commitUndo，使整批修改在 Figma 中一次 Ctrl+Z 撤销。 */
async function handleFigmaApplyEdits(message) {
  const job = message && message.job ? message.job : {};
  const operation = pluginLogger.startOperation("design-edit.apply", {
    operationId: message.operationId || message.requestId,
    data: { requestId: message.requestId, editCount: Array.isArray(job.edits) ? job.edits.length : 0, dryRun: Boolean(job.dryRun) },
  });
  let result;
  try {
    result = await designEditApplyEdits(job, {
      getNodeById: (id) => figma.getNodeByIdAsync(id).catch(() => null),
      loadFont: (font) => figma.loadFontAsync(font),
      getMainComponent: (node) => node.getMainComponentAsync().catch(() => null),
      getVariableById: (id) => figma.variables.getVariableByIdAsync(id).catch(() => null),
      createFrame: () => figma.createFrame(),
      createText: () => figma.createText(),
      bindPaint: (paint, field, variable) => figma.variables.setBoundVariableForPaint(paint, field, variable),
      mixed: figma.mixed,
      log: (stage, data) => operation.step(stage, "设计编辑 " + stage, data),
    });
    if (result.status === "completed" && !result.dryRun && result.applied > 0 && typeof figma.commitUndo === "function") {
      figma.commitUndo();
    }
    if (result.status === "completed") operation.succeed("设计编辑完成", result.summary);
    else operation.fail(new Error(result.errors[0] || result.status), "设计编辑未写入", result.summary);
  } catch (error) {
    result = { status: "error", allPass: false, applied: 0, edits: [], blockingErrors: [], errors: [error instanceof Error ? error.message : String(error)] };
    operation.fail(error, "设计编辑异常");
  }
  figma.ui.postMessage({ type: "FIGMA_APPLY_EDITS_RESULT", requestId: message.requestId, result });
}

/** 插件 handler：注入 Figma 运行时依赖，结果通过 _RESULT 消息回传 UI。 */
async function handleFigmaInspectNodes(message) {
  const job = message && message.job ? message.job : {};
  const context = { operationId: message.operationId || message.requestId, operationName: "design-edit.inspect" };
  pluginLogger.info("设计编辑 inspect 开始", { requestId: message.requestId, nodeCount: Array.isArray(job.nodeIds) ? job.nodeIds.length : 0, depth: job.depth }, context);
  let result;
  try {
    result = await designEditInspectNodes(
      job,
      (id) => figma.getNodeByIdAsync(id).catch(() => null),
      figma.mixed,
      (node) => node.getMainComponentAsync().catch(() => null),
    );
    pluginLogger.info("设计编辑 inspect 完成", { requestId: message.requestId, ...result.summary }, context);
  } catch (error) {
    result = { status: "error", nodes: [], missing: [], truncated: false, errors: [error instanceof Error ? error.message : String(error)] };
    pluginLogger.error("设计编辑 inspect 失败", error, { requestId: message.requestId }, context);
  }
  figma.ui.postMessage({ type: "FIGMA_INSPECT_NODES_RESULT", requestId: message.requestId, result });
}
