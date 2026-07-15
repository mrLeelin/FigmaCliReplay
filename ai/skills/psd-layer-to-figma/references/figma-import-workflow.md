# Figma PSD 分层导入工作流

## 1. 解析目标 URL

从 Figma URL 取出：

- `fileKey`：`figma.com/design/{fileKey}/...`
- `nodeId`：把 `node-id=1263-2` 转成 `1263:2`

## 2. 只读定位目标页面

使用 `use_figma` 递归搜索目标节点，避免 `getNodeById` 跨页面失败。

```js
const targetId = "62:2087";
function findById(node, id) {
  if (node.id === id) return node;
  if ('children' in node) {
    for (const child of node.children) {
      const found = findById(child, id);
      if (found) return found;
    }
  }
  return null;
}
const pages = [];
let found = null;
let foundPage = null;
for (const page of figma.root.children) {
  await figma.setCurrentPageAsync(page);
  pages.push({ id: page.id, name: page.name, childCount: page.children.length });
  const node = findById(page, targetId);
  if (node) {
    found = node;
    foundPage = page;
  }
}
return { found: !!found, page: foundPage && { id: foundPage.id, name: foundPage.name }, node: found && { id: found.id, name: found.name, type: found.type }, pages };
```

## 3. 创建根 Frame 和图层节点

从 `manifest.json` 生成 `layers` 数组。按 manifest 顺序 append，保证后追加的图层位于上方。`mode === "common-component"` 的 layer 必须优先创建通用组件 Instance；普通图片层如果有 `componentSearch.strategy === "auto"`，先做高置信 auto 匹配，命中后创建 Instance，未命中才创建 Rectangle；`mode === "nine-slice"` 的 layer 创建父 Frame，之后再创建 `__slice_*` 子层；`mode === "text"` 的 layer 创建 Figma Text。

### 3.0 通用组件库匹配

通用组件只能在固定通用资源库节点 `62:115` 子树内匹配，禁止使用 `search_design_system`，也不要全文件乱匹配。匹配逻辑必须和创建节点在同一个 `use_figma` 调用里完成，因为跨调用的页面切换不持久。导入开始时先递归收集一次 Component/ComponentSet 并建立索引，后续所有 `common_` 强制查找和普通层 auto 查找都复用该索引，避免按图层数重复遍历。

```js
const COMMON_LIBRARY_NODE_ID = "62:115";

const AUTO_COMPONENT_MODE = "auto-component";

// 标准化名称，用于兜底匹配大小写、空格、分隔符、导入定位后缀和常见复制后缀差异。
function normalizeName(name) {
  return String(name || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/__ImportBounds$/i, "")
    .replace(/^\d+[\s_.-]+/, "")
    .replace(/[\s_-]*(?:copy|副本|拷贝)\s*\d*$/i, "")
    .replace(/[\s_-]+\d+$/, "")
    .toLowerCase()
    .replace(/[\s_.\-/]+/g, "");
}

// 拆分名称关键词，用于给按钮、关闭、背景等常见 UI 组件加少量上下文分。
function nameTokens(name) {
  const raw = String(name || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return raw.split(/[\s_.\-/]+/).filter(Boolean);
}

// 用字符 Dice 系数计算轻量名称相似度，避免引入外部依赖。
function diceSimilarity(a, b) {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length) * 0.9;
  }
  if (left.length < 2 || right.length < 2) return left[0] === right[0] ? 0.25 : 0;

  const grams = new Map();
  for (let i = 0; i < left.length - 1; i++) {
    const gram = left.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) || 0) + 1);
  }

  let hits = 0;
  for (let i = 0; i < right.length - 1; i++) {
    const gram = right.slice(i, i + 2);
    const count = grams.get(gram) || 0;
    if (count > 0) {
      hits++;
      grams.set(gram, count - 1);
    }
  }
  return (2 * hits) / (left.length + right.length - 2);
}

// 递归查找指定 ID 的 Figma 节点，避免跨页面 getNodeById 失败。
function findById(node, id) {
  if (node.id === id) return node;
  if ("children" in node) {
    for (const child of node.children) {
      const found = findById(child, id);
      if (found) return found;
    }
  }
  return null;
}

// 在所有页面中定位固定通用资源库节点。
async function findCommonLibraryNode() {
  for (const page of figma.root.children) {
    await figma.setCurrentPageAsync(page);
    const found = findById(page, COMMON_LIBRARY_NODE_ID);
    if (found) return found;
  }
  return null;
}

// 收集资源库子树内可复用的 Component 和 ComponentSet。
function collectReusableComponents(node, output) {
  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    output.push(node);
  }
  if ("children" in node) {
    for (const child of node.children) {
      collectReusableComponents(child, output);
    }
  }
}

// 建立一次性组件索引，避免每个图层重复递归 62:115。
function buildCommonComponentIndex(libraryNode) {
  const components = [];
  if (libraryNode) {
    collectReusableComponents(libraryNode, components);
  }
  const exactNameMap = new Map();
  const normalizedNameMap = new Map();
  for (const component of components) {
    const exactList = exactNameMap.get(component.name) || [];
    exactList.push(component);
    exactNameMap.set(component.name, exactList);

    const normalized = normalizeName(component.name);
    const normalizedList = normalizedNameMap.get(normalized) || [];
    normalizedList.push(component);
    normalizedNameMap.set(normalized, normalizedList);
  }
  return { components, exactNameMap, normalizedNameMap };
}

// 按候选名顺序获取 Map 中的第一个组件。
function findByCandidateMap(map, candidateNames, normalizer) {
  for (const candidate of candidateNames) {
    const key = normalizer ? normalizer(candidate) : candidate;
    const matches = map.get(key);
    if (matches && matches.length > 0) {
      return { node: matches[0], candidate };
    }
  }
  return null;
}

// 尺寸相似度用于过滤误命中，完全一致为 1，差异越大越接近 0。
function sizeSimilarity(layer, component) {
  if (!layer || !component || !component.width || !component.height || !layer.width || !layer.height) return 0;
  const layerRatio = layer.width / layer.height;
  const componentRatio = component.width / component.height;
  const ratioDiff = Math.abs(Math.log(layerRatio / componentRatio));
  const areaDiff = Math.abs(Math.log((layer.width * layer.height) / (component.width * component.height)));
  return Math.max(0, 1 - ratioDiff * 1.4 - areaDiff * 0.35);
}

// 常见 UI 关键词只作为小权重加分，不能单独决定替换。
function keywordSimilarity(layerName, componentName) {
  const groups = [
    ["btn", "button", "按钮"],
    ["close", "关闭", "guanbi"],
    ["back", "返回", "fanhui"],
    ["panel", "popup", "bg", "背景", "底板"],
    ["icon", "图标"]
  ];
  const left = nameTokens(layerName).join(" ");
  const right = nameTokens(componentName).join(" ");
  let hits = 0;
  for (const group of groups) {
    const leftHit = group.some(word => left.includes(word));
    const rightHit = group.some(word => right.includes(word));
    if (leftHit && rightHit) hits++;
  }
  return Math.min(1, hits / 2);
}

// 为单个组件计算 auto 模糊分数。
function scoreComponent(layer, component, search) {
  const candidates = search.candidateNames && search.candidateNames.length > 0
    ? search.candidateNames
    : [search.query || layer.name];
  const nameScore = Math.max(...candidates.map(candidate => diceSimilarity(candidate, component.name)));
  const sizeScore = sizeSimilarity(layer, component);
  const keywordScore = keywordSimilarity(layer.name, component.name);
  return nameScore * 0.45 + sizeScore * 0.40 + keywordScore * 0.15;
}

// 先精确/标准化匹配，再对 required/auto 搜索统一执行高置信模糊匹配。
function findCommonComponent(componentIndex, layer, search) {
  if (!componentIndex || componentIndex.components.length === 0 || !search) {
    return { node: null, match: "missing-library", candidates: [] };
  }

  const candidateNames = search.candidateNames || [];
  const exact = findByCandidateMap(componentIndex.exactNameMap, candidateNames, null);
  if (exact) return { node: exact.node, match: "exact", candidate: exact.candidate, score: 1, candidates: [] };

  const normalized = findByCandidateMap(componentIndex.normalizedNameMap, candidateNames, normalizeName);
  if (normalized) {
    return { node: normalized.node, match: "normalized", candidate: normalized.candidate, score: 0.98, candidates: [] };
  }

  const scored = componentIndex.components
    .map(node => ({ node, score: scoreComponent(layer, node, search) }))
    .filter(item => item.score >= ((search.threshold && search.threshold.suggest) || 0.80))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];
  const threshold = (search.threshold && search.threshold.autoReplace) || 0.92;
  const minGap = (search.threshold && search.threshold.minGap) || 0.08;
  if (best && best.score >= threshold && (!second || best.score - second.score >= minGap)) {
    return {
      node: best.node,
      match: "fuzzy",
      candidate: search.query || layer.name,
      score: best.score,
      candidates: scored.slice(0, 3)
    };
  }

  return { node: null, match: "candidate-only", candidates: scored.slice(0, 3) };
}

// 从 Component 或 ComponentSet 创建 Instance。
function createInstanceFromReusable(node) {
  if (!node) return null;
  if (node.type === "COMPONENT") return node.createInstance();
  if (node.type === "COMPONENT_SET") {
    const variant = node.defaultVariant || node.children.find(child => child.type === "COMPONENT");
    return variant ? variant.createInstance() : null;
  }
  return null;
}

// 检查九宫子层 Constraints，避免 Instance resize 后内容错位。
function collectSliceConstraintWarnings(node, output) {
  const expected = {
    "__slice_left": { horizontal: "MIN", vertical: "STRETCH" },
    "__slice_center": { horizontal: "STRETCH", vertical: "STRETCH" },
    "__slice_right": { horizontal: "MAX", vertical: "STRETCH" },
    "__slice_top": { horizontal: "STRETCH", vertical: "MIN" },
    "__slice_bottom": { horizontal: "STRETCH", vertical: "MAX" },
    "__slice_top_left": { horizontal: "MIN", vertical: "MIN" },
    "__slice_top_right": { horizontal: "MAX", vertical: "MIN" },
    "__slice_bottom_left": { horizontal: "MIN", vertical: "MAX" },
    "__slice_bottom_right": { horizontal: "MAX", vertical: "MAX" }
  };
  if (expected[node.name] && node.constraints) {
    const want = expected[node.name];
    if (node.constraints.horizontal !== want.horizontal || node.constraints.vertical !== want.vertical) {
      output.push(`${node.name} constraints ${node.constraints.horizontal}/${node.constraints.vertical}`);
    }
  }
  if ("children" in node) {
    for (const child of node.children) {
      collectSliceConstraintWarnings(child, output);
    }
  }
}
```

创建 `common-component` 时：

```js
const importWarnings = [];
const commonLibraryNode = await findCommonLibraryNode();
const commonComponentIndex = buildCommonComponentIndex(commonLibraryNode);

// ===== 视觉匹配 Fallback =====
// 当 common_ 强制层名称匹配失败时，使用 pHash 视觉对比。
// 流程：
// 1. 导入前对 62:115 子树内所有组件截图（get_screenshot），下载到临时目录
// 2. 用 phash_compare.py hash <截图目录> --out <library_phash.json> 计算库 pHash
// 3. 名称匹配失败的 common_ 层，用 phash_compare.py compare <layer.png> --library <library_phash.json>
// 4. distance ≤ 10 → 高置信命中，用对应组件 ID 创建 Instance
// 5. 10 < distance ≤ 18 → 中置信候选 warning
// 6. distance > 18 → 不匹配，降级图片
//
// 截图命名规则：<componentId>_<componentName>.png（如 "62_120_KaToneGreenBtn_3.png"）
// 对比时通过文件名反查组件 ID，再用 getNodeByIdAsync 获取组件创建 Instance。
// =====

// 创建通用组件或 auto 组件 Instance；失败时返回 false 让调用方降级为图片层。
function createComponentSearchInstance(layer, parentFrame, createdNodeIds, layerNodes, expectedStrategy) {
  const search = layer.componentSearch || layer.common || {};
  if (expectedStrategy && search.strategy !== expectedStrategy) {
    return false;
  }

  const match = findCommonComponent(commonComponentIndex, layer, search);
  if (!match.node) {
    if (search.strategy === "required") {
      importWarnings.push(`${layer.index}:${layer.name}: common component not found, fallback to image`);
    } else if (match.candidates && match.candidates.length > 0) {
      const names = match.candidates.map(item => `${item.node.name}:${item.score.toFixed(2)}`).join(", ");
      importWarnings.push(`${layer.index}:${layer.name}: auto component candidate only, keep image; candidates=${names}`);
    }
    return false;
  }

  const instance = createInstanceFromReusable(match.node);
  if (!instance) {
    importWarnings.push(`${layer.index}:${layer.name}: matched node cannot create instance, fallback to image`);
    return false;
  }

  instance.name = `${String(layer.index).padStart(2, "0")}_${layer.name}`;
  parentFrame.appendChild(instance);
  instance.x = layer.x;
  instance.y = layer.y;
  instance.visible = layer.visible;
  instance.opacity = layer.opacity / 255;

  const constraintWarnings = [];
  collectSliceConstraintWarnings(instance, constraintWarnings);
  const needsResize = Math.abs(instance.width - layer.width) > 0.01 || Math.abs(instance.height - layer.height) > 0.01;
  if (needsResize && constraintWarnings.length > 0) {
    importWarnings.push(`${layer.index}:${layer.name}: skip resize until constraints are fixed: ${constraintWarnings.join("; ")}`);
  }
  if (needsResize && constraintWarnings.length === 0) {
    instance.resize(layer.width, layer.height);
  }

  createdNodeIds.push(instance.id);
  layerNodes.push({
    index: layer.index,
    id: instance.id,
    name: instance.name,
    mode: search.strategy === "auto" ? AUTO_COMPONENT_MODE : "common-component",
    sourceComponentId: match.node.id,
    sourceComponentName: match.node.name,
    match: match.match,
    score: match.score
  });
  return true;
}
```

```js
const page = figma.root.children.find(p => p.id === "62:2087");
await figma.setCurrentPageAsync(page);

let maxX = 0;
let minY = 0;
for (const child of page.children) {
  if ('x' in child && 'width' in child) maxX = Math.max(maxX, child.x + child.width);
  if ('y' in child) minY = Math.min(minY, child.y);
}

const frame = figma.createFrame();
frame.name = "source.psd__layers";
frame.resize(1080, 1920);
frame.fills = [];
frame.clipsContent = false;
page.appendChild(frame);
frame.x = maxX + 240;
frame.y = minY;

// canvas 尺寸用于 constraints 推断
const canvasWidth = 1080;
const canvasHeight = 1920;

// 根据图层在 canvas 中的位置推断 Figma constraints
function inferConstraints(layer) {
  const centerX = layer.x + layer.width / 2;
  const centerY = layer.y + layer.height / 2;
  const leftMargin = layer.x;
  const rightMargin = canvasWidth - (layer.x + layer.width);
  const topMargin = layer.y;
  const bottomMargin = canvasHeight - (layer.y + layer.height);

  let horizontal = "MIN";
  if (layer.width > canvasWidth * 0.8) {
    horizontal = "STRETCH";
  } else if (centerX >= canvasWidth * 0.25 && centerX <= canvasWidth * 0.75) {
    horizontal = "CENTER";
  } else if (rightMargin < canvasWidth * 0.2 && leftMargin > canvasWidth * 0.2) {
    horizontal = "MAX";
  }

  let vertical = "MIN";
  if (layer.height > canvasHeight * 0.8) {
    vertical = "STRETCH";
  } else if (bottomMargin < canvasHeight * 0.2 && topMargin > canvasHeight * 0.2) {
    vertical = "MAX";
  } else if (centerY >= canvasHeight * 0.25 && centerY <= canvasHeight * 0.75) {
    vertical = "CENTER";
  }

  return { horizontal, vertical };
}

// 根据文字在 canvas 中的位置推断 textAlignHorizontal
function inferTextAlignment(layer, psdAlignment) {
  const centerX = layer.x + layer.width / 2;
  const leftMargin = layer.x;
  const rightMargin = canvasWidth - (layer.x + layer.width);

  if (centerX >= canvasWidth * 0.4 && centerX <= canvasWidth * 0.6) {
    return "CENTER";
  }
  if (leftMargin < rightMargin * 0.5) {
    return "LEFT";
  }
  if (rightMargin < leftMargin * 0.5) {
    return "RIGHT";
  }
  return psdAlignment || "LEFT";
}

const createdNodeIds = [frame.id];
const layerNodes = [];
for (const layer of layers) {
  if (layer.mode === "common-component") {
    const created = createComponentSearchInstance(layer, frame, createdNodeIds, layerNodes, "required");
    if (created) {
      continue;
    }
  }

  if (layer.mode !== "nine-slice" && layer.mode !== "text" && layer.componentSearch && layer.componentSearch.strategy === "auto") {
    const created = createComponentSearchInstance(layer, frame, createdNodeIds, layerNodes, "auto");
    if (created) {
      continue;
    }
  }

  if (layer.mode === "nine-slice") {
    if (layer.nineSlice && layer.nineSlice.inferredBorder) {
      const border = JSON.stringify(layer.nineSlice.border || {});
      const fields = (layer.nineSlice.inferredFields || []).join(",");
      importWarnings.push(
        `${layer.index}:${layer.name}: nine-slice border inferred by ${layer.nineSlice.inferMethod}; ` +
        `confidence=${layer.nineSlice.confidence}; fields=${fields}; border=${border}`
      );
    }
    const nineFrame = figma.createFrame();
    nineFrame.name = `${String(layer.index).padStart(2, "0")}_${layer.name}`;
    nineFrame.resize(layer.width, layer.height);
    nineFrame.fills = [];
    nineFrame.visible = layer.visible;
    nineFrame.opacity = layer.opacity / 255;
    frame.appendChild(nineFrame);
    nineFrame.x = layer.x;
    nineFrame.y = layer.y;
    createdNodeIds.push(nineFrame.id);
    layerNodes.push({
      index: layer.index,
      id: nineFrame.id,
      name: nineFrame.name,
      mode: "nine-slice",
      inferredBorder: !!(layer.nineSlice && layer.nineSlice.inferredBorder)
    });
    continue;
  }

  if (layer.mode === "text") {
    const created = await createTextLayer(layer, frame, createdNodeIds, layerNodes, importWarnings);
    if (created) {
      continue;
    }
  }

  const rect = figma.createRectangle();
  rect.name = `${String(layer.index).padStart(2, "0")}_${layer.name}`;
  rect.resize(layer.width, layer.height);
  rect.fills = [];
  rect.visible = layer.visible;
  rect.opacity = layer.opacity / 255;
  frame.appendChild(rect);
  rect.x = layer.x;
  rect.y = layer.y;
  rect.constraints = inferConstraints(layer);
  createdNodeIds.push(rect.id);
  layerNodes.push({ index: layer.index, id: rect.id, name: rect.name });
}
figma.viewport.scrollAndZoomIntoView([frame]);
return { createdNodeIds, rootFrameId: frame.id, layerNodes, importWarnings };
```

### 3.1 九宫形状适配性判断（强制）

创建九宫结构前，必须根据图层实际尺寸判断适合哪种切片方式，禁止对所有 `jiugong_` 前缀图层无条件做 9-slice：

```text
jiugong_ 前缀图层
  → 宽高都 < 100px 且宽高比在 0.5~2.0 之间？ → 降级为普通图片（不做九宫）
  → 宽高比 > 3:1，或高度 < 80px 且宽度 > 高度×3？ → 横向 3-slice（left/center/right，纵向不切）
  → 宽高比 < 1:3，或宽度 < 80px 且高度 > 宽度×3？ → 纵向 3-slice（top/center/bottom，横向不切）
  → 其他（宽高都 > 100px，比例在 0.3~3.0 之间） → 标准 9-slice
```

各类型的 Figma 结构：

- **普通图片**：单个 Rectangle + FILL image，无 `__slice_*` 子节点。
- **横向 3-slice**：父 Frame + 3 个子节点 `__slice_left`、`__slice_center`、`__slice_right`，每个子节点高度 = 图层完整高度，CROP imageTransform 纵向为 `[0, 1, 0]`。
- **纵向 3-slice**：父 Frame + 3 个子节点 `__slice_top`、`__slice_center`、`__slice_bottom`，每个子节点宽度 = 图层完整宽度，CROP imageTransform 横向为 `[1, 0, 0]`。
- **标准 9-slice**：父 Frame + 9 个子节点（下方逻辑）。

### 3.2 创建九宫 `__slice_*` 子层

九宫 layer 的 manifest 形态：

```json
{
  "mode": "nine-slice",
  "path": ".temp/psd-layer-to-figma/00_jiugong_l88_b88_r88_t87_panel.png",
  "nineSlice": {
    "border": {"left": 88, "bottom": 88, "right": 88, "top": 87},
    "declaredBorder": {"left": 88, "bottom": 88, "right": 88, "top": 87},
    "inferredBorder": false,
    "inferMethod": "explicit-name-values",
    "confidence": "explicit",
    "inferredFields": [],
    "originalPixelSize": "185x181",
    "sourceImageFillIndex": 0,
    "slices": [
      {"name": "__slice_top_left", "target": [0, 0, 88, 87], "source": [0, 0, 88, 87]}
    ]
  }
}
```

如果 PSD 图层名缺少九宫 border，脚本会自动推测并写入 `nineSlice.inferredBorder=true`。导入时不要因此停止，也不要把九宫标记层降级成普通图片；必须继续创建 `__slice_*`，同时把推测来源、推测 border、`confidence` 和 `nineSlice.warnings` 写入 `importWarnings`，最终交付时提醒人工复核。只有 `nineSlice.slices` 为空时才停止该图层导入并输出错误。

为每个九宫父 Frame 创建 `__slice_*` 子层：

```js
function constraintsForSlice(name) {
  const map = {
    "__slice_left": { horizontal: "MIN", vertical: "STRETCH" },
    "__slice_center": { horizontal: "STRETCH", vertical: "STRETCH" },
    "__slice_right": { horizontal: "MAX", vertical: "STRETCH" },
    "__slice_top": { horizontal: "STRETCH", vertical: "MIN" },
    "__slice_bottom": { horizontal: "STRETCH", vertical: "MAX" },
    "__slice_top_left": { horizontal: "MIN", vertical: "MIN" },
    "__slice_top_right": { horizontal: "MAX", vertical: "MIN" },
    "__slice_bottom_left": { horizontal: "MIN", vertical: "MAX" },
    "__slice_bottom_right": { horizontal: "MAX", vertical: "MAX" }
  };
  return map[name] || { horizontal: "MIN", vertical: "MIN" };
}

for (const slice of layer.nineSlice.slices) {
  const rect = figma.createRectangle();
  rect.name = slice.name;
  rect.resize(slice.target[2], slice.target[3]);
  rect.fills = [];
  nineFrame.appendChild(rect);
  rect.x = slice.target[0];
  rect.y = slice.target[1];
  rect.constraints = constraintsForSlice(slice.name);
  rect.setSharedPluginData("prefab_to_figma", "nodeRole", "slice");
  rect.setSharedPluginData("prefab_to_figma", "sourceRect", slice.source.join(","));
  rect.setSharedPluginData("prefab_to_figma", "targetRect", slice.target.join(","));
}
```

### 3.2 创建 PSD 文字层 Text

文字层使用 manifest 的 `text` 元数据创建 Figma Text。PSD 中隐藏或禁用的文字层效果不得出现在 manifest 的 `text.effects` 中；原 PSD 文字 PNG 只作为隐藏对照层保留，不参与最终视觉。

```js
const PSD_TEXT_NAMESPACE = "psd_layer_to_figma";

async function chooseTextFont(textInfo) {
  const fonts = await figma.listAvailableFontsAsync();
  const available = new Set(fonts.map(font => `${font.fontName.family}\u0000${font.fontName.style}`));
  const preferred = [];
  if (textInfo.fontFamily) {
    preferred.push({ family: textInfo.fontFamily, style: "Regular" });
  }
  for (const candidate of textInfo.figma.fontFallbackCandidates || []) {
    preferred.push(candidate);
  }
  for (const fontName of preferred) {
    if (available.has(`${fontName.family}\u0000${fontName.style}`)) {
      await figma.loadFontAsync(fontName);
      return fontName;
    }
  }
  return null;
}

function textLineHeight(textInfo) {
  if (textInfo.lineHeightMode === "PIXELS" && textInfo.leading > 0.01) {
    return { unit: "PIXELS", value: textInfo.leading };
  }
  return { unit: "AUTO" };
}

function solidPaint(color, opacity = 1) {
  return { type: "SOLID", color, opacity };
}

function dropShadowFromPsd(shadow) {
  if (!shadow || !shadow.enabled || !shadow.color) return [];
  const angle = (shadow.angle || 0) * Math.PI / 180;
  const distance = shadow.distance || 0;
  return [{
    type: "DROP_SHADOW",
    visible: true,
    blendMode: "NORMAL",
    color: {
      r: shadow.color.r,
      g: shadow.color.g,
      b: shadow.color.b,
      a: shadow.opacity == null ? 1 : shadow.opacity
    },
    offset: {
      x: Math.cos(angle) * distance,
      y: Math.sin(angle) * distance
    },
    radius: shadow.blur || 0,
    spread: shadow.spread || 0
  }];
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// 按原 PSD 图层 PNG bounds 的宽度迭代拟合字号。
// 单行文字以宽度为唯一约束，高度差异由字体替换导致可接受；
// 多行文字固定宽度后按高度拟合。
function fitTextNodeToLayerBounds(node, layer, textInfo, importWarnings) {
  const hasMultiline = (textInfo.characters || "").includes("\n");
  const targetWidth = Math.max(layer.width || 1, 1);
  const targetHeight = Math.max(layer.height || 1, 1);
  const baseLeading = textInfo.leading || 0;
  let totalScale = 1;

  node.textAutoResize = "WIDTH_AND_HEIGHT";

  for (let iteration = 0; iteration < 3; iteration++) {
    if (hasMultiline) {
      node.textAutoResize = "HEIGHT";
      node.resize(Math.max(layer.width || 1, 1), Math.max(node.height || 1, 1));
    }

    const measuredWidth = Math.max(node.width || 1, 1);
    const measuredHeight = Math.max(node.height || 1, 1);
    // 单行：以宽度为唯一约束；多行：以高度为约束
    const rawScale = hasMultiline ? (targetHeight / measuredHeight) : (targetWidth / measuredWidth);
    const stepScale = clampNumber(rawScale, 0.25, 4);
    if (!Number.isFinite(stepScale) || Math.abs(stepScale - 1) < 0.03) {
      break;
    }

    node.fontSize = Math.max(1, node.fontSize * stepScale);
    totalScale *= stepScale;
    if (textInfo.lineHeightMode === "PIXELS" && baseLeading > 0.01) {
      node.lineHeight = { unit: "PIXELS", value: Math.max(1, baseLeading * totalScale) };
    }
  }

  if (hasMultiline) {
    node.textAutoResize = "HEIGHT";
    node.resize(Math.max(layer.width || 1, 1), Math.max(node.height || 1, 1));
  } else {
    node.textAutoResize = "WIDTH_AND_HEIGHT";
  }

  // 居中对齐到 PSD bounds
  node.x = layer.x + (layer.width - node.width) / 2;
  node.y = layer.y + (layer.height - node.height) / 2;
  node.setSharedPluginData(PSD_TEXT_NAMESPACE, "fontFallbackScale", totalScale.toFixed(4));
  node.setSharedPluginData(PSD_TEXT_NAMESPACE, "fitBounds", [layer.width, layer.height, node.width, node.height].join(","));

  if (totalScale < 0.5 || totalScale > 2) {
    importWarnings.push(
      `${layer.index}:${layer.name}: text font scaled by ${totalScale.toFixed(2)} to fit PNG bounds; verify against __png_reference_hidden`
    );
  }

  return { scale: totalScale, width: node.width, height: node.height };
}

async function createTextLayer(layer, parentFrame, createdNodeIds, layerNodes, importWarnings) {
  const textInfo = layer.text;
  if (!textInfo || !textInfo.characters) {
    importWarnings.push(`${layer.index}:${layer.name}: text metadata missing, fallback to image`);
    return false;
  }

  const fontName = await chooseTextFont(textInfo);
  if (!fontName) {
    importWarnings.push(`${layer.index}:${layer.name}: no available Figma font, fallback to image`);
    return false;
  }

  const node = figma.createText();
  node.name = `${String(layer.index).padStart(2, "0")}_${layer.name}__text`;
  parentFrame.appendChild(node);
  node.fontName = fontName;
  node.fontSize = textInfo.fontSize || layer.height;
  node.characters = textInfo.characters;
  node.textAlignHorizontal = inferTextAlignment(layer, textInfo.textAlignHorizontal || "LEFT");
  node.textAlignVertical = "CENTER";
  node.lineHeight = textLineHeight(textInfo);
  node.fills = textInfo.fillColor
    ? [solidPaint({ r: textInfo.fillColor.r, g: textInfo.fillColor.g, b: textInfo.fillColor.b }, textInfo.fillColor.a || 1)]
    : [];

  const stroke = textInfo.effects && textInfo.effects.stroke;
  if (stroke && stroke.enabled && stroke.color && stroke.size > 0) {
    node.strokes = [solidPaint({ r: stroke.color.r, g: stroke.color.g, b: stroke.color.b }, stroke.opacity == null ? 1 : stroke.opacity)];
    node.strokeWeight = stroke.size;
    node.strokeAlign = stroke.position || "OUTSIDE";
  } else {
    node.strokes = [];
    node.strokeWeight = 0;
  }

  node.effects = dropShadowFromPsd(textInfo.effects && textInfo.effects.dropShadow);
  const fitResult = fitTextNodeToLayerBounds(node, layer, textInfo, importWarnings);

  node.visible = layer.visible;
  node.opacity = layer.opacity / 255;
  node.constraints = inferConstraints(layer);
  node.setSharedPluginData(PSD_TEXT_NAMESPACE, "nodeRole", "text");
  node.setSharedPluginData(PSD_TEXT_NAMESPACE, "sourceBounds", [layer.x, layer.y, layer.width, layer.height].join(","));
  node.setSharedPluginData(PSD_TEXT_NAMESPACE, "fontFallback", `${fontName.family} ${fontName.style}`);
  createdNodeIds.push(node.id);
  layerNodes.push({ index: layer.index, id: node.id, name: node.name, mode: "text", fitScale: fitResult.scale });
  return true;
}
```

## 4. 上传 PNG 并设置 image fill

成功创建 Instance 的 `common-component` / `auto-component` 和成功创建 Figma Text 的 `text` 不需要设置 PNG image fill；只有普通图片层、九宫层、未命中组件后降级的 common 图层、auto 候选不足后保留的图片层、以及文字解析失败后的降级图层需要上传并绑定 PNG。

对每个图层节点调用 `upload_assets`，拿到 `submitUrl` 后 POST PNG。POST 返回示例：

```json
{"success":true,"imageHash":"...","sizeBytes":11488,"contentType":"image/png"}
```

如果节点没有自动出现图片填充，用 `use_figma` 批量设置：

```js
const mappings = [
  { id: "1263:3", hash: "47167b2fbb4dbbf31142ff4eadb304a8a97ca992", mode: "image" }
];
const mutatedNodeIds = [];
const missing = [];
for (const item of mappings) {
  const node = await figma.getNodeByIdAsync(item.id);
  if (!node || !('fills' in node)) {
    missing.push(item.id);
    continue;
  }
  node.fills = [{ type: 'IMAGE', imageHash: item.hash, scaleMode: 'FILL' }];
  mutatedNodeIds.push(node.id);
}
return { mutatedNodeIds, missing, count: mutatedNodeIds.length };
```

### 4.1 九宫 image fill 设置

九宫父 Frame 使用同一张图作为隐藏源图 fill；每个 `__slice_*` 子层使用同一 `imageHash`，`scaleMode` 必须是 `"CROP"`。CROP `imageTransform` 必须基于 source rect，而不是 target rect：

```js
function cropTransform(source, sourceImageWidth, sourceImageHeight) {
  return [
    [source[2] / sourceImageWidth, 0, source[0] / sourceImageWidth],
    [0, source[3] / sourceImageHeight, source[1] / sourceImageHeight]
  ];
}

const sourceFill = { type: "IMAGE", imageHash, scaleMode: "FILL", opacity: 0 };
nineFrame.fills = [sourceFill];
nineFrame.setSharedPluginData("prefab_to_figma", "sourceImageFillIndex", "0");
nineFrame.setSharedPluginData("prefab_to_figma", "imageType", "Sliced");
nineFrame.setSharedPluginData("prefab_to_figma", "spriteBorder", `${border.left},${border.bottom},${border.right},${border.top}`);
nineFrame.setSharedPluginData("prefab_to_figma", "originalPixelSize", `${sourceImageWidth}x${sourceImageHeight}`);

for (const slice of layer.nineSlice.slices) {
  const node = nineFrame.findOne(n => n.name === slice.name);
  node.fills = [{
    type: "IMAGE",
    imageHash,
    scaleMode: "CROP",
    imageTransform: cropTransform(slice.source, sourceImageWidth, sourceImageHeight)
  }];
  node.setSharedPluginData("prefab_to_figma", "sourceImageFillIndex", "0");
}
```

## 5. 验证

```js
const frame = await figma.getNodeByIdAsync("1263:2");
function imageFillCount(node) {
  const fills = 'fills' in node && Array.isArray(node.fills) ? node.fills : [];
  return fills.filter(fill => fill && fill.type === 'IMAGE').length;
}
const children = frame.children.map(node => {
  return {
    id: node.id,
    name: node.name,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    opacity: node.opacity,
    visible: node.visible,
    imageFillCount: imageFillCount(node),
    isInstance: node.type === "INSTANCE",
    childImageFillCount: 'children' in node ? node.children.reduce((sum, child) => sum + imageFillCount(child), 0) : 0
  };
});
return {
  frame: { id: frame.id, name: frame.name, width: frame.width, height: frame.height, childCount: frame.children.length },
  imageFillCount: children.filter(c => c.imageFillCount > 0).length,
  instanceCount: children.filter(c => c.isInstance).length,
  missingImageFills: children.filter(c => !c.isInstance && c.imageFillCount === 0).map(c => c.name),
  children
};
```

通过条件：

- 根 Frame 尺寸等于 PSD canvas。
- 子节点数量等于 manifest 图层数量。
- `missingImageFills` 为空。
- `common-component` 对应节点是 Instance；如果找不到通用组件并降级普通图片，最终说明必须列出 import warning。
- `auto-component` 只允许由 `componentSearch.strategy === "auto"` 的普通图片层高置信命中产生；中低置信候选必须保留图片层并列出 import warning。
- `text` 对应节点是 Text；旧文字 PNG 如果保留，必须隐藏并命名为 `__png_reference_hidden`。
- 关键半透明图层 opacity 与 `opacity / 255` 一致。
- 九宫父节点有隐藏源图 fill，所有 `__slice_*` 子节点都有 CROP image fill。

## 常见坑

- 不要把 PSD 直接当图片上传，Figma MCP 资源上传只支持 PNG/JPG/GIF/WebP。
- 不要只导入合成 PNG；用户要求 layer 时必须单层导出。
- 不要假设 PSD 一定有 group。没有 `sectionType` 时输出平铺图层。
- 不要假设 `upload_assets` 会自动填充目标节点；必须验证 fills。
- 不要用 `search_design_system` 查 `common_` 图层；它找不到文件内本地 Component，必须在 `62:115` 子树内递归找 Component/ComponentSet。
- 不要把含 `jiugong_`、`nine_slice_`、`nine-slice_`、`9slice_` 的图层当普通单图；必须用 `__slice_*` 子层表示。
- 不要把 PSD `TySh` 文字层默认当 PNG；必须先尝试创建 Figma Text，并按 `FillColor`、启用状态为 true 的 `FrFX`、`DrSh` 换算。隐藏/禁用的文字效果不得导入。
- 不要用 target rect 计算九宫 CROP；必须使用 source rect。
- 不要用 `node.rotation` 处理旋转资源；如遇旋转节点参考项目 `Doc/ReportError/2025-05-06_figma_rotation_position_offset.md`。
