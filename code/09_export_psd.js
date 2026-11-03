/**
 * Figma → PSD: collect the entire selected tree, bottom-to-top.
 * Geometry and PNGs cross the Relay boundary in final output pixels.
 * imagesPrestretched=true means the assembler must not scale again.
 * Export disposable clones, never hide or change source nodes.
 */
var PSD_EXPORT_CONCURRENCY = 4;
var PSD_EXPORT_LEAF_LIMIT = 5000;
var psdExportCollectBusy = false;

function psdNeedsOwnFill(node) {
  if (!node) return false;
  return [node.fills, node.strokes, node.effects].some(function (items) {
    return Array.isArray(items) && items.some(function (item) { return item && item.visible !== false; });
  });
}

function psdValidBox(box) {
  return box && [box.x, box.y, box.width, box.height].every(function (value) {
    return typeof value === "number" && isFinite(value);
  }) && box.width >= 0 && box.height >= 0;
}

function psdNodeBox(node) {
  if (psdValidBox(node.absoluteRenderBounds)) return node.absoluteRenderBounds;
  if (psdValidBox(node.absoluteBoundingBox)) return node.absoluteBoundingBox;
  return null;
}

/** These features depend on several nodes being rendered together in Figma. */
function psdNeedsBackdrop(node) {
  if (Array.isArray(node.effects) && node.effects.some(function (effect) {
    return effect.visible !== false && effect.type === "BACKGROUND_BLUR";
  })) return true;
  return !!node.children && node.children.some(psdNeedsBackdrop);
}

function psdCompositeReason(node) {
  if (!node.children || !node.children.length) return "";
  var reasons = [];
  if (node.type === "BOOLEAN_OPERATION") reasons.push("布尔运算");
  if (node.clipsContent) reasons.push("容器裁切");
  if (Array.isArray(node.effects) && node.effects.some(function (effect) { return effect.visible !== false; })) reasons.push("组效果");
  if (typeof node.opacity === "number" && node.opacity < 1) reasons.push("组透明度");
  if (node.children.some(function (child) { return child.isMask; })) reasons.push("蒙版");
  if (node.children.some(psdNeedsBackdrop)) reasons.push("背景模糊");
  if (node.children.some(function (child) { return child.blendMode && child.blendMode !== "NORMAL" && child.blendMode !== "PASS_THROUGH"; })) reasons.push("子层混合");
  if (node.layoutMode && node.layoutMode !== "NONE" && node.itemReverseZIndex) reasons.push("自动布局反向叠放");
  return reasons.join("、");
}

function psdFlatten(root, rootOrigin, scale) {
  var nodes = [];
  var exportQueue = [];
  function walk(node, parentId) {
    if (nodes.length >= PSD_EXPORT_LEAF_LIMIT) throw new Error("选区节点数超过上限 " + PSD_EXPORT_LEAF_LIMIT + "，请拆分导出。");
    var box = psdNodeBox(node);
    var hasChildren = "children" in node && Array.isArray(node.children) && node.children.length > 0;
    var reason = psdCompositeReason(node);
    var imageExpected = !!box && (box.width > 0 || box.height > 0) && (!hasChildren || psdNeedsOwnFill(node) || !!reason);
    if (node.type === "SLICE") imageExpected = false;
    var record = {
      id: node.id, parentId: parentId || "", name: node.name || "", type: node.type || "UNKNOWN",
      visible: node.visible !== false,
      opacity: typeof node.opacity === "number" ? node.opacity : 1,
      blendMode: node.blendMode || "NORMAL",
      imageExpected: imageExpected,
      bbox: box ? {
        x: Math.round((box.x - rootOrigin.x) * scale), y: Math.round((box.y - rootOrigin.y) * scale),
        width: Math.round(box.width * scale), height: Math.round(box.height * scale)
      } : { x: 0, y: 0, width: 0, height: 0 }
    };
    if (reason) { record.composited = true; record.compositedReason = reason; }
    nodes.push(record);
    if (imageExpected) exportQueue.push({ node: node, record: record, hasChildren: hasChildren, origin: rootOrigin });
    if (hasChildren) for (var i = 0; i < node.children.length; i += 1) walk(node.children[i], node.id);
  }
  walk(root, "");
  return { nodes: nodes, exportQueue: exportQueue };
}

function psdPngSize(bytes) {
  if (!bytes || bytes.length < 24 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) throw new Error("Figma 未返回有效 PNG");
  function uint32(offset) { return bytes[offset] * 16777216 + bytes[offset + 1] * 65536 + bytes[offset + 2] * 256 + bytes[offset + 3]; }
  var width = uint32(16), height = uint32(20);
  if (!(width > 0 && height > 0)) throw new Error("Figma 返回了空 PNG");
  return { width: width, height: height };
}

async function psdExportNode(entry, scale) {
  var source = entry.node;
  var clone = null;
  try {
    var transform = source.absoluteTransform;
    clone = source.clone();
    figma.currentPage.appendChild(clone);
    if (transform) clone.relativeTransform = transform.map(function (row) { return row.slice(); });
    if (clone.type === "INSTANCE" && typeof clone.detachInstance === "function") clone = clone.detachInstance();
    clone.visible = true;
    if ("opacity" in clone) clone.opacity = 1;
    if ("blendMode" in clone) clone.blendMode = "NORMAL";
    if ("isMask" in clone) clone.isMask = false;
    if (entry.hasChildren && !entry.record.composited) {
      if ("layoutMode" in clone) clone.layoutMode = "NONE";
      var children = Array.prototype.slice.call(clone.children);
      for (var i = 0; i < children.length; i += 1) children[i].remove();
      if (typeof clone.resize === "function" && source.width > 0 && source.height > 0) clone.resize(source.width, source.height);
    }
    var bounds = psdNodeBox(clone);
    if (!bounds) throw new Error("无法确定图层渲染边界");
    var bytes = await clone.exportAsync({ format: "PNG", contentsOnly: true, colorProfile: "SRGB", constraint: { type: "SCALE", value: scale } });
    var size = psdPngSize(bytes);
    entry.record.bbox = {
      x: Math.round((bounds.x - entry.origin.x) * scale), y: Math.round((bounds.y - entry.origin.y) * scale),
      width: size.width, height: size.height
    };
    return bytesToBase64(bytes);
  } finally {
    if (clone && !clone.removed) clone.remove();
  }
}

async function psdExportAll(exportQueue, scale, onProgress) {
  var results = new Array(exportQueue.length), cursor = 0, done = 0, failure = null;
  async function worker() {
    while (!failure && cursor < exportQueue.length) {
      var index = cursor++, entry = exportQueue[index];
      try { results[index] = await psdExportNode(entry, scale); }
      catch (error) {
        failure = new Error("图层「" + entry.record.name + "」（" + entry.record.id + "）导出失败：" + (error.message || error));
      }
      done += 1;
      if (onProgress) onProgress(done, exportQueue.length);
    }
  }
  var workers = [];
  for (var k = 0; k < Math.min(PSD_EXPORT_CONCURRENCY, exportQueue.length); k += 1) workers.push(worker());
  await Promise.all(workers);
  if (failure) throw failure;
  return results;
}

function psdSelectionRoots(selection) {
  var ids = {};
  selection.forEach(function (node) { ids[node.id] = true; });
  var roots = selection.filter(function (node) {
    var parent = node.parent;
    while (parent) { if (ids[parent.id]) return false; parent = parent.parent; }
    return true;
  });
  function order(node) {
    var indices = [];
    while (node.parent) { indices.unshift(Array.prototype.indexOf.call(node.parent.children || [], node)); node = node.parent; }
    return indices;
  }
  roots.sort(function (a, b) {
    var left = order(a), right = order(b);
    for (var i = 0; i < Math.min(left.length, right.length); i += 1) if (left[i] !== right[i]) return left[i] - right[i];
    return left.length - right.length;
  });
  return roots;
}

async function handleExportPsdCollect(message) {
  var requestId = message.requestId || "";
  if (psdExportCollectBusy) {
    figma.ui.postMessage({ type: "EXPORT_PSD_COLLECT_ERROR", requestId: requestId, error: "已有 PSD 正在采集，请等待完成。" });
    return;
  }
  psdExportCollectBusy = true;
  var skipInvisible = figma.skipInvisibleInstanceChildren;
  try {
    figma.skipInvisibleInstanceChildren = false;
    var scale = message.scale == null ? 1 : Number(message.scale);
    if (!(scale >= 0.1 && scale <= 8)) throw new Error("导出倍率必须在 0.1 到 8 之间。");
    var selection = psdSelectionRoots(Array.prototype.slice.call(figma.currentPage.selection || []));
    if (!selection.length) throw new Error("请先在 Figma 画布中选择节点。");
    var minX = Infinity, minY = Infinity;
    selection.forEach(function (node) {
      var box = psdNodeBox(node);
      if (box) { minX = Math.min(minX, box.x); minY = Math.min(minY, box.y); }
    });
    if (!isFinite(minX) || !isFinite(minY)) throw new Error("选区没有可用的边界框。");
    var origin = { x: minX, y: minY };
    var nodes = [{ id: "__psd_root__", parentId: "", name: "Selection", type: "FRAME", synthetic: true, visible: true, opacity: 1, imageExpected: false, bbox: { x: 0, y: 0, width: 1, height: 1 } }];
    var queue = [];
    selection.forEach(function (root) {
      var flat = psdFlatten(root, origin, scale);
      flat.nodes.forEach(function (record) { if (!record.parentId) record.parentId = "__psd_root__"; nodes.push(record); });
      queue = queue.concat(flat.exportQueue);
    });
    if (nodes.length > PSD_EXPORT_LEAF_LIMIT) throw new Error("选区节点数 " + nodes.length + " 超过上限 " + PSD_EXPORT_LEAF_LIMIT + "，请拆分导出。");
    figma.ui.postMessage({ type: "EXPORT_PSD_PROGRESS", requestId: requestId, phase: "collecting", done: 0, total: queue.length });
    var images = await psdExportAll(queue, scale, function (done, total) {
      if (done % 5 === 0 || done === total) figma.ui.postMessage({ type: "EXPORT_PSD_PROGRESS", requestId: requestId, phase: "exporting", done: done, total: total });
    });
    for (var q = 0; q < queue.length; q += 1) queue[q].record.pngBase64 = images[q];
    var byId = {};
    nodes.forEach(function (record) { byId[record.id] = record; });
    function contributesToCanvas(record) {
      // Hidden source layers keep their original pixel data outside the canvas;
      // a clipped/composited container alone defines its visible output bounds.
      if (record.synthetic) return false;
      if (record.parentId === "__psd_root__") return true;
      if (!record.visible) return false;
      var parent = byId[record.parentId];
      while (parent && !parent.synthetic) {
        if (parent.composited || !parent.visible) return false;
        parent = byId[parent.parentId];
      }
      return true;
    }
    var left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    nodes.forEach(function (record) {
      if (!contributesToCanvas(record)) return;
      var box = record.bbox;
      left = Math.min(left, box.x); top = Math.min(top, box.y);
      right = Math.max(right, box.x + box.width); bottom = Math.max(bottom, box.y + box.height);
    });
    if (!isFinite(left) || !isFinite(top)) throw new Error("选区没有可导出的画布边界。");
    nodes.forEach(function (record) { if (!record.synthetic) { record.bbox.x -= left; record.bbox.y -= top; } });
    var size = { width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
    nodes[0].bbox = { x: 0, y: 0, width: size.width, height: size.height };
    figma.ui.postMessage({ type: "EXPORT_PSD_COLLECT_RESULT", requestId: requestId, result: {
      schemaVersion: 2, nodes: nodes, size: size, scale: scale, imagesPrestretched: true,
      baseName: selection.length === 1 ? (selection[0].name || "export") : "selection",
      imageCount: images.length, nodeCount: nodes.length - 1
    } });
  } catch (error) {
    figma.ui.postMessage({ type: "EXPORT_PSD_COLLECT_ERROR", requestId: requestId, error: error && error.message ? error.message : String(error) });
  } finally {
    figma.skipInvisibleInstanceChildren = skipInvisible;
    psdExportCollectBusy = false;
  }
}
