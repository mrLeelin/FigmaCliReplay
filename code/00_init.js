// Figma MCP Relay build #__BUILD_NUMBER__
figma.showUI(__html__, {
  width: 460,
  height: 620,
  themeColors: true
});
// DIAG: 插件启动标记 (__BUILD_NUMBER__ 由 build.py 替换)
figma.notify("Figma MCP Relay 插件已加载 (build __BUILD_NUMBER__)", { timeout: 1000 });
pluginLogger.info("插件初始化完成", { build: "__BUILD_NUMBER__" });

const McpMetadataNamespace = "psd_layer_to_figma_bridge";
const PrefabToFigmaNamespace = "prefab_to_figma";
const DefaultRootName = "PSD_Import_Root";

const state = {
  importing: false,
  lastResult: null
};

// ─── 实时选区监听 ───
let lastSelectionSnapshot = "";

function getSelectionSnapshot() {
  const selection = figma.currentPage.selection || [];
  return selection.map(n => n.id).join(",");
}

function sendSelectionUpdate() {
  try {
    const snapshot = getSelectionSnapshot();
    if (snapshot === lastSelectionSnapshot) return;
    lastSelectionSnapshot = snapshot;

    const selection = figma.currentPage.selection || [];
    const nodes = selection.map(function (node, index) {
      return {
        index: index + 1,
        id: node.id,
        urlNodeId: String(node.id || "").replace(/:/g, "-"),
        name: node.name || "",
        type: node.type || "",
        parentId: node.parent && node.parent.id ? node.parent.id : "",
        parentType: node.parent && node.parent.type ? node.parent.type : "",
        path: typeof buildNodePathForPrompt === "function" ? buildNodePathForPrompt(node) : "",
        width: Math.round(Number(node.width || 0)),
        height: Math.round(Number(node.height || 0))
      };
    });

    figma.ui.postMessage({
      type: "SELECTION_CHANGED",
      fileKey: figma.fileKey || "",
      docName: figma.root && figma.root.name ? figma.root.name : "",
      pageId: figma.currentPage && figma.currentPage.id ? figma.currentPage.id : "",
      pageUrlNodeId: figma.currentPage && figma.currentPage.id ? String(figma.currentPage.id).replace(/:/g, "-") : "",
      pageName: figma.currentPage && figma.currentPage.name ? figma.currentPage.name : "",
      selectionCount: nodes.length,
      nodes: nodes
    });
  } catch (e) {
    // Figma 沙箱可能延迟加载后续文件，首次触发时 buildNodePathForPrompt 可能未就绪
    pluginLogger.warn("选区更新已跳过", { error: e.message });
  }
}

figma.on("selectionchange", sendSelectionUpdate);
setTimeout(sendSelectionUpdate, 100);

// DIAG: 确认 handler 已注册
pluginLogger.info("figma.ui.onmessage 已注册");

figma.ui.onmessage = async (message) => {
  // DIAG: 记录收到的所有消息
  if (message && message.type) {
    pluginLogger.debug("收到 UI 消息", {
      type: message.type,
      requestId: message.requestId || ""
    }, {
      operationId: message.operationId || message.requestId || undefined,
      operationName: "plugin.message"
    });
  }
  if (!message) return;

  if (message.type === "IMPORT_PSD_JOB") {
    await handleImportPsdJob(message);
    return;
  }

  if (message.type === "COLLECT_COMPONENTS") {
    await handleCollectComponents(message);
    return;
  }

  if (message.type === "FIGMA_TO_PREFAB_EXPORT") {
    await handleFigmaToPrefabExport(message);
    return;
  }

  if (message.type === "FIGMA_HIERARCHY_CLEANUP_ANALYZE") {
