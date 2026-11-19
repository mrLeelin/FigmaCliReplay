let mergingImageLayers = false;

function hasMergeableImageContent(node) {
  if (!node.visible || node.opacity === 0) return false;
  return hasImageFill(node) || ("children" in node && node.children.some(hasMergeableImageContent));
}

function collectMergeImageLayers(page, selection) {
  const selectedIds = new Set(selection.map(node => node.id));
  const childOrder = new Map();
  const layers = selection.map(node => {
    const stackPath = [];
    for (let child = node; child.id !== page.id; child = child.parent) {
      if (!child.parent) throw new Error("选区已变化，请重新选择图片图层。");
      if (!child.visible) throw new Error("「" + node.name + "」处于隐藏状态，请先显示图层。");
      if (child !== node && selectedIds.has(child.id)) {
        throw new Error("请只保留父图层或子图层的选择，避免重复合并。");
      }
      const parent = child.parent;
      if (!childOrder.has(parent.id)) {
        const reverse = parent.itemReverseZIndex && (parent.layoutMode === "HORIZONTAL" || parent.layoutMode === "VERTICAL");
        childOrder.set(parent.id, new Map(parent.children.map((item, index) => [item.id, reverse ? -index : index])));
      }
      stackPath.unshift(childOrder.get(parent.id).get(child.id));
    }
    if (!hasMergeableImageContent(node)) throw new Error("「" + node.name + "」需要有可见的图片填充。");
    const bounds = node.absoluteRenderBounds;
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
      || bounds.width <= 0 || bounds.height <= 0) {
      throw new Error("无法读取「" + node.name + "」的渲染范围。");
    }
    return { node, bounds, stackPath, transform: node.absoluteTransform };
  });
  return layers.sort((a, b) => {
    for (let i = 0; i < a.stackPath.length && i < b.stackPath.length; i++) {
      if (a.stackPath[i] !== b.stackPath[i]) return a.stackPath[i] - b.stackPath[i];
    }
    return a.stackPath.length - b.stackPath.length;
  });
}

async function renderMergedImageLayers(layers, bounds, scale, operation) {
  const staging = figma.createFrame();
  const removeStaging = () => {
    if (!staging.removed) staging.remove();
    operation.step("cleanup", "已清理临时渲染图层", { layerCount: layers.length });
  };
  const onClose = () => {
    removeStaging();
    operation.cancel("插件关闭，已取消合并图层");
  };
  figma.on("close", onClose);
  try {
    staging.name = "合并图层（渲染中）";
    staging.fills = [];
    staging.clipsContent = true;
    staging.resize(bounds.width, bounds.height);
    staging.x = bounds.x + bounds.width + 32;
    staging.y = bounds.y;
    for (const layer of layers) {
      const clone = layer.node.clone();
      try {
        staging.appendChild(clone);
        // 将原图的画布变换映射到透明输出区域。
        const transform = layer.transform;
        clone.relativeTransform = [
          [transform[0][0], transform[0][1], transform[0][2] - bounds.x],
          [transform[1][0], transform[1][1], transform[1][2] - bounds.y]
        ];
      } catch (error) {
        clone.remove();
        throw error;
      }
    }
    operation.step("render", "导出合并选区", { layers: layers.length, width: bounds.width, height: bounds.height, scale });
    return await staging.exportAsync({
      format: "PNG", contentsOnly: true, useAbsoluteBounds: true, constraint: { type: "SCALE", value: scale }
    });
  } finally {
    figma.off("close", onClose);
    removeStaging();
  }
}

async function handleMergeImageLayers(message) {
  const page = figma.currentPage;
  const selection = page.selection.slice();
  const operation = pluginLogger.startOperation("figma.merge-image-layers", {
    operationId: message.requestId,
    data: { pageId: page.id, nodeIds: selection.map(node => node.id), selectedCount: selection.length }
  });
  const reply = result => figma.ui.postMessage({ type: "MERGE_IMAGE_LAYERS_RESULT", requestId: message.requestId, result });
  operation.step("validate-selection", "校验选中的图层", { selectedCount: selection.length, busy: mergingImageLayers });
  if (mergingImageLayers) {
    const error = new Error("正在合并图层，请等待当前操作完成。");
    operation.fail(error, "本次合并未开始");
    reply({ error: error.message });
    return;
  }

  mergingImageLayers = true;
  let output;
  let result;
  try {
    if (selection.length < 2) throw new Error("请先选择至少两个图片图层或含图片的组。");
    const layers = collectMergeImageLayers(page, selection);
    const x = Math.floor(Math.min(...layers.map(layer => layer.bounds.x)));
    const y = Math.floor(Math.min(...layers.map(layer => layer.bounds.y)));
    const right = Math.ceil(Math.max(...layers.map(layer => layer.bounds.x + layer.bounds.width)));
    const bottom = Math.ceil(Math.max(...layers.map(layer => layer.bounds.y + layer.bounds.height)));
    const bounds = { x, y, width: right - x, height: bottom - y };
    const scale = Math.min(1, 4096 / Math.max(bounds.width, bounds.height));
    if (Math.min(bounds.width, bounds.height) * scale < 1) {
      throw new Error("合并范围的长宽比过大，请选择范围更集中的图片。");
    }
    const bytes = await renderMergedImageLayers(layers, bounds, scale, operation);
    if (figma.currentPage.id !== page.id) throw new Error("当前页面已切换，请在原页面重新发起合并。");
    const pixels = readFigmaPrefabPngSize(bytes);
    operation.step("create-image", "将 PNG 创建为新图片图层", { bytes: bytes.length, pixels });
    const image = figma.createImage(bytes);
    output = figma.createRectangle();
    output.name = "合并图层";
    output.resize(bounds.width, bounds.height);
    output.x = right + 32;
    output.y = y;
    output.fills = [{ type: "IMAGE", scaleMode: "CROP", imageHash: image.hash,
      imageTransform: [[1, 0, 0], [0, 1, 0]] }];
    const sourceIds = new Set(selection.map(node => node.id));
    if (page.selection.length === selection.length && page.selection.every(node => sourceIds.has(node.id))) {
      page.selection = [output];
    }
    result = { ok: true, count: layers.length, nodeId: output.id, width: pixels.width, height: pixels.height, scale };
    operation.succeed("合并图层完成", result);
  } catch (error) {
    if (output && !output.removed) {
      output.remove();
      operation.step("rollback", "已移除未完成的合并结果", { nodeId: output.id });
    }
    operation.fail(error, "合并图层失败");
    result = { error: error && typeof error.message === "string" ? error.message : String(error) };
  } finally {
    mergingImageLayers = false;
  }
  reply(result);
}
