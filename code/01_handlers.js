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

  if (message.type === "FIGMA_HIERARCHY_CLEANUP_TRANSACTION") {
    await handleFigmaHierarchyCleanupTransaction(message);
    return;
  }

  if (message.type === "QUERY_CLEANUP_RECOVERY_BACKUPS") {
    await handleQueryCleanupRecoveryBackups(message);
    return;
  }

  if (message.type === "RESTORE_CLEANUP_RECOVERY_BACKUP") {
    await handleRestoreCleanupRecoveryBackup(message);
    return;
  }

  if (message.type === "DELETE_CLEANUP_RECOVERY_BACKUP") {
    await handleDeleteCleanupRecoveryBackup(message);
    return;
  }

  if (message.type === "GET_CLEANUP_PROVIDER_PREFERENCE") {
    const providerId = await figma.clientStorage.getAsync("cleanup.preferredPlanningProvider");
    figma.ui.postMessage({
      type: "GET_CLEANUP_PROVIDER_PREFERENCE_RESULT",
      requestId: message.requestId,
      providerId: providerId === "codex" || providerId === "claude-code" ? providerId : ""
    });
    return;
  }

  if (message.type === "SET_CLEANUP_PROVIDER_PREFERENCE") {
    const providerId = String(message.providerId || "");
    if (!(providerId === "codex" || providerId === "claude-code")) {
      figma.ui.postMessage({
        type: "SET_CLEANUP_PROVIDER_PREFERENCE_RESULT",
        requestId: message.requestId,
        ok: false,
        error: "unsupported cleanup planning provider"
      });
      return;
    }
    await figma.clientStorage.setAsync("cleanup.preferredPlanningProvider", providerId);
    figma.ui.postMessage({
      type: "SET_CLEANUP_PROVIDER_PREFERENCE_RESULT",
      requestId: message.requestId,
      ok: true,
      providerId: providerId
    });
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

  if (message.type === "RESIZE_PLUGIN_UI") {
    const width = Math.round(Number(message.width));
    const height = Math.round(Number(message.height));
    const minW = 420;
    const minH = 480;
    const maxW = 1600;
    const maxH = 1200;
    if (Number.isFinite(width) && Number.isFinite(height)) {
      figma.ui.resize(
        Math.max(minW, Math.min(maxW, width)),
        Math.max(minH, Math.min(maxH, height))
      );
    }
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

  if (message.type === "QUERY_CLEANUP_SNAPSHOT") {
    await handleQueryCleanupSnapshot(message);
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
    let result;
    if (mode === "incremental-preview") {
      result = await previewPsdIncrementalUpdate(message.job, message.assets || []);
    } else if (mode === "incremental-baseline-adopt") {
      result = await adoptPsdIncrementalBaseline(message.job, message.assets || []);
    } else if (mode === "incremental-apply") {
      result = await applyPsdIncrementalUpdate(message.job, message.assets || []);
    } else {
      result = await importPsdJob(message.job, message.assets || []);
    }
    state.lastResult = result;
    figma.ui.postMessage({
      type: "IMPORT_PSD_RESULT",
      requestId: message.requestId,
      result
    });
    if (mode === "incremental-preview") {
      figma.notify(result.canApply ? "PSD 增量差异已生成" : "PSD 增量更新存在冲突", { error: !result.canApply });
    } else if (mode === "incremental-baseline-adopt") {
      figma.notify(result.status === "baseline-adopted" ? "PSD 增量基线已采纳" : "PSD 增量基线未采纳", { error: result.status !== "baseline-adopted" });
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

/** 一次性读取当前选中根节点的紧凑层级快照；此命令严格只读。 */
async function handleQueryCleanupSnapshot(message) {
  try {
    const requestedRootId = typeof message.rootNodeId === "string" ? message.rootNodeId.trim() : "";
    const requestedRoot = requestedRootId ? await figma.getNodeByIdAsync(requestedRootId) : null;
    if (requestedRootId && !requestedRoot) {
      throw new Error("AI 整理原始根节点已不存在，请重新开始一次整理会话。");
    }
    const selection = requestedRoot ? [requestedRoot] : (figma.currentPage.selection || []);
    if (selection.length !== 1) {
      throw new Error("AI 层级整理需要且只能选择 1 个根节点。");
    }
    const supportedTypes = ["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE"];
    if (supportedTypes.indexOf(selection[0].type) < 0) {
      throw new Error(`AI 层级整理不支持 ${selection[0].type || "未知"} 类型。`);
    }
    const snapshot = buildCleanupSnapshot(selection[0]);
    figma.ui.postMessage({
      type: "QUERY_CLEANUP_SNAPSHOT_RESULT",
      requestId: message.requestId,
      result: { status: "completed", snapshot }
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "QUERY_CLEANUP_SNAPSHOT_RESULT",
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
  pluginLogger.debug("开始读取 AI 提示词选区", { requestId: message.requestId || "" });
  try {
    pluginLogger.debug("读取 figma.currentPage.selection");
    const selection = figma.currentPage.selection || [];
    pluginLogger.debug("Figma 选区读取完成", { selectionCount: selection.length });
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
    pluginLogger.debug("准备向 UI 返回 AI 提示词选区", { nodeCount: nodes.length });
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
    pluginLogger.info("AI 提示词选区结果已发送", { requestId: message.requestId || "" });
  } catch (error) {
    pluginLogger.error("读取 AI 提示词选区失败", error, { requestId: message.requestId || "" });
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
