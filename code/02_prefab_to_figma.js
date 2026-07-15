const fileKey = figma.fileKey || "";
    const selection = figma.currentPage.selection || [];
    const targetNode = selection.length > 0 ? selection[0] : figma.currentPage;
    const urlNodeId = targetNode && targetNode.id ? String(targetNode.id).replace(/:/g, "-") : "";
    const urlNodeIds = selection.map(function (node) {
      return String(node.id || "").replace(/:/g, "-");
    }).filter(Boolean);
    const targetSummary = selection.slice(0, 3).map(function (node) {
      return (node.name || "未命名节点") + "（" + (node.type || "NODE") + "）";
    }).join("、") + (selection.length > 3 ? " 等" : "");
    const targetType = selection.length > 0 ? "node" : "page";
    figma.ui.postMessage({
      type: "QUERY_FIGMA_FILE_KEY_RESULT",
      requestId: message.requestId,
      result: {
        status: fileKey ? "completed" : "unavailable",
        fileKey: fileKey,
        docName: figma.root && figma.root.name ? figma.root.name : "",
        pageName: figma.currentPage && figma.currentPage.name ? figma.currentPage.name : "",
        urlNodeId: urlNodeId,
        urlNodeIds: urlNodeIds.length > 0 ? urlNodeIds : (urlNodeId ? [urlNodeId] : []),
        targetType: targetType,
        targetName: targetNode && targetNode.name ? targetNode.name : "",
        targetNodeType: targetNode && targetNode.type ? targetNode.type : "",
        targetSummary: targetSummary,
        selectionCount: selection.length,
        errors: fileKey ? [] : ["当前插件环境未开放 figma.fileKey，请使用 Share 或手动粘贴 Figma Key。"]
      }
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "QUERY_FIGMA_FILE_KEY_RESULT",
      requestId: message.requestId,
      result: {
        status: "error",
        fileKey: "",
        errors: [error instanceof Error ? error.message : String(error)]
      }
    });
  }
}

/** 读取当前文件页面列表，供无大模型 Prefab 导入 Tab 选择目标页面。 */
async function handleQueryFigmaPages(message) {
  try {
    try { await figma.loadAllPagesAsync(); } catch (e) { /* 非 dynamic-page 模式可忽略 */ }
    const pages = (figma.root.children || []).map(function (page) {
      return {
        id: page.id,
        urlNodeId: String(page.id || "").replace(/:/g, "-"),
        name: page.name || "",
        current: figma.currentPage && page.id === figma.currentPage.id
      };
    });
    figma.ui.postMessage({
      type: "QUERY_FIGMA_PAGES_RESULT",
      requestId: message.requestId,
      result: {
        status: "completed",
        fileKey: figma.fileKey || "",
        docName: figma.root && figma.root.name ? figma.root.name : "",
        currentPageId: figma.currentPage && figma.currentPage.id ? figma.currentPage.id : "",
        currentPageName: figma.currentPage && figma.currentPage.name ? figma.currentPage.name : "",
        pages: pages
      }
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "QUERY_FIGMA_PAGES_RESULT",
      requestId: message.requestId,
      result: {
        status: "error",
        errors: [error instanceof Error ? error.message : String(error)],
        pages: []
      }
    });
  }
}

/** 构建节点在当前文档中的轻量路径，供提示词定位和人工核对。 */
function buildNodePathForPrompt(node) {
  const parts = [];
  let current = node;
  while (current && current.type !== "DOCUMENT") {
    if (current.name) {
      parts.unshift(current.name);
    }
    current = current.parent;
  }
  return parts.join(" > ");
}

/** 根据当前单选图片节点尺寸推断九宫边框，只返回建议值，不写入画布。 */
async function handleSuggestNineSliceFromSelection(message) {
  try {
    const result = await suggestNineSliceFromCurrentSelection();
    figma.ui.postMessage({
      type: "SUGGEST_NINE_SLICE_FROM_SELECTION_RESULT",
      requestId: message.requestId,
      result
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "SUGGEST_NINE_SLICE_FROM_SELECTION_RESULT",
      requestId: message.requestId,
      result: {
        status: "error",
        errors: [error instanceof Error ? error.message : String(error)]
      }
    });
  }
}

/** 将当前单选图片节点额外生成为九宫、横向三切片或纵向三切片结构，原节点保持不动。 */
async function handleCreateNineSliceFromSelection(message) {
  try {
    const result = await createNineSliceFromCurrentSelection(message.job || {});
    figma.ui.postMessage({
      type: "CREATE_NINE_SLICE_FROM_SELECTION_RESULT",
      requestId: message.requestId,
      result
    });
    figma.notify(`切九宫完成：${result.summary.sliceKind}，${result.summary.sliceCount} 个切片`);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    figma.ui.postMessage({
      type: "CREATE_NINE_SLICE_FROM_SELECTION_RESULT",
      requestId: message.requestId,
      result: {
        status: "error",
        errors: [messageText]
      }
    });
    figma.notify(`切九宫失败：${messageText}`, { error: true });
  }
}

/** 执行 Figma 节点导出，生成 Unity Prefab 导入所需清单。 */
async function handleFigmaToPrefabExport(message) {
  try {
    const result = await exportFigmaToPrefabJob(message.job || {});
    figma.ui.postMessage({
      type: "FIGMA_TO_PREFAB_EXPORT_RESULT",
      requestId: message.requestId,
      result
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "FIGMA_TO_PREFAB_EXPORT_RESULT",
      requestId: message.requestId,
      result: {
        status: "error",
        errors: [error instanceof Error ? error.message : String(error)],
        warnings: []
      }
    });
  }
}

/** 执行 Figma 节点层级整理只读分析，供本地 MCP Relay 客户端生成计划。 */
async function handleFigmaHierarchyCleanupAnalyze(message) {
  try {
    const result = await analyzeFigmaHierarchyCleanupJob(message.job || {});
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_CLEANUP_ANALYZE_RESULT",
      requestId: message.requestId,
      result
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_CLEANUP_ANALYZE_RESULT",
      requestId: message.requestId,
      result: buildHierarchyCleanupErrorResult(error, "analyze")
    });
  }
}

/** 执行 Figma 节点层级整理写入，必须由用户确认后的计划触发。 */
async function handleFigmaHierarchyCleanupApply(message) {
  try {
    const result = await applyFigmaHierarchyCleanupJob(message.job || {});
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_CLEANUP_APPLY_RESULT",
      requestId: message.requestId,
      result
    });
    if (result.status === "completed") {
      figma.notify(`Figma 层级整理完成：${result.summary.createdGroups || 0} 个分组`);
    } else {
      figma.notify(`Figma 层级整理存在阻塞项：${(result.blockingErrors || []).length}`, { error: true });
    }
  } catch (error) {
    const result = buildHierarchyCleanupErrorResult(error, "apply");
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_CLEANUP_APPLY_RESULT",
      requestId: message.requestId,
      result
    });
    figma.notify(`Figma 层级整理失败：${result.errors[0] || "unknown"}`, { error: true });
  }
}

/** Create a nested wrapper chain in one relay round-trip. */
async function handleFigmaHierarchyWrapChain(message) {
  try {
    const result = await wrapFigmaHierarchyChainJob(message.job || {});
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_WRAP_CHAIN_RESULT",
      requestId: message.requestId,
      result
    });
    if (result.status === "completed") {
      figma.notify(`Figma wrapper chain completed: ${(result.summary && result.summary.createdGroups) || 0} groups`);
    } else {
      figma.notify(`Figma wrapper chain blocked: ${(result.blockingErrors || []).length}`, { error: true });
    }
  } catch (error) {
    const result = buildHierarchyCleanupErrorResult(error, "wrap-chain");
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_WRAP_CHAIN_RESULT",
      requestId: message.requestId,
      result
    });
    figma.notify(`Figma wrapper chain failed: ${result.errors[0] || "unknown"}`, { error: true });
  }
}

/** Execute caller-provided hierarchy steps in one relay round-trip. */
async function handleFigmaHierarchyBatchApply(message) {
  try {
    const result = await applyFigmaHierarchyBatchJob(message.job || {});
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_BATCH_APPLY_RESULT",
      requestId: message.requestId,
      result
    });
    if (result.status === "completed") {
      figma.notify(`Figma hierarchy batch completed: ${(result.summary && result.summary.completedSteps) || 0} steps`);
    } else {
      figma.notify(`Figma hierarchy batch blocked: ${(result.blockingErrors || []).length}`, { error: true });
    }
  } catch (error) {
    const result = buildHierarchyCleanupErrorResult(error, "batch-apply");
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_BATCH_APPLY_RESULT",
      requestId: message.requestId,
      result
    });
    figma.notify(`Figma hierarchy batch failed: ${result.errors[0] || "unknown"}`, { error: true });
  }
}

/** Export only a target node PNG screenshot without running hierarchy analysis. */
async function handleFigmaExportNodeScreenshot(message) {
  try {
    const result = await exportFigmaNodeScreenshotJob(message.job || {});
    figma.ui.postMessage({
      type: "FIGMA_EXPORT_NODE_SCREENSHOT_RESULT",
      requestId: message.requestId,
      result
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "FIGMA_EXPORT_NODE_SCREENSHOT_RESULT",
      requestId: message.requestId,
      result: buildHierarchyCleanupErrorResult(error, "screenshot")
    });
  }
}

/** 执行 Figma 节点直接子节点重排，只改变 sibling 顺序，不修改视觉属性。 */
async function handleFigmaHierarchyReorderChildren(message) {
  try {
    const result = await reorderFigmaHierarchyChildrenJob(message.job || {});
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_REORDER_CHILDREN_RESULT",
      requestId: message.requestId,
      result
    });
    if (result.status === "completed") {
      figma.notify(`Figma 子节点层级重排完成：${result.summary.reorderedChildren || 0} 个节点`);
    } else {
      figma.notify(`Figma 子节点层级重排存在阻塞项：${(result.blockingErrors || []).length}`, { error: true });
    }
  } catch (error) {
    const result = buildHierarchyCleanupErrorResult(error, "reorder");
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_REORDER_CHILDREN_RESULT",
      requestId: message.requestId,
      result
    });
    figma.notify(`Figma 子节点层级重排失败：${result.errors[0] || "unknown"}`, { error: true });
  }
}

/** 创建 ComponentSet 变体，并可把目标容器内原节点替换为对应变体实例。 */
async function handleFigmaCreateComponentSetVariants(message) {
  try {
    const result = await createComponentSetVariantsJob(message.job || {});
    figma.ui.postMessage({
      type: "FIGMA_CREATE_COMPONENT_SET_VARIANTS_RESULT",
      requestId: message.requestId,
      result
    });
    if (result.status === "completed") {
      figma.notify(`ComponentSet 创建完成：${result.summary.variantCount || 0} 个变体`);
    } else {
      figma.notify(`ComponentSet 创建存在阻塞项：${(result.blockingErrors || []).length}`, { error: true });
    }
  } catch (error) {
    const result = buildHierarchyCleanupErrorResult(error, "component-set");
    figma.ui.postMessage({
      type: "FIGMA_CREATE_COMPONENT_SET_VARIANTS_RESULT",
      requestId: message.requestId,
      result
    });
    figma.notify(`ComponentSet 创建失败：${result.errors[0] || "unknown"}`, { error: true });
  }
}

/** 向已有 ComponentSet 追加当前选择节点作为新变体。 */
async function handleFigmaAddComponentSetVariants(message) {
  try {
    const result = await addComponentSetVariantsJob(message.job || {});
    figma.ui.postMessage({
      type: "FIGMA_ADD_COMPONENT_SET_VARIANTS_RESULT",
      requestId: message.requestId,
      result
    });
    if (result.status === "completed") {
      figma.notify(`ComponentSet 追加完成：新增 ${result.summary.addedVariantCount || 0} 个变体`);
    } else {
      figma.notify(`ComponentSet 追加存在阻塞项：${(result.blockingErrors || []).length}`, { error: true });
    }
  } catch (error) {
    const result = buildHierarchyCleanupErrorResult(error, "component-set-add-variants");
    figma.ui.postMessage({
      type: "FIGMA_ADD_COMPONENT_SET_VARIANTS_RESULT",
      requestId: message.requestId,
      result
    });
    figma.notify(`ComponentSet 追加失败：${result.errors[0] || "unknown"}`, { error: true });
  }
}

/** 基于当前选择克隆生成一个普通 Component，原节点保持不动。 */
async function handleFigmaCreateComponentFromSelection(message) {
  try {
    const result = await createComponentFromSelectionJob(message.job || {});
    figma.ui.postMessage({
      type: "FIGMA_CREATE_COMPONENT_FROM_SELECTION_RESULT",
      requestId: message.requestId,
      result
    });
    if (result.status === "completed") {
      figma.notify(`组件创建完成：${result.summary.componentName || result.rootName || ""}`);
    } else {
      figma.notify(`组件创建存在阻塞项：${(result.blockingErrors || []).length}`, { error: true });
    }
  } catch (error) {
    const result = buildHierarchyCleanupErrorResult(error, "component-from-selection");
    figma.ui.postMessage({
      type: "FIGMA_CREATE_COMPONENT_FROM_SELECTION_RESULT",
      requestId: message.requestId,
      result
    });
    figma.notify(`组件创建失败：${result.errors[0] || "unknown"}`, { error: true });
  }
}

/** 基于当前选择的同级节点重建 ComponentSet，并用新变体实例替换原同级节点。 */
async function handleFigmaRebuildComponentSetFromSiblings(message) {
  try {
    const result = await rebuildComponentSetFromSiblingsJob(message.job || {});
    figma.ui.postMessage({
      type: "FIGMA_REBUILD_COMPONENT_SET_FROM_SIBLINGS_RESULT",
      requestId: message.requestId,
      result
    });
    if (result.status === "completed") {
      figma.notify(`同级 ComponentSet 重建完成：${result.summary.variantCount || 0} 个变体`);
    } else {
      figma.notify(`同级 ComponentSet 重建存在阻塞项：${(result.blockingErrors || []).length}`, { error: true });
    }
  } catch (error) {
    const result = buildHierarchyCleanupErrorResult(error, "rebuild-component-set-from-siblings");
    figma.ui.postMessage({
      type: "FIGMA_REBUILD_COMPONENT_SET_FROM_SIBLINGS_RESULT",
      requestId: message.requestId,
      result
    });
    figma.notify(`同级 ComponentSet 重建失败：${result.errors[0] || "unknown"}`, { error: true });
  }
}

/** 基于跨父级节点组创建 ComponentSet，并在目标容器中替换为变体实例。 */
async function handleFigmaCreateComponentSetFromNodeGroups(message) {
  try {
    const result = await createComponentSetFromNodeGroupsJob(message.job || {});
    figma.ui.postMessage({
      type: "FIGMA_CREATE_COMPONENT_SET_FROM_NODE_GROUPS_RESULT",
      requestId: message.requestId,
      result
    });
    if (result.status === "completed") {
      figma.notify(`节点组 ComponentSet 创建完成：${result.summary.variantCount || 0} 个变体`);
    } else {
      figma.notify(`节点组 ComponentSet 创建存在阻塞项：${(result.blockingErrors || []).length}`, { error: true });
    }
  } catch (error) {
    const result = buildHierarchyCleanupErrorResult(error, "component-set-from-node-groups");
    figma.ui.postMessage({
      type: "FIGMA_CREATE_COMPONENT_SET_FROM_NODE_GROUPS_RESULT",
      requestId: message.requestId,
      result
    });
    figma.notify(`节点组 ComponentSet 创建失败：${result.errors[0] || "unknown"}`, { error: true });
  }
}

/** 调整指定节点的宽高尺寸，通过 MCP Relay 提供给外部客户端调用。 */
async function handleResizeNode(message) {
  try {
    const job = message.job || {};
    const nodeId = String(job.nodeId || "");
    const width = typeof job.width === "number" ? job.width : null;
    const height = typeof job.height === "number" ? job.height : null;

    if (!nodeId) {
      figma.ui.postMessage({
        type: "RESIZE_NODE_RESULT",
        requestId: message.requestId,
        result: { status: "error", errors: ["missing nodeId"] }
      });
      return;
    }
    if (width === null || height === null) {
      figma.ui.postMessage({
        type: "RESIZE_NODE_RESULT",
        requestId: message.requestId,
        result: { status: "error", errors: ["missing width or height"] }
      });
      return;
    }
    if (width <= 0 || height <= 0) {
      figma.ui.postMessage({
        type: "RESIZE_NODE_RESULT",
        requestId: message.requestId,
        result: { status: "error", errors: ["width and height must be positive"] }
      });
      return;
    }

    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      figma.ui.postMessage({
        type: "RESIZE_NODE_RESULT",
        requestId: message.requestId,
        result: { status: "error", errors: ["node not found: " + nodeId] }
      });
      return;
    }

    const before = { width: Math.round(node.width), height: Math.round(node.height) };
    safeResizeNode(node, width, height);
    const after = { width: Math.round(node.width), height: Math.round(node.height) };

    figma.ui.postMessage({
      type: "RESIZE_NODE_RESULT",
      requestId: message.requestId,
      result: {
        status: "completed",
        nodeId: nodeId,
        nodeName: node.name,
        nodeType: node.type,
        before: before,
        after: after
      }
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "RESIZE_NODE_RESULT",
      requestId: message.requestId,
      result: {
        status: "error",
        errors: [error instanceof Error ? error.message : String(error)]
      }
    });
  }
}

/** 执行 Unity Prefab 导出包写入 Figma，供 prefab-to-figma HTTP MCP Relay 客户端调用。 */
/** 鍒犻櫎鎸囧畾鑺傜偣 ID锛屼粎鐢ㄤ簬娓呯悊鏄庣‘澶辫触鐨勮嚜鍔ㄥ鍏ヨ妭鐐广€?*/
async function handleDeleteNodeById(message) {
  try {
    const job = message.job || {};
    const nodeId = String(job.nodeId || "");
    if (!nodeId) {
      figma.ui.postMessage({
        type: "DELETE_NODE_BY_ID_RESULT",
        requestId: message.requestId,
        result: { status: "error", errors: ["missing nodeId"] }
      });
      return;
    }
    const node = await figma.getNodeByIdAsync(nodeId).catch(() => null);
    if (!node) {
      figma.ui.postMessage({
        type: "DELETE_NODE_BY_ID_RESULT",
        requestId: message.requestId,
        result: { status: "completed", deleted: false, nodeId, reason: "node_not_found" }
      });
      return;
    }
    if (node.type === "PAGE" || node.type === "DOCUMENT") {
      figma.ui.postMessage({
        type: "DELETE_NODE_BY_ID_RESULT",
        requestId: message.requestId,
        result: { status: "error", errors: ["refuse to delete PAGE or DOCUMENT node"] }
      });
      return;
    }
    const before = { nodeId: node.id, nodeName: node.name, nodeType: node.type };
    node.remove();
    figma.ui.postMessage({
      type: "DELETE_NODE_BY_ID_RESULT",
      requestId: message.requestId,
      result: { status: "completed", deleted: true, before }
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "DELETE_NODE_BY_ID_RESULT",
      requestId: message.requestId,
      result: {
        status: "error",
        errors: [error instanceof Error ? error.message : String(error)]
      }
    });
  }
}

async function handlePrefabToFigmaWrite(message) {
  try {
    const result = await writePrefabToFigmaJob(message.job || {}, message.assets || []);
    figma.ui.postMessage({
      type: "PREFAB_TO_FIGMA_WRITE_RESULT",
      requestId: message.requestId,
      result
    });
    postPrefabWriteResultDirectly(message, result);
    if (result.status === "completed") {
      figma.notify(`Prefab write completed: ${result.createdCount || 0} nodes`);
    } else {
      figma.notify(`Prefab 鍐欏叆瀹屾垚浣嗗瓨鍦ㄩ棶棰橈細${(result.blockingErrors || []).length} 涓樆濉為」`, { error: true });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const result = {
      status: "error",
      allPass: false,
      blockingErrors: [{
        code: "pluginException",
        message: "Figma plugin failed while running prefab-to-figma write.",
        details: [errorMessage]
      }],
      warnings: [],
      summary: {},
      checks: {},
      artifacts: {},
      errors: [errorMessage]
    };
    figma.ui.postMessage({
      type: "PREFAB_TO_FIGMA_WRITE_RESULT",
      requestId: message.requestId,
      result
    });
    postPrefabWriteResultDirectly(message, result);
    figma.notify(`Prefab write failed: ${errorMessage}`, { error: true });
  }
}

/** 分阶段执行 Prefab 写入核心流程，用于定位 Figma 主线程卡点。 */
async function handlePrefabToFigmaDiag(message) {
  const stages = [];
  let lastStage = "start";
  let context = null;
  let topLevelNode = null;
  try {
    const job = message.job || {};
    const prefabPackage = job.package || job.prefabPackage || job.manifest;
    const writePlan = job.writePlan || {};
    if (!prefabPackage || typeof prefabPackage !== "object" || !prefabPackage.root) {
      throw new Error("PREFAB_TO_FIGMA_DIAG missing package.root");
    }
    function mark(stage, data) {
      lastStage = stage;
      stages.push(Object.assign({ stage, timeMs: Date.now() }, data || {}));
    }
    mark("loadAllPages:start");
    await promiseWithTimeout((async function () {
      try { await figma.loadAllPagesAsync(); } catch (e) { /* ignore */ }
    })(), 5000, "loadAllPages timeout");
    mark("loadAllPages:done");

    context = createPrefabWriteContext(job, prefabPackage, writePlan, message.assets || []);
    mark("detectFont:start");
    await promiseWithTimeout(detectPrefabFileFont(context), 10000, "detectPrefabFileFont timeout");
    mark("detectFont:done");

    mark("resolveParent:start");
    const parent = await promiseWithTimeout(resolvePrefabWriteParent(job.target || (writePlan.figma || {})), 10000, "resolvePrefabWriteParent timeout");
    mark("resolveParent:done", { parentType: parent && parent.type, parentName: parent && parent.name });

    mark("createTopLevel:start");
    topLevelNode = await promiseWithTimeout(createPrefabTopLevelNode(parent, context), 30000, "createPrefabTopLevelNode timeout");
    context.currentTopLevelNode = topLevelNode;
    context.importPage = resolvePrefabNodePage(topLevelNode) || figma.currentPage;
    mark("createTopLevel:done", {
      nodeId: topLevelNode && topLevelNode.id,
      nodeName: topLevelNode && topLevelNode.name,
      frameCount: context.stats.frameCount,
      imageCount: context.stats.imageCount,
      sliceCount: context.stats.sliceCount
    });

    mark("appendInstances:start");
    await promiseWithTimeout(appendPrefabInstanceNodes(topLevelNode, context), 30000, "appendPrefabInstanceNodes timeout");
    mark("appendInstances:done", {
      prefabInstanceCount: context.stats.prefabInstanceCount,
      nestedComponentReportCount: context.nestedComponentReports.length
    });

    figma.ui.postMessage({
      type: "PREFAB_TO_FIGMA_DIAG_RESULT",
      requestId: message.requestId,
      result: {
        status: "completed",
        allPass: true,
        stages,
        summary: {
          lastStage,
          rootNodeId: topLevelNode && topLevelNode.id,
          rootName: topLevelNode && topLevelNode.name,
          stats: context.stats,
          nestedComponentReports: context.nestedComponentReports,
          prefabInstanceReports: context.prefabInstanceReports
        },
        warnings: context.warnings,
        blockingErrors: []
      }
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "PREFAB_TO_FIGMA_DIAG_RESULT",
      requestId: message.requestId,
      result: {
        status: "error",
        allPass: false,
        stages,
        summary: {
          lastStage,
          rootNodeId: topLevelNode && topLevelNode.id,
          rootName: topLevelNode && topLevelNode.name,
          stats: context && context.stats,
          nestedComponentReports: context && context.nestedComponentReports,
          prefabInstanceReports: context && context.prefabInstanceReports
        },
        warnings: context ? context.warnings : [],
        blockingErrors: [{
          code: "prefabDiagFailed",
          message: error instanceof Error ? error.message : String(error),
          details: [{ lastStage }]
        }],
        errors: [error instanceof Error ? error.message : String(error)]
      }
    });
  }
}

/** 鏍规嵁鑴氭湰鐢熸垚鐨?prefab-to-figma 鍖呬笌鍐欏叆璁″垝鍒涘缓 Figma 鑺傜偣銆?*/
async function writePrefabToFigmaJob(job, assets) {
  const startTime = Date.now();
  const prefabPackage = job.package || job.prefabPackage || job.manifest;
  const writePlan = job.writePlan || {};
  if (!prefabPackage || typeof prefabPackage !== "object" || !prefabPackage.root) {
    throw new Error("PREFAB_TO_FIGMA_WRITE missing package.root");
  }

  // dynamic-page documentAccess 涓?findAll 闇€瑕佸厛鍔犺浇鎵€鏈夐〉闈?
  try { await figma.loadAllPagesAsync(); } catch (e) { /* 闈?dynamic-page 妯″紡鍙拷鐣?*/ }

  const context = createPrefabWriteContext(job, prefabPackage, writePlan, assets);
  await detectPrefabFileFont(context); // 鍦ㄥ啓鍏ユ枃鏈墠妫€娴嬫枃浠跺唴宸叉湁瀛椾綋椋庢牸
  const parent = await resolvePrefabWriteParent(job.target || (writePlan.figma || {}));
  let topLevelNode = await createPrefabTopLevelNode(parent, context);
  context.currentTopLevelNode = topLevelNode;
  context.importPage = resolvePrefabNodePage(topLevelNode) || figma.currentPage;
  await appendPrefabInstanceNodes(topLevelNode, context);
  const componentResult = await applyPrefabComponentMode(topLevelNode, context);
  if (componentResult && componentResult.node) {
    topLevelNode = componentResult.node;
  }

  figma.currentPage.selection = [topLevelNode];
  figma.viewport.scrollAndZoomIntoView([topLevelNode]);

  const screenshot = await exportPrefabWriteScreenshot(topLevelNode, context);
  const validation = validatePrefabWriteResult(topLevelNode, context, componentResult, screenshot);
  const screenshotMeta = buildPrefabScreenshotMetadata(screenshot);
  const status = buildPrefabWriteStatus(context);
  const summary = {
    prefabPath: String(prefabPackage.prefabPath || ""),
    rootName: String(topLevelNode.name || ""),
    nodeCount: (prefabPackage.nodes || []).length,
    createdCount: countDescendants(topLevelNode),
    stats: context.stats,
    validation,
    durationMs: Date.now() - startTime
  };

  return {
    status,
    allPass: status === "completed",
    blockingErrors: context.blockingErrors,
    warnings: context.warnings,
    summary,
    checks: context.checks,
    artifacts: {
      rootNodeId: topLevelNode.id,
      rootName: topLevelNode.name,
      packagePath: String(job.packagePath || writePlan.sourcePackagePath || ""),
      writePlanPath: String(job.writePlanPath || ""),
      screenshotExported: !!screenshot,
      screenshot: screenshotMeta
    },
    rootNodeId: topLevelNode.id,
    rootName: topLevelNode.name,
    createdCount: countDescendants(topLevelNode),
    screenshot,
    errors: context.blockingErrors.map((item) => item.message || item.code || "blocking error")
  };
}

function buildPrefabScreenshotMetadata(screenshot) {
  if (!screenshot || typeof screenshot !== "object") {
    return null;
  }
  return {
    fileName: String(screenshot.fileName || ""),
    mimeType: String(screenshot.mimeType || ""),
    width: positiveOr(screenshot.width, 0),
    height: positiveOr(screenshot.height, 0),
    byteLength: positiveOr(screenshot.byteLength, 0)
  };
}

/** 鍒涘缓 Prefab 鍐欏叆涓婁笅鏂囷紝闆嗕腑淇濆瓨缂撳瓨銆佺粺璁″拰瀹℃牳缁撴灉銆?*/
function createPrefabWriteContext(job, prefabPackage, writePlan, assets) {
  return {
    job,
    package: prefabPackage,
    plan: writePlan,
    nestedPrefabComponentMode: normalizeNestedPrefabComponentMode(job.nestedPrefabComponentMode || writePlan.nestedPrefabComponentMode),
    assetBytes: buildPrefabAssetBytesMap(assets),
    imageHashes: new Map(),
    prefabComponentByGuid: new Map(),
    nodeByUnityId: new Map(),
    imageHashReports: [],
    imageLayerVisualReports: [],
    tmpMaterialReports: [],
    outlineReports: [],
    nineSliceReports: [],
    prefabInstanceReports: [],
    prefabInstanceGeometryReports: [],
    unityNodeGeometryReports: [],
    unityNodeOrderReports: [],
    unityNodeStateReports: [],
    nestedComponentReports: [],
    currentTopLevelNode: null,
    importPage: null,
    autoNestedComponentPlacementCount: 0,
    nestedPrefabComponentDepth: 0,
    creatingNestedPrefabGuids: new Set(),
    createdNodeIds: [],
    mutatedNodeIds: [],
    warnings: [],
    blockingErrors: [],
    checks: {},
    fontCache: new Map(),
    fileFont: null,       // detectPrefabFileFont 妫€娴嬪埌鐨勬枃浠跺亸濂藉瓧浣?
    fileFontCount: 0,
    allowedFontFamilies: {},  // sourceFontFamily 绛夐潪 fileFont 瀛椾綋璁板綍锛屼緵楠岃瘉鏀捐
    stats: {
      frameCount: 0,
      imageCount: 0,
      textCount: 0,
      underlayTextCount: 0,
      nineSliceCount: 0,
      sliceCount: 0,
      unsupportedCount: 0,
      prefabInstanceCount: 0,
      missingAssetCount: 0,
      tmpMaterialTextCount: 0,
      outlineTextCount: 0
    },
    screenshotPolicy: {
      export: job.exportScreenshot === true || job.includeScreenshot === true
    }
  };
}

/** 获取节点所在页面，供同一次写入内的辅助组件选择稳定落点。 */
function resolvePrefabNodePage(node) {
  let current = node;
  while (current && current.type !== "PAGE") {
    current = current.parent;
  }
  return current && current.type === "PAGE" ? current : null;
}

/** 灏?UI 绾跨▼涓嬭浇濂界殑璧勬簮瀛楄妭杞崲涓?assetId 绱㈠紩銆?*/
function buildPrefabAssetBytesMap(assets) {
  const map = new Map();
  for (const asset of assets || []) {
    if (!asset || !asset.id) {
      continue;
    }
    map.set(String(asset.id), {
      bytes: toUint8Array(asset.bytes),
      path: String(asset.path || "")
    });
  }
  return map;
}

/** 瑙ｆ瀽 Prefab 鍐欏叆鐩爣鐖惰妭鐐癸紝骞朵繚璇佸唴瀹瑰垱寤哄湪鐩爣鎵€鍦ㄩ〉闈€?*/
async function resolvePrefabWriteParent(target) {
  const nodeId = target && target.nodeId ? String(target.nodeId) : "";
  if (!nodeId) {
    return figma.currentPage;
  }

  let node = await figma.getNodeByIdAsync(nodeId).catch(() => null);
  if (!node) {
    node = await findNodeAcrossPages(nodeId);
  }
  if (!node) {
    throw new Error(`Prefab 鍐欏叆鐩爣鑺傜偣涓嶅瓨鍦細${nodeId}`);
  }
  await setCurrentPageForNode(node);
  if (node.type === "PAGE") {
    return node;
  }
  if ("appendChild" in node) {
    return node;
  }
  return node.parent && "appendChild" in node.parent ? node.parent : figma.currentPage;
}

/** 鍒涘缓椤跺眰瀵煎叆鑺傜偣锛屽繀瑕佹椂浣跨敤 __ImportBounds 鍖呬綇瑙嗚澶栨孩鑼冨洿銆?*/
async function createPrefabTopLevelNode(parent, context) {
  const rootSource = context.package.root || {};
  const rootRect = rootSource.rect || {};
  const visualBounds = context.package.visualBounds || {};
  const needsWrapper = prefabNeedsImportBoundsWrapper(context.package, context.plan);

  if (!needsWrapper) {
    const rootFrame = await createPrefabUnityFrame(rootSource, context);
    applyPrefabRootViewportClip(rootFrame, context);
    const placement = resolvePrefabTopLevelPlacement(parent, context, rootFrame.width, rootFrame.height, numericOr(rootRect.x, 0), numericOr(rootRect.y, 0));
    parent.appendChild(rootFrame);
    rootFrame.x = placement.x;
    rootFrame.y = placement.y;
    return rootFrame;
  }

  const wrapper = figma.createFrame();
  wrapper.name = `${String(rootSource.name || "Prefab")}__ImportBounds`;
  wrapper.resize(positiveOr(visualBounds.width, positiveOr(rootRect.width, 1)), positiveOr(visualBounds.height, positiveOr(rootRect.height, 1)));
  const placement = resolvePrefabTopLevelPlacement(parent, context, wrapper.width, wrapper.height, 0, 0);
  wrapper.x = placement.x;
  wrapper.y = placement.y;
  wrapper.fills = [];
  wrapper.strokes = [];
  wrapper.clipsContent = false;
  parent.appendChild(wrapper);
  markPrefabCreatedNode(wrapper, context);
  writePrefabPluginData(wrapper, {
    importKind: "prefab-to-figma",
    nodeRole: "importBounds",
    prefabPath: context.package.prefabPath || "",
    visualBounds
  });

  const rootFrame = await createPrefabUnityFrame(rootSource, context);
  applyPrefabRootViewportClip(rootFrame, context);
  wrapper.appendChild(rootFrame);
  const rootOffset = resolveImportBoundsRootOffset(rootRect, visualBounds);
  rootFrame.x = rootOffset.x;
  rootFrame.y = rootOffset.y;
  return wrapper;
}

/** 解析顶层导入落点；未显式指定坐标时，页面级导入自动放到空位，避免透明节点透出旧导入内容。 */
function resolvePrefabTopLevelPlacement(parent, context, width, height, fallbackX, fallbackY) {
  if (context && hasExplicitPrefabJobPosition(context.job)) {
    return {
      x: numericOr(context.job.x, fallbackX),
      y: numericOr(context.job.y, fallbackY)
    };
  }
  if (parent && parent.type === "PAGE") {
    return resolvePrefabPageFreePosition(parent, width, height, fallbackX, fallbackY);
  }
  return {
    x: numericOr(fallbackX, 0),
    y: numericOr(fallbackY, 0)
  };
}

/** 判断调用方是否显式指定了写入坐标，显式坐标必须优先保留。 */
function hasExplicitPrefabJobPosition(job) {
  return !!(job && (job.x !== undefined || job.y !== undefined));
}

/** 在当前页面上为新导入节点寻找不重叠落点，避免多个透明导入根节点都堆在 (0,0)。 */
function resolvePrefabPageFreePosition(page, width, height, fallbackX, fallbackY) {
  const nodeWidth = positiveOr(width, 1);
  const nodeHeight = positiveOr(height, 1);
  const margin = 160;
  const baseX = numericOr(fallbackX, 0);
  const baseY = numericOr(fallbackY, 0);
  const children = page && Array.isArray(page.children) ? page.children : [];
  if (children.length === 0 || !prefabPagePositionOverlaps(children, baseX, baseY, nodeWidth, nodeHeight)) {
    return { x: baseX, y: baseY };
  }

  let maxRight = baseX;
  let topY = baseY;
  for (const child of children) {
    if (!child || !("x" in child) || !("y" in child) || !("width" in child) || !("height" in child)) {
      continue;
    }
    const childX = numericOr(child.x, 0);
    const childY = numericOr(child.y, 0);
    maxRight = Math.max(maxRight, childX + positiveOr(child.width, 0));
    topY = Math.min(topY, childY);
  }
  return {
    x: maxRight + margin,
    y: topY
  };
}

/** 检查候选落点是否与页面已有节点相交。 */
function prefabPagePositionOverlaps(children, x, y, width, height) {
  const right = x + width;
  const bottom = y + height;
  for (const child of children) {
    if (!child || !("x" in child) || !("y" in child) || !("width" in child) || !("height" in child)) {
      continue;
    }
    const childX = numericOr(child.x, 0);
    const childY = numericOr(child.y, 0);
    const childRight = childX + positiveOr(child.width, 0);
    const childBottom = childY + positiveOr(child.height, 0);
    if (x < childRight && right > childX && y < childBottom && bottom > childY) {
      return true;
    }
  }
  return false;
}

/** 顶层屏幕 Prefab 需要按 Unity Canvas 视口裁切，避免屏幕外内容撑大 Figma 截图画布。 */
function applyPrefabRootViewportClip(rootFrame, context) {
  if (!rootFrame || !context || context.isCreatingNestedPrefabComponent === true) {
