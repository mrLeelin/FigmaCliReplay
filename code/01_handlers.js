await handleFigmaHierarchyCleanupAnalyze(message);
    return;
  }

  if (message.type === "FIGMA_HIERARCHY_REPEAT_CLUSTER_ANALYZE") {
    await handleFigmaHierarchyRepeatClusterAnalyze(message);
    return;
  }

  if (message.type === "FIGMA_HIERARCHY_CLEANUP_APPLY") {
    await handleFigmaHierarchyCleanupApply(message);
    return;
  }

  if (message.type === "FIGMA_HIERARCHY_WRAP_CHAIN") {
    await handleFigmaHierarchyWrapChain(message);
    return;
  }

  if (message.type === "FIGMA_HIERARCHY_BATCH_APPLY") {
    await handleFigmaHierarchyBatchApply(message);
    return;
  }

  if (message.type === "FIGMA_EXPORT_NODE_SCREENSHOT") {
    await handleFigmaExportNodeScreenshot(message);
    return;
  }

  if (message.type === "FIGMA_HIERARCHY_REORDER_CHILDREN") {
    await handleFigmaHierarchyReorderChildren(message);
    return;
  }

  if (message.type === "FIGMA_CREATE_COMPONENT_SET_VARIANTS") {
    await handleFigmaCreateComponentSetVariants(message);
    return;
  }

  if (message.type === "FIGMA_ADD_COMPONENT_SET_VARIANTS") {
    await handleFigmaAddComponentSetVariants(message);
    return;
  }

  if (message.type === "FIGMA_CREATE_COMPONENT_FROM_SELECTION") {
    await handleFigmaCreateComponentFromSelection(message);
    return;
  }

  if (message.type === "FIGMA_REBUILD_COMPONENT_SET_FROM_SIBLINGS") {
    await handleFigmaRebuildComponentSetFromSiblings(message);
    return;
  }

  if (message.type === "FIGMA_CREATE_COMPONENT_SET_FROM_NODE_GROUPS") {
    await handleFigmaCreateComponentSetFromNodeGroups(message);
    return;
  }

  if (message.type === "FIGMA_HIERARCHY_MOVE_NODES") {
    await handleFigmaHierarchyMoveNodes(message);
    return;
  }

  if (message.type === "FIGMA_CLONE_NODE") {
    await handleFigmaCloneNode(message);
    return;
  }

  if (message.type === "DELETE_NODE_BY_ID") {
    await handleDeleteNodeById(message);
    return;
  }

  if (message.type === "PREFAB_TO_FIGMA_WRITE") {
    await handlePrefabToFigmaWrite(message);
    return;
  }

  if (message.type === "PREFAB_TO_FIGMA_DIAG") {
    await handlePrefabToFigmaDiag(message);
    return;
  }

  if (message.type === "CHANGE_TEXT_FONTS") {
    await handleChangeTextFonts(message);
    return;
  }

  if (message.type === "QUERY_SELECTION") {
    await handleQuerySelection(message);
    return;
  }

  if (message.type === "SET_CONTEXT") {
    await handleSetContext(message);
    return;
  }

  if (message.type === "QUERY_PLUGIN_STATUS") {
    figma.ui.postMessage({
      type: "QUERY_PLUGIN_STATUS_RESULT",
      requestId: message.requestId,
      result: {
        status: "completed",
        build: "__BUILD_NUMBER__",
        fileKey: figma.fileKey || "",
        pageName: figma.currentPage && figma.currentPage.name ? figma.currentPage.name : ""
      }
    });
    return;
  }

  if (message.type === "CREATE_GRID_COMPONENT") {
    await handleCreateGridComponent(message);
    return;
  }

  if (message.type === "QUERY_NODE_CHILDREN") {
    await handleQueryNodeChildren(message);
    return;
  }

  if (message.type === "RESIZE_NODE") {
    await handleResizeNode(message);
    return;
  }

  if (message.type === "SUGGEST_NINE_SLICE_FROM_SELECTION") {
    await handleSuggestNineSliceFromSelection(message);
    return;
  }

  if (message.type === "CREATE_NINE_SLICE_FROM_SELECTION") {
    await handleCreateNineSliceFromSelection(message);
    return;
  }

  if (message.type === "FIGMA_HIERARCHY_SET_NODE_POSITIONS") {
    await handleFigmaHierarchySetNodePositions(message);
    return;
  }

  if (message.type === "FIGMA_HIERARCHY_MOVE_NODES") {
    await handleFigmaHierarchyMoveNodes(message);
    return;
  }

  if (message.type === "EXPORT_IMAGES_TO_UNITY") {
    try {
      await handleExportImagesToUnity(message);
    } catch (error) {
      figma.ui.postMessage({
        type: "EXPORT_IMAGES_TO_UNITY_RESULT",
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
      figma.notify("图片导出失败：" + (error instanceof Error ? error.message : String(error)), { error: true });
    }
    return;
  }

  if (message.type === "EXPORT_SELECTED_TEXT_STYLE_TO_UNITY") {
    await handleExportSelectedTextStyleToUnity(message);
    return;
  }

  if (message.type === "EXPORT_HIERARCHY_TO_UNITY") {
    await handleExportHierarchyToUnity(message);
    return;
  }

  if (message.type === "QUERY_AI_PROMPT_SELECTION") {
    await handleQueryAiPromptSelection(message);
    return;
  }

  if (message.type === "QUERY_FIGMA_FILE_KEY") {
    await handleQueryFigmaFileKey(message);
    return;
  }

  if (message.type === "QUERY_FIGMA_PAGES") {
    await handleQueryFigmaPages(message);
    return;
  }
};
async function handleImportPsdJob(message) {
  if (state.importing) {
    figma.ui.postMessage({
      type: "IMPORT_PSD_RESULT",
      requestId: message.requestId,
      result: { status: "busy", errors: ["已有任务正在执行"] }
    });
    return;
  }

  state.importing = true;
  try {
    const mode = String(message.job && message.job.mode || "initial-import");
    const result = mode === "incremental-preview"
      ? await previewPsdIncrementalUpdate(message.job, message.assets || [])
      : mode === "incremental-apply"
        ? await applyPsdIncrementalUpdate(message.job, message.assets || [])
        : await importPsdJob(message.job, message.assets || []);
    state.lastResult = result;
    figma.ui.postMessage({
      type: "IMPORT_PSD_RESULT",
      requestId: message.requestId,
      result
    });
    if (mode === "incremental-preview") {
      figma.notify(result.canApply ? "PSD 增量差异已生成" : "PSD 增量更新存在冲突", { error: !result.canApply });
    } else if (mode === "incremental-apply") {
      figma.notify(result.status === "applied" ? "PSD 增量更新完成" : "PSD 增量更新未执行", { error: result.status !== "applied" });
    } else {
      figma.notify(`PSD 导入完成：${result.createdCount} 个节点`);
    }
  } catch (error) {
    const result = {
      status: "error", createdCount: 0,
      errors: [error instanceof Error ? error.message : String(error)],
      warnings: []
    };
    state.lastResult = result;
    figma.ui.postMessage({
      type: "IMPORT_PSD_RESULT",
      requestId: message.requestId,
      result
    });
    figma.notify(`PSD 导入失败：${result.errors[0]}`, { error: true });
  } finally {
    state.importing = false;
  }
}

async function handleCollectComponents(message) {
  try {
    const result = await collectComponents(message.job || {});
    figma.ui.postMessage({
      type: "COLLECT_COMPONENTS_RESULT",
      requestId: message.requestId,
      result: Object.assign({ status: "completed" }, result)
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "COLLECT_COMPONENTS_RESULT",
      requestId: message.requestId,
      result: {
        status: "error",
        errors: [error instanceof Error ? error.message : String(error)]
      }
    });
  }
}

/** 读取当前选区摘要，用于 UI 生成可复制的 AI 提示词，并提供根节点校验所需的父级信息。 */
async function handleQueryAiPromptSelection(message) {
  // DIAG: 确认函数被调用
  console.log("[FigmaMcpRelay] handleQueryAiPromptSelection 被调用, requestId=" + (message.requestId || "-") + ", time=" + Date.now());
  try {
    console.log("[FigmaMcpRelay] 读取 figma.currentPage.selection... time=" + Date.now());
    const selection = figma.currentPage.selection || [];
    console.log("[FigmaMcpRelay] selection.length=" + selection.length + ", time=" + Date.now());
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
    console.log("[FigmaMcpRelay] nodes.length=" + nodes.length + ", 准备 postMessage 回 UI, time=" + Date.now());
    figma.ui.postMessage({
      type: "QUERY_AI_PROMPT_SELECTION_RESULT",
      requestId: message.requestId,
      result: {
        status: "completed",
        fileKey: figma.fileKey || "",
        docName: figma.root && figma.root.name ? figma.root.name : "",
        pageId: figma.currentPage && figma.currentPage.id ? figma.currentPage.id : "",
        pageUrlNodeId: figma.currentPage && figma.currentPage.id ? String(figma.currentPage.id).replace(/:/g, "-") : "",
        pageName: figma.currentPage && figma.currentPage.name ? figma.currentPage.name : "",
        selectionCount: nodes.length,
        nodes: nodes
      }
    });
    console.log("[FigmaMcpRelay] QUERY_AI_PROMPT_SELECTION_RESULT 已发送, time=" + Date.now());
  } catch (error) {
    console.error("[FigmaMcpRelay] handleQueryAiPromptSelection 异常:", error);
    figma.ui.postMessage({
      type: "QUERY_AI_PROMPT_SELECTION_RESULT",
      requestId: message.requestId,
      result: {
        status: "error",
        errors: [error instanceof Error ? error.message : String(error)]
      }
    });
  }
}

/** 读取当前 Figma 文件 Key，供 UI 自动填充提示词上下文。 */
async function handleQueryFigmaFileKey(message) {
  try {
