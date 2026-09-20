// Figma Relay build #289
function createImageHealth(status, reason, details = {}) {
  return Object.assign({ status, reason }, details);
}

function isValidImagePayload(item) {
  return !!item
    && Number(item.width) >= 1
    && Number(item.height) >= 1
    && Number(item.byteLength) > 8
    && typeof item.base64 === "string"
    && item.base64.startsWith("iVBORw0KGgo");
}

function validateImageExports(exports) {
  const byId = new Map(exports.map((item) => [String(item.id || ""), item]));
  const errors = [];
  for (const item of exports) {
    if (item.duplicateOf) {
      const source = byId.get(String(item.duplicateOf));
      if (!source || !isValidImagePayload(source)) {
        errors.push({ code: "danglingDuplicate", nodeId: item.nodeId || "", nodePath: item.nodePath || "", exportId: item.id || "", sourceExportId: item.duplicateOf });
      }
      continue;
    }
    if (!isValidImagePayload(item)) {
      errors.push({ code: "invalidImagePayload", nodeId: item.nodeId || "", nodePath: item.nodePath || "", exportId: item.id || "", width: Number(item.width) || 0, height: Number(item.height) || 0, byteLength: Number(item.byteLength) || 0 });
    }
  }
  return errors;
}

function summarizeImageHealth(exports) {
  const summary = { total: exports.length, healthy: 0, repaired: 0, blocked: 0 };
  for (const item of exports) {
    const status = item && item.health ? item.health.status : "blocked";
    if (status === "healthy" || status === "repaired" || status === "blocked") summary[status] += 1;
    else summary.blocked += 1;
  }
  return summary;
}

function applyImageValidationErrors(exports, errors) {
  const byId = new Map(exports.map((item) => [String(item.id || ""), item]));
  for (const error of errors) {
    const item = byId.get(String(error.exportId || ""));
    if (item) item.health = createImageHealth("blocked", error.code || "invalidImagePayload", { sourceExportId: error.sourceExportId || "" });
  }
}
class PluginOperationScope {
  constructor(logger, name, context) {
    this.logger = logger;
    this.context = {
      operationId: context.operationId || logger.idFactory(),
      operationName: name,
      module: context.module || logger.module
    };
    this.startedAt = logger.clock();
    this.stepIndex = 0;
    this.terminal = false;
    logger.emit("info", "started", "operation.start", "插件操作开始", context.data || {}, this.context, 0);
  }

  step(step, message, data, level) {
    if (this.terminal) return;
    this.stepIndex += 1;
    this.logger.emit(level || "info", "progress", step, message || step, data || {}, this.context, this.stepIndex, null, this.logger.clock() - this.startedAt);
  }

  succeed(message, data) {
    this.finish("info", "succeeded", message || "插件操作成功", null, data || {});
  }

  fail(error, message, data) {
    this.finish("error", "failed", message || "插件操作失败", error, data || {});
  }

  cancel(reason, data) {
    this.finish("warn", "cancelled", reason || "插件操作已取消", null, data || {});
  }

  finish(level, status, message, error, data) {
    if (this.terminal) {
      this.stepIndex += 1;
      this.logger.emit("warn", "progress", "operation.terminal.ignored", "忽略重复插件终态", {}, this.context, this.stepIndex);
      return;
    }
    this.terminal = true;
    this.stepIndex += 1;
    this.logger.emit(level, status, "operation.complete", message, data, this.context, this.stepIndex, error, this.logger.clock() - this.startedAt);
  }
}

class PluginLogger {
  constructor(options) {
    options = options || {};
    this.module = options.module || "figma-plugin";
    this.clock = options.clock || Date.now;
    this.idFactory = options.idFactory || function () {
      return "plugin-" + Date.now() + "-" + Math.random().toString(16).slice(2);
    };
    this.postEvent = options.postEvent || function () {};
  }

  startOperation(name, context) {
    return new PluginOperationScope(this, name, context || {});
  }

  trace(message, data, context) { this.log("trace", message, data, context); }
  debug(message, data, context) { this.log("debug", message, data, context); }
  info(message, data, context) { this.log("info", message, data, context); }
  warn(message, data, context) { this.log("warn", message, data, context); }
  error(message, error, data, context) {
    this.emit("error", "failed", "diagnostic", message, data || {}, context || {}, 0, error);
  }

  log(level, message, data, context) {
    this.emit(level, "progress", "diagnostic", message, data || {}, context || {}, 0);
  }

  emit(level, status, step, message, data, context, stepIndex, error, durationMs) {
    var event = {
      timestamp: new Date(this.clock()).toISOString(),
      level: level,
      source: "plugin",
      module: context.module || this.module,
      operationId: context.operationId || this.idFactory(),
      operationName: context.operationName || "diagnostic",
      step: step,
      stepIndex: stepIndex,
      status: status,
      message: String(message || ""),
      data: redactPluginLogData(data || {})
    };
    if (durationMs !== undefined) event.durationMs = durationMs;
    if (error) {
      event.error = {
        name: error && error.name ? String(error.name) : "Error",
        message: error && error.message ? String(error.message) : String(error),
        stack: error && error.stack ? String(error.stack).slice(0, 4096) : undefined
      };
    }
    try {
      this.postEvent(event);
    } catch (postError) {
      try { console.error("[PluginLogger emergency]", postError); } catch (_) {}
    }
  }
}

function redactPluginLogData(value) {
  var sensitive = /password|token|authorization|cookie|api.?key|secret/i;
  function visit(item, key, depth) {
    if (sensitive.test(key || "")) return "[REDACTED]";
    if (depth > 6) return "[Depth limited]";
    if (typeof item === "string") {
      if (item.length > 4096) return { kind: "large-payload", chars: item.length, truncated: true };
      return item;
    }
    if (!item || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.slice(0, 200).map(function (child) { return visit(child, key, depth + 1); });
    var result = {};
    Object.keys(item).slice(0, 200).forEach(function (childKey) {
      result[childKey] = visit(item[childKey], childKey, depth + 1);
    });
    return result;
  }
  return visit(value || {}, "", 0);
}

const pluginLogger = new PluginLogger({
  module: "figma-plugin",
  postEvent: function (event) {
    figma.ui.postMessage({ type: "LOG_EVENT", event: event });
  }
});
// Figma Relay build #289
figma.showUI(__html__, {
  width: 1120,
  height: 800,
  themeColors: true
});
// DIAG: 插件启动标记 (289 由 build.py 替换)
figma.notify("Figma Relay 插件已加载 (build 289)", { timeout: 1000 });
pluginLogger.info("插件初始化完成", { build: "289" });

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
        build: "289",
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

/** 执行 Figma 节点层级整理只读分析，供本地 Relay 客户端生成计划。 */
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

/** 调整指定节点的宽高尺寸，通过 Relay 提供给外部客户端调用。 */
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

/** 执行 Unity Prefab 导出包写入 Figma，供 prefab-to-figma HTTP Relay 客户端调用。 */
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
return;
  }
  const canvas = context.package && context.package.canvas ? context.package.canvas : {};
  const width = positiveOr(canvas.width, 0);
  const height = positiveOr(canvas.height, 0);
  if (width <= 0 || height <= 0) {
    return;
  }
  if (Math.abs(positiveOr(rootFrame.width, 0) - width) < 0.5 &&
    Math.abs(positiveOr(rootFrame.height, 0) - height) < 0.5) {
    rootFrame.clipsContent = true;
  }
}

function resolveImportBoundsRootOffset(rootRect, visualBounds) {
  const visualX = numericOr(visualBounds && visualBounds.x, 0);
  const visualY = numericOr(visualBounds && visualBounds.y, 0);
  return {
    x: -visualX,
    y: -visualY
  };
}

/** 鍒ゆ柇瀵煎叆鍖呮槸鍚﹂渶瑕佸灞傝瑙夊寘鍥寸洅銆?*/
function prefabNeedsImportBoundsWrapper(prefabPackage, writePlan) {
  const planRoot = writePlan && writePlan.root ? writePlan.root : {};
  if (planRoot.needsImportBoundsWrapper === true) {
    return true;
  }
  const rootRect = (prefabPackage.root || {}).rect || {};
  const visualBounds = prefabPackage.visualBounds || {};
  if (!rootRect || !visualBounds) {
    return false;
  }
  return numericOr(visualBounds.x, 0) < 0 ||
    numericOr(visualBounds.y, 0) < 0 ||
    positiveOr(visualBounds.width, 0) > positiveOr(rootRect.width, 0) ||
    positiveOr(visualBounds.height, 0) > positiveOr(rootRect.height, 0);
}

/** 閫掑綊鍒涘缓涓€涓?Unity 鑺傜偣瀵瑰簲鐨?Figma Frame锛屽苟鐢熸垚鍥剧墖銆佹枃瀛楀拰瀛愯妭鐐广€?*/
async function createPrefabUnityFrame(sourceNode, context, inheritedScale) {
  const geometryScale = resolvePrefabGeometryScale(inheritedScale);
  const frame = figma.createFrame();
  frame.name = String(sourceNode.name || "Unnamed");
  frame.fills = [];
  frame.strokes = [];
  frame.clipsContent = !!((sourceNode.clip || {}).enabled);
  applyPrefabNodeGeometry(frame, sourceNode, geometryScale);
  applyPrefabNodeState(frame, sourceNode);
  markPrefabCreatedNode(frame, context);
  context.stats.frameCount += 1;
  if (sourceNode.id) {
    context.nodeByUnityId.set(String(sourceNode.id), frame);
  }
  writePrefabNodeMetadata(frame, sourceNode, context);

  await appendPrefabGeneratedLayers(frame, sourceNode, context);
  const childGeometryScale = resolvePrefabChildGeometryScale(geometryScale, sourceNode && sourceNode.rect ? sourceNode.rect : {});
  const children = Array.isArray(sourceNode.children) ? sourceNode.children : [];
  for (const child of children) {
    const childFrame = await createPrefabUnityFrame(child, context, childGeometryScale);
    frame.appendChild(childFrame);
    applyPrefabNodeGeometry(childFrame, child, childGeometryScale);
  }
  return frame;
}

/** 鎸?Unity RectTransform 杈撳嚭璁剧疆 Figma 鑺傜偣浣嶇疆鍜屽昂瀵搞€?*/
function applyPrefabNodeGeometry(figmaNode, sourceNode, inheritedScale) {
  const rect = sourceNode && sourceNode.rect ? sourceNode.rect : {};
  const geometryScale = resolvePrefabGeometryScale(inheritedScale);
  figmaNode.x = numericOr(rect.x, 0) * geometryScale.x;
  figmaNode.y = numericOr(rect.y, 0) * geometryScale.y;
  if ("resize" in figmaNode) {
    const size = resolvePrefabFigmaNodeSize(rect, geometryScale);
    figmaNode.resize(size.width, size.height);
  }
  applyPrefabNodeConstraints(figmaNode, sourceNode);
  applyPrefabRelativeTransform(figmaNode, rect);
}

function applyPrefabNodeConstraints(figmaNode, sourceNode) {
  if (!("constraints" in figmaNode)) {
    return;
  }
  const rectTransform = sourceNode && sourceNode.rectTransform ? sourceNode.rectTransform : {};
  const constraints = sourceNode && sourceNode.constraints ? sourceNode.constraints : rectTransform.constraints;
  if (!constraints) {
    return;
  }
  figmaNode.constraints = {
    horizontal: normalizePrefabConstraint(constraints.horizontal, "CENTER"),
    vertical: normalizePrefabConstraint(constraints.vertical, "CENTER")
  };
}

function normalizePrefabConstraint(value, fallback) {
  const normalized = String(value || fallback || "CENTER").toUpperCase();
  return ["MIN", "CENTER", "MAX", "STRETCH"].indexOf(normalized) >= 0 ? normalized : fallback;
}

// Unity 正向 Transform scale 在 Figma Frame 上不能稳定保留矩阵，写入时烘焙到尺寸和子树坐标。
function resolvePrefabFigmaNodeSize(rect, inheritedScale) {
  const geometryScale = resolvePrefabGeometryScale(inheritedScale);
  const width = positiveOr(rect && rect.width, 1);
  const height = positiveOr(rect && rect.height, 1);
  return {
    width: Math.max(0.01, width * geometryScale.x),
    height: Math.max(0.01, height * geometryScale.y)
  };
}

/** 解析当前节点相对父节点应烘焙的祖先缩放。 */
function resolvePrefabGeometryScale(inheritedScale) {
  if (!inheritedScale) {
    return { x: 1, y: 1 };
  }
  return {
    x: Math.abs(numericOr(inheritedScale.x, 1)),
    y: Math.abs(numericOr(inheritedScale.y, 1))
  };
}

function resolvePrefabChildGeometryScale(parentScale, rect) {
  const currentScaleX = Math.abs(numericOr(rect && rect.scaleX, 1));
  const currentScaleY = Math.abs(numericOr(rect && rect.scaleY, 1));
  return {
    x: numericOr(parentScale && parentScale.x, 1) * currentScaleX,
    y: numericOr(parentScale && parentScale.y, 1) * currentScaleY
  };
}

/** 鍐欏叆鏃嬭浆鎴栫炕杞煩闃碉紝閬垮厤浣跨敤涓嶅畬鏁寸殑 node.rotation 琛ㄨ揪銆?*/
function applyPrefabRelativeTransform(figmaNode, rect) {
  const rotation = numericOr(rect.rotationZ, 0);
  const scaleX = numericOr(rect.scaleX, 1);
  const scaleY = numericOr(rect.scaleY, 1);
  const transformScaleX = scaleX < 0 ? -1 : 1;
  const transformScaleY = scaleY < 0 ? -1 : 1;
  if (Math.abs(rotation) < 0.001 && transformScaleX === 1 && transformScaleY === 1) {
    return;
  }
  const radians = -rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const width = positiveOr(figmaNode.width, positiveOr(rect.width, 0));
  const height = positiveOr(figmaNode.height, positiveOr(rect.height, 0));
  const x = numericOr(figmaNode.x, 0);
  const y = numericOr(figmaNode.y, 0);
  const cx = width / 2;
  const cy = height / 2;
  const pivotX = x + cx;
  const pivotY = y + cy;
  const a = cos * transformScaleX;
  const b = sin * transformScaleY;
  const c = -sin * transformScaleX;
  const d = cos * transformScaleY;
  const tx = pivotX - a * cx - b * cy;
  const ty = pivotY - c * cx - d * cy;
  figmaNode.relativeTransform = [
    [a, b, tx],
    [c, d, ty]
  ];
}

/** 搴旂敤 Unity active 鐘舵€侊紝淇濈暀闅愯棌鑺傜偣渚夸簬瀹℃煡鍜屽洖鍐欍€?*/
function applyPrefabNodeState(figmaNode, sourceNode) {
  figmaNode.visible = sourceNode.active !== false;
  figmaNode.opacity = resolvePrefabNodeOpacity(sourceNode);
}

function resolvePrefabNodeOpacity(sourceNode) {
  if (sourceNode && sourceNode.active === false) {
    return 0.38;
  }
  const canvasGroup = sourceNode && sourceNode.canvasGroup;
  if (canvasGroup && canvasGroup.alpha !== undefined && canvasGroup.alpha !== null) {
    return clampPrefab01(canvasGroup.alpha);
  }
  return 1;
}

/** 杩藉姞 Unity 鑺傜偣涓婄殑鍥剧墖銆佹枃瀛楀拰涓嶆敮鎸佺粍浠舵爣璁板眰銆?*/
async function appendPrefabGeneratedLayers(frame, sourceNode, context) {
  if (sourceNode.active === false) {
    return;
  }
  if (sourceNode.image) {
    await appendPrefabImageLayers(frame, sourceNode, context);
  }
  if (sourceNode.text) {
    await appendPrefabTextLayers(frame, sourceNode, context);
  }
  recordPrefabUnsupportedComponents(sourceNode, context);
}

/** 杩藉姞鍥剧墖鎴栦節瀹垏鐗囩敓鎴愬眰銆?*/
async function appendPrefabImageLayers(frame, sourceNode, context) {
  const image = sourceNode.image || {};

  // 缂哄け Sprite锛堣繍琛屾椂鍔ㄦ€佽祴鍊硷級: 鍒涘缓鍗犱綅鐭╁舰锛屼笉灏濊瘯涓婁紶鍥剧墖
  if (image.missingSprite) {
    const placeholder = figma.createRectangle();
    placeholder.name = "__missing_sprite";
    frame.appendChild(placeholder);
    placeholder.x = 0;
    placeholder.y = 0;
    placeholder.resize(positiveOr(frame.width, 1), positiveOr(frame.height, 1));
    placeholder.strokes = [];
    placeholder.fills = [{ type: "SOLID", color: { r: 0.5, g: 0.5, b: 0.5 }, opacity: 0.3 }];
    markPrefabCreatedNode(placeholder, context);
    writePrefabPluginData(placeholder, {
      missingSprite: true,
      spriteGuid: image.guid || "",
      nodeRole: "missingSpritePlaceholder"
    });
    return;
  }

  if (String(image.mode || "").toLowerCase() === "nine-slice" && Array.isArray(image.slices) && image.slices.length > 0) {
    await appendPrefabNineSliceLayers(frame, sourceNode, context);
    return;
  }

  const hash = await getPrefabImageHash(image.asset || image.guid, sourceNode, context);
  if (!hash) {
    appendPrefabMissingImageMarker(frame, sourceNode, context);
    return;
  }

  const rect = figma.createRectangle();
  rect.name = "__image";
  frame.appendChild(rect);
  const imageRect = resolvePrefabImageLayerRect(frame, image);
  rect.x = imageRect.x;
  rect.y = imageRect.y;
  rect.resize(positiveOr(imageRect.width, 1), positiveOr(imageRect.height, 1));
  rect.strokes = [];
  const imageOpacity = prefabImageOpacity(image);
  rect.fills = [buildPrefabSimpleImageFill(hash, image, imageOpacity)];
  markPrefabCreatedNode(rect, context);
  writePrefabImageMetadata(rect, image, sourceNode);
  context.imageLayerVisualReports.push(validatePrefabImageLayerVisual(rect, image, sourceNode, "__image", imageOpacity, {
    geometry: imageRect,
    scaleMode: normalizePrefabUvRect(image && image.uvRect) ? "CROP" : "FILL",
    imageTransform: normalizePrefabUvRect(image && image.uvRect) ? buildPrefabUvCropTransform(normalizePrefabUvRect(image.uvRect)) : null
  }));
  context.stats.imageCount += 1;
}

function buildPrefabSimpleImageFill(hash, image, imageOpacity) {
  const uvRect = normalizePrefabUvRect(image && image.uvRect);
  if (uvRect) {
    return {
      type: "IMAGE",
      scaleMode: "CROP",
      imageHash: hash,
      imageTransform: buildPrefabUvCropTransform(uvRect),
      opacity: imageOpacity
    };
  }
  return {
    type: "IMAGE",
    scaleMode: "FILL",
    imageHash: hash,
    opacity: imageOpacity
  };
}

function resolvePrefabImageLayerRect(frame, image) {
  const frameWidth = positiveOr(frame && frame.width, 1);
  const frameHeight = positiveOr(frame && frame.height, 1);
  if (!(image && image.preserveAspect === true)) {
    return { x: 0, y: 0, width: frameWidth, height: frameHeight };
  }
  const pixelSize = image.pixelSize || image.sourceImage || {};
  const imageWidth = positiveOr(pixelSize.width, frameWidth);
  const imageHeight = positiveOr(pixelSize.height, frameHeight);
  const imageAspect = imageWidth / positiveOr(imageHeight, 1);
  const frameAspect = frameWidth / positiveOr(frameHeight, 1);
  if (!isFinite(imageAspect) || imageAspect <= 0 || !isFinite(frameAspect) || frameAspect <= 0) {
    return { x: 0, y: 0, width: frameWidth, height: frameHeight };
  }
  if (imageAspect > frameAspect) {
    const height = frameWidth / imageAspect;
    return { x: 0, y: (frameHeight - height) / 2, width: frameWidth, height };
  }
  const width = frameHeight * imageAspect;
  return { x: (frameWidth - width) / 2, y: 0, width, height: frameHeight };
}

function normalizePrefabUvRect(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const uv = {
    x: numericOr(value.x, 0),
    y: numericOr(value.y, 0),
    width: numericOr(value.width, 1),
    height: numericOr(value.height, 1)
  };
  if (prefabNumberApproximatelyEqual(uv.x, 0) &&
    prefabNumberApproximatelyEqual(uv.y, 0) &&
    prefabNumberApproximatelyEqual(uv.width, 1) &&
    prefabNumberApproximatelyEqual(uv.height, 1)) {
    return null;
  }
  return uv;
}

function buildPrefabUvCropTransform(uvRect) {
  const transform = [
    [positiveOr(uvRect.width, 1), 0, numericOr(uvRect.x, 0)],
    [0, positiveOr(uvRect.height, 1), numericOr(uvRect.y, 0)]
  ];
  assertTransformInRange(transform, "prefab-to-figma rawimage uv");
  return transform;
}

/** 杩藉姞涔濆鍒囩墖锛屽苟鍦ㄧ埗鑺傜偣 fills[0] 淇濈暀涓嶅彲瑙佹簮鍥俱€?*/
async function appendPrefabNineSliceLayers(frame, sourceNode, context) {
  const image = sourceNode.image || {};
  const hash = await getPrefabImageHash(image.asset || image.guid || ((image.sourceImage || {}).spriteGuid), sourceNode, context);
  if (!hash) {
    appendPrefabMissingImageMarker(frame, sourceNode, context);
    return;
  }

  frame.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: hash, opacity: 0 }];
  writePrefabImageMetadata(frame, image, sourceNode);
  writePrefabPluginData(frame, {
    sourceImageFillIndex: "0",
    nodeRole: "nineSliceParent"
  });

  const sourceSize = image.sourceImage || image.pixelSize || {};
  const imageWidth = positiveOr(sourceSize.width, positiveOr((image.pixelSize || {}).width, frame.width));
  const imageHeight = positiveOr(sourceSize.height, positiveOr((image.pixelSize || {}).height, frame.height));
  const slices = image.slices || [];
  for (const slice of slices) {
    const sliceNode = figma.createRectangle();
    sliceNode.name = String(slice.name || "__slice_center");
    frame.appendChild(sliceNode);
    const target = prefabRectObject(slice.target);
    sliceNode.x = target.x;
    sliceNode.y = target.y;
    sliceNode.resize(positiveOr(target.width, 1), positiveOr(target.height, 1));
    sliceNode.strokes = [];
    sliceNode.fills = [{
      type: "IMAGE",
      scaleMode: "CROP",
      imageHash: hash,
      imageTransform: buildPrefabCropTransform(slice.source, imageWidth, imageHeight),
      opacity: prefabImageOpacity(image)
    }];
    sliceNode.constraints = inferSliceConstraints(sliceNode, frame);
    markPrefabCreatedNode(sliceNode, context);
    writePrefabPluginData(sliceNode, {
      nodeRole: "slice",
      sourceRect: JSON.stringify(prefabRectObject(slice.source)),
      sourceImageFillIndex: "0",
      unityNodeId: sourceNode.id || ""
    });
    context.imageLayerVisualReports.push(validatePrefabImageLayerVisual(sliceNode, image, sourceNode, String(slice.name || "__slice_center"), prefabImageOpacity(image), {
      geometry: target,
      scaleMode: "CROP",
      imageTransform: buildPrefabCropTransform(slice.source, imageWidth, imageHeight)
    }));
    context.stats.sliceCount += 1;
  }
  context.stats.nineSliceCount += 1;
  context.nineSliceReports.push({
    nodePath: sourceNode.path || sourceNode.name || "",
    nodeId: frame.id,
    sliceCount: slices.length,
    hasSourceFill: true,
    pass: slices.length > 0
  });
}

/** 鍒涘缓鍥剧墖 CROP 鐭╅樀锛岀洿鎺ユ秷璐硅剼鏈鍒掍腑鐨?source rect銆?*/
function buildPrefabCropTransform(sourceRect, imageWidth, imageHeight) {
  const source = prefabRectObject(sourceRect);
  const transform = [
    [positiveOr(source.width, 1) / positiveOr(imageWidth, 1), 0, numericOr(source.x, 0) / positiveOr(imageWidth, 1)],
    [0, positiveOr(source.height, 1) / positiveOr(imageHeight, 1), numericOr(source.y, 0) / positiveOr(imageHeight, 1)]
  ];
  assertTransformInRange(transform, "prefab-to-figma slice");
  return transform;
}

/** 鑾峰彇鎴栧垱寤哄浘鐗?hash锛屽悓涓€璧勬簮鍦ㄥ崟涓换鍔″唴鍙垱寤轰竴娆°€?*/
async function getPrefabImageHash(assetId, sourceNode, context) {
  const key = String(assetId || "");
if (!key) {
    addPrefabBlockingError(context, "missingImageAssetId", "Image node is missing asset/guid, cannot create IMAGE fill.", {
      nodePath: sourceNode.path || sourceNode.name || ""
    });
    context.stats.missingAssetCount += 1;
    return "";
  }
  if (context.imageHashes.has(key)) {
    return context.imageHashes.get(key);
  }
  const asset = context.assetBytes.get(key);
  if (!asset || !asset.bytes || asset.bytes.length === 0) {
    addPrefabBlockingError(context, "missingImageAssetBytes", "Relay did not receive image bytes, cannot write Figma image.", {
      assetId: key,
      nodePath: sourceNode.path || sourceNode.name || ""
    });
    context.stats.missingAssetCount += 1;
    return "";
  }
  const image = figma.createImage(asset.bytes);
  context.imageHashes.set(key, image.hash);
  context.imageHashReports.push({
    assetId: key,
    imageHash: image.hash,
    hashLength: String(image.hash || "").length,
    pass: String(image.hash || "").length === 40
  });
  return image.hash;
}

/** 鍥剧墖缂哄け鏃跺垱寤烘樉寮忔爣璁帮紝閬垮厤闈欓粯绌虹櫧銆?*/
function appendPrefabMissingImageMarker(frame, sourceNode, context) {
  const marker = figma.createRectangle();
  marker.name = "__unsupported";
  frame.appendChild(marker);
  marker.x = 0;
  marker.y = 0;
  marker.resize(positiveOr(frame.width, 1), positiveOr(frame.height, 1));
  marker.fills = [solidPaintFromManifest({ r: 1, g: 0.25, b: 0.25 }, 0.18)];
  marker.strokes = [solidPaintFromManifest({ r: 1, g: 0, b: 0 }, 0.7)];
  marker.strokeWeight = 1;
  markPrefabCreatedNode(marker, context);
  writePrefabPluginData(marker, {
    nodeRole: "missingImage",
    unityNodePath: sourceNode.path || sourceNode.name || ""
  });
  context.stats.unsupportedCount += 1;
}

/** 杩藉姞 TMP/TextMeshPro 鏂囨湰灞傚拰 Underlay 妯℃嫙灞傘€?*/
async function appendPrefabTextLayers(frame, sourceNode, context) {
  const textData = sourceNode.text || {};
  const fontName = await loadPrefabTextFont(textData, context);
  const underlay = ((textData.effects || {}).underlay) || null;
  if (underlay) {
    const underlayNode = await createPrefabTextNode(frame, sourceNode, textData, fontName, "__text_underlay", underlay, context);
    writePrefabPluginData(underlayNode, {
      nodeRole: "textUnderlay",
      shadowModel: "duplicated_underlay_text"
    });
    context.stats.underlayTextCount += 1;
  }
  const textLayerName = String(textData.figmaTextLayerName || "__text");
  const textNode = await createPrefabTextNode(frame, sourceNode, textData, fontName, textLayerName, null, context);
  writePrefabTextMetadata(textNode, textData, sourceNode, fontName);
  context.stats.textCount += 1;

  if (textData.materialTag) {
    context.stats.tmpMaterialTextCount += 1;
    context.tmpMaterialReports.push(validatePrefabTmpMetadata(textNode, textData, sourceNode));
  }
  const outline = ((textData.effects || {}).outline) || null;
  if (outline && numericOr(outline.width, 0) > 0) {
    context.stats.outlineTextCount += 1;
    context.outlineReports.push({
      nodePath: sourceNode.path || sourceNode.name || "",
      textNodeId: textNode.id,
      pass: Array.isArray(textNode.strokes) && textNode.strokes.length > 0 && numericOr(textNode.strokeWeight, 0) > 0
    });
  }
}

/** 鍒涘缓鍗曚釜鏂囨湰鑺傜偣锛屼富鏂囨湰鍜?underlay 鍏辩敤鍚屼竴濂楀嚑浣曡绠椼€?*/
async function createPrefabTextNode(frame, sourceNode, textData, fontName, layerName, underlay, context) {
  const textNode = figma.createText();
  textNode.name = layerName;
  frame.appendChild(textNode);
  textNode.fontName = fontName;
  textNode.characters = String(textData.content || "");
  const resolvedFontSize = estimatePrefabFontSize(textData, frame);
  textNode.fontSize = resolvedFontSize.size;
  textNode.lineHeight = { unit: "AUTO" };
  const alignH = mapPrefabTextAlignHorizontal((textData.alignment || {}).horizontal);
  const alignV = mapPrefabTextAlignVertical((textData.alignment || {}).vertical);
  textNode.textAlignHorizontal = alignH;
  textNode.textAlignVertical = alignV;
  if (isPrefabTextWrappingEnabled(textData) === false) {
    textNode.textAutoResize = "WIDTH_AND_HEIGHT";
    positionPrefabAutoWidthText(textNode, frame, alignH, alignV, underlay);
  } else {
    textNode.textAutoResize = "NONE";
    textNode.resize(positiveOr(frame.width, 1), positiveOr(frame.height, 1));
    positionPrefabFixedText(textNode, underlay);
  }
  textNode.fills = [prefabSolidPaint(underlay && underlay.color ? underlay.color : (textData.fontColor || textData.color), { r: 0, g: 0, b: 0, a: 1 })];
  applyPrefabTextOutline(textNode, textData, underlay);
  markPrefabCreatedNode(textNode, context);
  writePrefabPluginData(textNode, {
    unityNodeId: sourceNode.id || "",
    unityNodePath: sourceNode.path || sourceNode.name || "",
    generatedLayerName: layerName,
    unityFontSize: String(textData.fontSize || ""),
    figmaFontSize: String(resolvedFontSize.size || ""),
    fontSizeMode: resolvedFontSize.mode || ""
  });
  return textNode;
}

/** 鍒ゆ柇 TMP 鏂囨湰鏄惁鍚敤鑷姩鎹㈣锛屽吋瀹?Unity 6000 鐨?TextWrappingMode銆?*/
function isPrefabTextWrappingEnabled(textData) {
  const options = textData.options || {};
  if (options.wordWrapping === true) return true;
  if (options.wordWrapping === false) return false;
  const mode = numericOr(options.textWrappingMode, -1);
  if (mode === 0 || mode === 3) return false;
  if (mode === 1 || mode === 2) return true;
  return true;
}

/** 涓嶆崲琛屾枃鏈娇鐢ㄨ嚜鍔ㄥ搴︼紝鍐嶆寜 Unity 瀵归綈鏂瑰紡鏀惧洖鍘熸枃鏈鍣ㄣ€?*/
function positionPrefabAutoWidthText(textNode, frame, alignH, alignV, underlay) {
  const fontSize = Math.max(1, numericOr(textNode.fontSize, 16));
  const offsetX = numericOr(underlay && underlay.offsetX, 0) * fontSize * 0.3;
  const offsetY = -numericOr(underlay && underlay.offsetY, 0) * fontSize * 0.3;
  let x = 0;
  if (alignH === "CENTER") {
    x = (positiveOr(frame.width, 1) - positiveOr(textNode.width, 1)) / 2;
  } else if (alignH === "RIGHT") {
    x = positiveOr(frame.width, 1) - positiveOr(textNode.width, 1);
  }
  let y = 0;
  if (alignV === "CENTER") {
    y = (positiveOr(frame.height, 1) - positiveOr(textNode.height, 1)) / 2;
  } else if (alignV === "BOTTOM") {
    y = positiveOr(frame.height, 1) - positiveOr(textNode.height, 1);
  }
  textNode.x = x + offsetX;
  textNode.y = y + offsetY;
}

/** 鍥哄畾妗嗘枃鏈繚鎸佸師瀹瑰櫒灏哄锛屼粎搴旂敤 TMP underlay 鍋忕Щ銆?*/
function positionPrefabFixedText(textNode, underlay) {
  const fontSize = Math.max(1, numericOr(textNode.fontSize, 16));
  textNode.x = numericOr(underlay && underlay.offsetX, 0) * fontSize * 0.3;
  textNode.y = -numericOr(underlay && underlay.offsetY, 0) * fontSize * 0.3;
}

/** 妫€娴?Figma 鏂囦欢涓洰鏍囬〉闈㈢殑涓绘祦瀛椾綋锛屼緵鍒涘缓鏂囨湰鑺傜偣鏃朵紭鍏堜娇鐢ㄣ€?
 *
 *  妫€娴嬩紭鍏堢骇锛堥€愮骇闄嶇骇锛夛細
 *   1. 鍏ㄦ枃浠跺凡鏈?`__text` / `__text_underlay` 灞備腑鏈€澶氱殑瀛椾綋锛堜箣鍓嶅鍏ョ敤鐨勫瓧浣擄級
 *   2. 褰撳墠椤甸潰瀛楃鏈€涓板瘜鐨?TEXT 鑺傜偣瀛椾綋
 *   3. 褰撳墠椤甸潰鍑虹幇娆℃暟鏈€澶氱殑瀛椾綋
 *   4. 鍏ㄦ枃浠跺嚭鐜版鏁版渶澶氱殑瀛椾綋
 */
/** Update imported text node fonts through Relay. */
async function handleChangeTextFonts(message) {
  try {
    const job = message.job || {};
    const fontFamily = String(job.fontFamily || "");
    const fontStyle = String(job.fontStyle || "Regular");
    const selector = String(job.selector || "");
    if (!fontFamily) {
      figma.ui.postMessage({ type: "CHANGE_TEXT_FONTS_RESULT", requestId: message.requestId, result: { status: "error", errors: ["missing fontFamily"] } });
      return;
    }
    if (!selector) {
      figma.ui.postMessage({ type: "CHANGE_TEXT_FONTS_RESULT", requestId: message.requestId, result: { status: "error", errors: ["missing selector"] } });
      return;
    }
    await figma.loadFontAsync({ family: fontFamily, style: fontStyle });
    const allTextNodes = await collectTextNodesUnderSelector(selector);
    if (allTextNodes.length === 0) {
      figma.ui.postMessage({ type: "CHANGE_TEXT_FONTS_RESULT", requestId: message.requestId, result: { status: "completed", changed: 0, warning: "no text nodes found under " + selector } });
      return;
    }
    for (const tn of allTextNodes) {
      tn.fontName = { family: fontFamily, style: fontStyle };
      tn.setSharedPluginData("prefab_to_figma", "fontFallback", "true");
      tn.setSharedPluginData("prefab_to_figma", "figmaFontFamily", fontFamily + " " + fontStyle);
    }
    figma.ui.postMessage({
      type: "CHANGE_TEXT_FONTS_RESULT",
      requestId: message.requestId,
      result: { status: "completed", changed: allTextNodes.length, fontFamily, fontStyle }
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "CHANGE_TEXT_FONTS_RESULT",
      requestId: message.requestId,
      result: { status: "error", errors: [error instanceof Error ? error.message : String(error)] }
    });
  }
}


/** 鏀堕泦鎸囧畾瀵煎叆鏍硅妭鐐逛笅鐨勬枃鏈妭鐐癸紝閬垮厤鍐欐鍏蜂綋鐣岄潰鍚嶇О銆?*/
async function collectTextNodesUnderSelector(selector) {
  const originalPage = figma.currentPage;
  const allTextNodes = [];
  try {
    for (const page of figma.root.children) {
      await figma.setCurrentPageAsync(page);
      page.findAll(n => {
        if (n.name === selector || n.name.startsWith(selector)) {
          if ("findAll" in n) {
            n.findAll(c => {
              if (c.type === "TEXT") allTextNodes.push(c);
              return false;
            });
          }
        }
        return false;
      });
    }
  } finally {
    if (originalPage && figma.currentPage !== originalPage) {
      await figma.setCurrentPageAsync(originalPage);
    }
  }
  return allTextNodes;
}


async function detectPrefabFileFont(context) {
  try {
    const originalPage = figma.currentPage;
    const currentStats = collectPrefabFontStatsForPage(figma.currentPage);
    const currentChoice = choosePrefabFileFont(currentStats);
    if (currentChoice) {
      context.fileFont = currentChoice.font;
      context.fileFontCount = currentChoice.count;
      return;
    }

    const globalStats = createPrefabFontStats();
    try {
      for (const page of figma.root.children) {
        if (page === originalPage) continue;
        await figma.setCurrentPageAsync(page);
        mergePrefabFontStats(globalStats, collectPrefabFontStatsForPage(page));
      }
    } finally {
      if (originalPage && figma.currentPage !== originalPage) {
        await figma.setCurrentPageAsync(originalPage);
      }
    }
    mergePrefabFontStats(globalStats, currentStats);
    const globalChoice = choosePrefabFileFont(globalStats);
    if (!globalChoice) return;
    context.fileFont = globalChoice.font;
    context.fileFontCount = globalChoice.count;
  } catch (e) {
    context.warnings.push(`鏂囦欢瀛椾綋妫€娴嬭烦杩囷細${e.message}`);
  }
}


/** 鍒涘缓瀛椾綋缁熻瀹瑰櫒銆?*/
function createPrefabFontStats() {
  return { totalTextNodes: 0, importTextFonts: {}, fontCounts: {}, bestTextFont: null, bestTextLen: 0 };
}

/** 缁熻鍗曚釜椤甸潰鍐呯殑鏂囨湰瀛椾綋銆?*/
function collectPrefabFontStatsForPage(page) {
  const stats = createPrefabFontStats();
  page.findAll(n => {
    if (n.type !== "TEXT") return false;
    stats.totalTextNodes++;
    const fn = n.fontName;
    if (!fn || !fn.family) return false;
    const key = `${fn.family}:${fn.style}`;
    const len = n.characters.length;
    stats.fontCounts[key] = (stats.fontCounts[key] || 0) + 1;
    if (len > stats.bestTextLen) {
      stats.bestTextLen = len;
      stats.bestTextFont = fn;
    }
    const parentName = n.parent ? n.parent.name : "";
    if (parentName === "__text" || parentName === "__text_underlay") {
      stats.importTextFonts[key] = (stats.importTextFonts[key] || 0) + 1;
    }
    return false;
  });
  return stats;
}

/** 鍚堝苟瀛椾綋缁熻缁撴灉銆?*/
function mergePrefabFontStats(target, source) {
  target.totalTextNodes += source.totalTextNodes || 0;
  mergeCountMap(target.importTextFonts, source.importTextFonts);
  mergeCountMap(target.fontCounts, source.fontCounts);
  if ((source.bestTextLen || 0) > target.bestTextLen) {
    target.bestTextLen = source.bestTextLen;
    target.bestTextFont = source.bestTextFont;
  }
}

/** 鍚堝苟璁℃暟瀛楀吀銆?*/
function mergeCountMap(target, source) {
  for (const [key, count] of Object.entries(source || {})) {
    target[key] = (target[key] || 0) + count;
  }
}

/** 鎸変紭鍏堢骇閫夋嫨瀵煎叆鏂囨湰搴斾娇鐢ㄧ殑鏂囦欢瀛椾綋銆?*/
function choosePrefabFileFont(stats) {
  if (!stats || stats.totalTextNodes === 0) return null;
  const importChoice = chooseMostCommonPrefabFont(stats.importTextFonts);
  if (importChoice) return importChoice;
  if (stats.bestTextFont) {
    const key = `${stats.bestTextFont.family}:${stats.bestTextFont.style}`;
    return { font: stats.bestTextFont, count: stats.fontCounts[key] || 0 };
  }
  return chooseMostCommonPrefabFont(stats.fontCounts);
}

/** 浠庤鏁板瓧鍏镐腑閫夊嚭鐜版鏁版渶澶氱殑瀛椾綋銆?*/
function chooseMostCommonPrefabFont(counts) {
  let maxCount = 0;
  let bestKey = null;
  for (const [key, count] of Object.entries(counts || {})) {
    if (count > maxCount) {
      maxCount = count;
      bestKey = key;
    }
  }
  if (!bestKey) return null;
  const parts = bestKey.split(":");
  return { font: { family: parts[0], style: parts[1] || "Regular" }, count: maxCount };
}

/** 鍔犺浇鏂囨湰瀛椾綋锛氫紭鍏堜娇鐢ㄦ枃浠跺唴宸叉湁瀛椾綋椋庢牸锛屽叾娆′娇鐢?Inter 鍏滃簳銆?*/
async function loadPrefabTextFont(textData, context) {
  const style = numericOr((textData.options || {}).fontStyle, 0) & 1 ? "Bold" : "Regular";
  const candidates = [];

  appendPrefabUnityGameFontCandidates(candidates, textData, style);

  // 优先使用当前 Figma 文件已存在字体，避免不存在的 TMP 字体候选长时间阻塞 loadFontAsync。
  if (context.fileFont) {
    candidates.push(context.fileFont);
  }
  if (context.fileFont && context.fileFont.style !== "Regular") {
    candidates.push({ family: context.fileFont.family, style: "Regular" });
  }

  // 1. 瑙ｆ瀽鍣ㄦ寜 TMP 鏉愯川鍚嶇粰鍑虹殑 Figma 瀛椾綋鍊欓€夛紝浼樺厛澶勭悊涓枃瀛椾綋鍚嶃€?
  const parserCandidates = ((textData.sharedMaterial || {}).figmaFontCandidates || []);
  if (Array.isArray(parserCandidates)) {
    for (const family of parserCandidates) {
      appendPrefabFontCandidate(candidates, family, style);
    }
  }
  appendPrefabMaterialFontCandidates(candidates, textData, style);
  // 2. TMP 婧愬瓧浣撳鏃忓悕锛堜粠 .asset 鐨?m_SourceFontFileGUID 瑙ｆ瀽锛屼綔涓鸿ˉ鍏呭€欓€夛級
  var sourceFontFamily = (textData.sharedMaterial || {}).sourceFontFamily || "";
  if (sourceFontFamily) {
    appendPrefabFontCandidate(candidates, sourceFontFamily, style);
  }
  // 5. TMP 鏉愯川鍚嶏紙Unity TMP Font Asset 鍚嶇О锛屽厹搴曪級
  var matName = (textData.sharedMaterial || {}).name || "";
  if (matName) {
    appendPrefabFontCandidate(candidates, matName, style);
  }
  // 6. Inter 鍏滃簳
  candidates.push({ family: "Inter", style: style });
  candidates.push({ family: "Inter", style: "Regular" });

  for (const fontName of candidates) {
    const key = `${fontName.family}/${fontName.style}`;
    if (context.fontCache.has(key)) {
      return context.fontCache.get(key);
    }
    try {
      await promiseWithTimeout(figma.loadFontAsync(fontName), 2500, `font load timeout: ${key}`);
      context.fontCache.set(key, fontName);
      // 璁板綍闈?fileFont 瀛椾綋锛堝 sourceFontFamily锛夛紝渚涢獙璇佹斁琛?
      if (!context.fileFont || fontName.family !== context.fileFont.family) {
        context.allowedFontFamilies[key] = true;
      }
      return fontName;
    } catch (error) {
      context.warnings.push(`瀛椾綋鍔犺浇澶辫触锛屽皾璇曚笅涓€涓€欓€夛細${key}`);
    }
  }
  throw new Error("prefab-to-figma could not load any candidate font.");
}

/** 杩藉姞瀛椾綋鍊欓€夊強鍏?Regular 鍙樹綋锛岄伩鍏嶉噸澶嶅皾璇曘€?*/
function appendPrefabFontCandidate(candidates, family, style) {
  const normalized = String(family || "").trim();
  if (!normalized) return;
  appendUniquePrefabFontCandidate(candidates, { family: normalized, style: style });
  if (style !== "Regular") {
    appendUniquePrefabFontCandidate(candidates, { family: normalized, style: "Regular" });
  }
}

/** Unity 常用游戏字在 Figma 不可用时，优先映射到文件里存在的近似粗圆字体。 */
function appendPrefabUnityGameFontCandidates(candidates, textData, style) {
  const sharedMaterial = textData.sharedMaterial || {};
  const names = [
    sharedMaterial.sourceFontFamily || "",
    sharedMaterial.name || "",
    textData.materialTag || ""
  ].join(" ").toLowerCase();
  if (names.indexOf("grobold") >= 0 || names.indexOf("commonfont") >= 0) {
    appendUniquePrefabFontCandidate(candidates, { family: "Lilita One", style: "Regular" });
  }
}

/** 杩藉姞鍘婚噸鍚庣殑鍗曚釜瀛椾綋鍊欓€夈€?*/
function appendUniquePrefabFontCandidate(candidates, fontName) {
  for (const item of candidates) {
    if (item.family === fontName.family && item.style === fontName.style) {
      return;
    }
  }
  candidates.push(fontName);
}

/** 浠?TMP 鏉愯川鍚嶆帹鏂?Figma 瀛椾綋鍊欓€夛紝浼樺厛閬垮厤涓枃钀藉埌鎷変竵瑁呴グ瀛椾綋銆?*/
function appendPrefabMaterialFontCandidates(candidates, textData, style) {
  const sharedMaterial = textData.sharedMaterial || {};
  const names = [textData.materialTag || "", sharedMaterial.name || ""];
  for (const name of names) {
    const compact = String(name || "").replace(/[\s_-]+/g, "");
    if (compact.indexOf("NotoSansSC") >= 0 || compact.indexOf("NotoSansCJKSC") >= 0) {
      appendPrefabFontCandidate(candidates, "Noto Sans SC", style);
      appendPrefabFontCandidate(candidates, "Noto Sans CJK SC", style);
      appendPrefabFontCandidate(candidates, "Source Han Sans SC", style);
      appendPrefabFontCandidate(candidates, "Microsoft YaHei", style);
    }
  }
}

/** 浼扮畻 Figma 瀛楀彿锛孉utoSize 鏃堕檺鍒跺湪 min/max 鍐呫€?*/
function estimatePrefabFontSize(textData, frame) {
  const baseSize = positiveOr(textData.fontSize, 16);
  const autoSize = textData.autoSize || {};
  if (autoSize.enabled !== true) {
    return { size: baseSize, mode: "fixed" };
  }
  const minSize = positiveOr(autoSize.min, Math.min(baseSize, 1));
  const maxSize = positiveOr(autoSize.max, baseSize);
  const clampedBase = Math.max(minSize, Math.min(baseSize, maxSize));
  if (isPrefabTextWrappingEnabled(textData) === false) {
    return { size: clampedBase, mode: "autosize_nowrap_unity_size" };
  }
  const contentLength = Math.max(1, String(textData.content || "").length);
  const widthLimit = positiveOr(frame.width, 1) / Math.max(1, contentLength * 0.6);
  return {
    size: Math.max(minSize, Math.min(clampedBase, widthLimit)),
    mode: "autosize_width_limited"
  };
}

/** 搴旂敤 TMP 鎻忚竟锛沀nderlay 灞備娇鐢ㄨ嚜韬鑹诧紝涓嶉噸澶嶄富鎻忚竟銆?*/
function applyPrefabTextOutline(textNode, textData, underlay) {
  if (underlay) {
    textNode.strokes = [];
    return;
  }
  const outline = ((textData.effects || {}).outline) || null;
  if (!outline || numericOr(outline.width, 0) <= 0) {
    textNode.strokes = [];
    return;
  }
  textNode.strokes = [prefabSolidPaint(outline.color || textData.outlineColor, { r: 0, g: 0, b: 0, a: 1 })];
  textNode.strokeWeight = resolvePrefabTextStrokeWeight(outline, textNode);
  textNode.strokeAlign = "OUTSIDE";
}

/** TMP SDF 描边比 Figma Stroke 更厚，按 Unity 截图经验放大到可见的 2-4px 区间。 */
function resolvePrefabTextStrokeWeight(outline, textNode) {
  const width = numericOr(outline && outline.width, 0);
  const fontSize = positiveOr(textNode && textNode.fontSize, 16);
  if (width <= 0) {
    return 0;
  }
  const estimated = width * fontSize * 0.5;
  return Math.max(2, Math.min(4, estimated));
}

/** 鎶?TMP 姘村钩瀵归綈鏋氫妇鏄犲皠鍒?Figma銆?*/
function mapPrefabTextAlignHorizontal(value) {
  const number = numericOr(value, 2);
  if (number === 1) return "LEFT";
  if (number === 4) return "RIGHT";
  if (number === 8 || number === 16) return "JUSTIFIED";
  return "CENTER";
}

/** 鎶?TMP 鍨傜洿瀵归綈鏋氫妇鏄犲皠鍒?Figma銆?*/
function mapPrefabTextAlignVertical(value) {
  const number = numericOr(value, 512);
  if (number === 256 || number === 8192) return "TOP";
  if (number === 1024) return "BOTTOM";
  return "CENTER";
}

function recordPrefabUnsupportedComponents(sourceNode, context) {
  if (!Array.isArray(sourceNode.unsupported) || sourceNode.unsupported.length <= 0) {
    return;
  }
  context.stats.unsupportedCount += 1;
  context.warnings.push(`${sourceNode.path || sourceNode.name}: unsupported components recorded for report-only downgrade.`);
}

/** 鏍规嵁鐢ㄦ埛閫夋嫨鍐冲畾鏄惁鎶婇《灞傚鍏ヨ妭鐐硅浆涓?Component銆?*/
async function applyPrefabComponentMode(topLevelNode, context) {
  const mode = String(context.job.componentMode || context.plan.componentMode || "component").toLowerCase();
  const requested = mode !== "frame" && mode !== "none";
  if (!requested) {
    return { requested: false, created: false, node: topLevelNode };
  }
  if (!topLevelNode || topLevelNode.type !== "FRAME") {
    addPrefabBlockingError(context, "componentModeUnsupportedNode", "Component mode requires the top-level node to be a FRAME.", {
      nodeId: topLevelNode && topLevelNode.id,
      nodeType: topLevelNode && topLevelNode.type
    });
    return { requested: true, created: false, node: topLevelNode };
  }
  try {
    const shouldClipContent = "clipsContent" in topLevelNode ? !!topLevelNode.clipsContent : false;
    const component = figma.createComponentFromNode(topLevelNode);
    if ("clipsContent" in component) {
      component.clipsContent = shouldClipContent;
    }
    markPrefabMutatedNode(component, context);
    writePrefabPluginData(component, {
      nodeRole: "prefabComponent",
      componentMode: "component",
      prefabGuid: String(context.package.prefabGuid || "")
    });
    refreshPrefabUnityNodeMapFromFigmaRoot(component, context);
    return { requested: true, created: true, node: component, nodeId: component.id };
  } catch (error) {
    addPrefabBlockingError(context, "componentModeFailed", "Figma top-level component conversion failed; original frame was kept.", {
      reason: error instanceof Error ? error.message : String(error)
    });
    return { requested: true, created: false, node: topLevelNode };
  }
}

function refreshPrefabUnityNodeMapFromFigmaRoot(root, context) {
  const refreshed = new Map();
  const sourceIds = new Set(((context.package && context.package.nodes) || []).map((node) => String(node && node.id || "")).filter(Boolean));
  const visit = (node) => {
    if (!node || typeof node.getSharedPluginData !== "function") {
      return;
    }
    const unityNodeId = node.getSharedPluginData(PrefabToFigmaNamespace, "unityNodeId");
    if (unityNodeId && sourceIds.has(String(unityNodeId)) && isPrefabUnityContainerNode(node)) {
      refreshed.set(String(unityNodeId), node);
    }
  };
  visit(root);
  if (root && "findAll" in root) {
    root.findAll((node) => {
      visit(node);
      return false;
    });
  }
  if (refreshed.size > 0) {
    context.nodeByUnityId = refreshed;
  }
}

function isPrefabUnityContainerNode(node) {
  return !!(node && (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE"));
}

/** 鍐欏叆 Unity 鑺傜偣鍏冩暟鎹紝渚涘洖鍐欏拰瀹℃煡浣跨敤銆?*/
function writePrefabNodeMetadata(figmaNode, sourceNode, context) {
  const unity = sourceNode.unity || {};
  const canvasGroup = sourceNode.canvasGroup || {};
  writePrefabPluginData(figmaNode, {
    importKind: "prefab-to-figma",
    prefabPath: context.package.prefabPath || "",
    unityNodeId: sourceNode.id || "",
    unityNodePath: sourceNode.path || sourceNode.name || "",
    unityName: sourceNode.name || "",
    gameObjectId: unity.gameObjectId || "",
    rectTransformId: unity.rectTransformId || "",
    parentRectId: unity.parentRectId || "",
    active: sourceNode.active !== false ? "true" : "false",
    canvasGroupAlpha: canvasGroup.alpha !== undefined ? String(canvasGroup.alpha) : "",
    canvasGroupInteractable: canvasGroup.interactable !== undefined ? String(canvasGroup.interactable) : "",
    canvasGroupBlocksRaycasts: canvasGroup.blocksRaycasts !== undefined ? String(canvasGroup.blocksRaycasts) : "",
    canvasGroupIgnoreParentGroups: canvasGroup.ignoreParentGroups !== undefined ? String(canvasGroup.ignoreParentGroups) : "",
    rect: sourceNode.rect || {}
  });
}

/** 鍐欏叆鍥剧墖鑺傜偣鍏冩暟鎹紝淇濈暀 Unity Sprite 淇℃伅銆?*/
function writePrefabImageMetadata(figmaNode, image, sourceNode) {
  const sourceImage = image.sourceImage || {};
  const pixelSize = image.pixelSize || {};
  const border = image.border || {};
  const color = image.color || {};
  writePrefabPluginData(figmaNode, {
    nodeRole: image.mode === "nine-slice" ? "nineSlice" : "image",
    unityNodeId: sourceNode.id || "",
    unityNodePath: sourceNode.path || sourceNode.name || "",
    spriteGuid: image.guid || sourceImage.spriteGuid || image.asset || "",
    spritePath: sourceImage.assetPath || image.assetPath || "",
    imageGuid: image.guid || image.asset || "",
    imageType: image.imageType || "",
    spriteBorder: `${numericOr(border.left, 0)},${numericOr(border.bottom, 0)},${numericOr(border.right, 0)},${numericOr(border.top, 0)}`,
    originalPixelSize: `${numericOr(sourceImage.width, numericOr(pixelSize.width, 0))}x${numericOr(sourceImage.height, numericOr(pixelSize.height, 0))}`,
    unityImageColor: image.color || "",
    unityImageAlpha: color && color.a !== undefined ? String(color.a) : "1",
    unityImageTintUnsupported: prefabImageHasRgbTint(image) ? "true" : "false",
    preserveAspect: image.preserveAspect === true ? "true" : "false",
    uvRect: image.uvRect || ""
  });
}

function prefabImageOpacity(image) {
  return clampPrefab01(firstDefined(image && image.color && image.color.a, 1));
}

function prefabImageHasRgbTint(image) {
  const color = image && image.color;
  if (!color || typeof color !== "object") {
    return false;
  }
  return !prefabNumberApproximatelyEqual(firstDefined(color.r, 1), 1) ||
    !prefabNumberApproximatelyEqual(firstDefined(color.g, 1), 1) ||
    !prefabNumberApproximatelyEqual(firstDefined(color.b, 1), 1);
}

function validatePrefabImageLayerVisual(figmaNode, image, sourceNode, layerName, expectedOpacity, expectedVisual) {
  const fills = Array.isArray(figmaNode && figmaNode.fills) ? figmaNode.fills : [];
  const imageFill = fills.find((fill) => fill && fill.type === "IMAGE");
  const actualOpacity = imageFill ? numericOr(firstDefined(imageFill.opacity, 1), 1) : null;
  const expected = clampPrefab01(expectedOpacity);
  const visual = expectedVisual || {};
  const expectedScaleMode = visual.scaleMode || (normalizePrefabUvRect(image && image.uvRect) ? "CROP" : "FILL");
  const actualScaleMode = imageFill ? String(imageFill.scaleMode || "") : "";
  const expectedTransform = visual.imageTransform || (expectedScaleMode === "CROP" ? buildPrefabUvCropTransform(normalizePrefabUvRect(image.uvRect)) : null);
  const actualTransform = imageFill && imageFill.imageTransform ? imageFill.imageTransform : null;
  const expectedGeometry = visual.geometry || null;
  const actualGeometry = figmaNode ? {
    x: numericOr(figmaNode.x, 0),
    y: numericOr(figmaNode.y, 0),
    width: positiveOr(figmaNode.width, 0),
    height: positiveOr(figmaNode.height, 0)
  } : null;
  const opacityPass = !!imageFill && prefabNumberApproximatelyEqual(actualOpacity, expected);
  const scaleModePass = !!imageFill && actualScaleMode === expectedScaleMode;
  const transformPass = !expectedTransform || prefabTransformApproximatelyEqual(actualTransform || [], expectedTransform);
  const geometryPass = !expectedGeometry || prefabRectApproximatelyEqual(actualGeometry || {}, expectedGeometry);
  const pass = opacityPass && scaleModePass && transformPass && geometryPass;
  return {
    pass,
    reason: pass ? "" : "image_visual_mismatch",
    unityNodeId: String(sourceNode.id || ""),
    nodePath: sourceNode.path || sourceNode.name || "",
    figmaNodeId: figmaNode && figmaNode.id || "",
    layerName,
    expected: { opacity: expected, scaleMode: expectedScaleMode, imageTransform: expectedTransform, geometry: expectedGeometry },
    actual: { opacity: actualOpacity, scaleMode: actualScaleMode, imageTransform: actualTransform, geometry: actualGeometry },
    tintUnsupported: prefabImageHasRgbTint(image)
  };
}

function clampPrefab01(value) {
  const number = numericOr(value, 1);
  return Math.max(0, Math.min(1, number));
}

/** 鍐欏叆 TMP 鏉愯川鍜屽瓧浣撻檷绾у厓鏁版嵁銆?*/
function writePrefabTextMetadata(textNode, textData, sourceNode, fontName) {
  const sharedMaterial = textData.sharedMaterial || {};
  const existingUnityFontSize = textNode.getSharedPluginData(PrefabToFigmaNamespace, "unityFontSize");
  const figmaFontSize = textNode.getSharedPluginData(PrefabToFigmaNamespace, "figmaFontSize");
  const fontSizeMode = textNode.getSharedPluginData(PrefabToFigmaNamespace, "fontSizeMode");
  writePrefabPluginData(textNode, {
    nodeRole: "text",
    unityNodeId: sourceNode.id || "",
    unityNodePath: sourceNode.path || sourceNode.name || "",
    tmpMaterialTag: textData.materialTag || "",
    tmpMaterialName: sharedMaterial.name || "",
    tmpMaterialGuid: sharedMaterial.guid || "",
    fontFallback: "true",
    figmaFontFamily: fontName.family,
    figmaFontStyle: fontName.style,
    unityFontSize: existingUnityFontSize || String(textData.fontSize || ""),
    figmaFontSize: figmaFontSize || String(textNode.fontSize || ""),
    fontSizeMode: fontSizeMode || ""
  });
}

/** 鏍￠獙 TMP 鏉愯川鍏冩暟鎹槸鍚﹀啓鍏ュ埌鏂囨湰鑺傜偣銆?*/
function validatePrefabTmpMetadata(textNode, textData, sourceNode) {
  const sharedMaterial = textData.sharedMaterial || {};
  const report = {
    nodePath: sourceNode.path || sourceNode.name || "",
    textNodeId: textNode.id,
    layerName: textNode.name,
    tmpMaterialTag: textNode.getSharedPluginData(PrefabToFigmaNamespace, "tmpMaterialTag"),
    tmpMaterialName: textNode.getSharedPluginData(PrefabToFigmaNamespace, "tmpMaterialName"),
    tmpMaterialGuid: textNode.getSharedPluginData(PrefabToFigmaNamespace, "tmpMaterialGuid")
  };
  report.pass = report.tmpMaterialTag === String(textData.materialTag || "") &&
    report.tmpMaterialName === String(sharedMaterial.name || "") &&
    report.tmpMaterialGuid === String(sharedMaterial.guid || "");
  return report;
}

/** 鍐欏叆 SharedPluginData锛岄伩鍏嶆櫘閫?pluginData 鐨勬彃浠舵竻鍗曢殧绂汇€?*/
function writePrefabPluginData(node, values) {
  if (!node || typeof node.setSharedPluginData !== "function") {
    return;
  }
  for (const key of Object.keys(values || {})) {
    node.setSharedPluginData(PrefabToFigmaNamespace, key, serializePrefabMetadataValue(values[key]));
  }
}

/** 搴忓垪鍖栧厓鏁版嵁鍊硷紝瀵硅薄缁熶竴杞?JSON 瀛楃涓层€?*/
function serializePrefabMetadataValue(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

/** 璁板綍鏂板缓鑺傜偣 ID锛屼究浜?Python 渚у鏍告姤鍛婅惤鐩樸€?*/
function markPrefabCreatedNode(node, context) {
  if (node && node.id) {
    context.createdNodeIds.push(node.id);
  }
}

/** 璁板綍琚粍浠跺寲绛夋搷浣滄浛鎹㈡垨鍙樻洿鐨勮妭鐐?ID銆?*/
function resolvePrefabInstanceParent(instanceOverride, topLevelNode, context) {
  const parentRectId = String((instanceOverride || {}).parentRectId || "");
  const resolvedParent = parentRectId && context && context.nodeByUnityId
    ? context.nodeByUnityId.get(parentRectId)
    : null;
  const parent = resolvedParent || topLevelNode;
  return {
    node: parent,
    parentRectId,
    parentResolved: !parentRectId || !!resolvedParent,
    parentFallbackToTopLevel: !!parentRectId && !resolvedParent,
    parentNodeId: parent && parent.id || "",
    parentNodeName: parent && parent.name || "",
    parentNodeType: parent && parent.type || ""
  };
}

function registerPrefabInstanceStrippedRectAliases(node, item, context, report) {
  const ids = Array.isArray(item && item.strippedRectTransformIds)
    ? item.strippedRectTransformIds.map((id) => String(id || "")).filter(Boolean)
    : [];
  if (!node || !context || !context.nodeByUnityId || ids.length === 0) {
    return [];
  }
  const uniqueIds = [];
  for (const id of ids) {
    if (uniqueIds.indexOf(id) < 0) {
      uniqueIds.push(id);
      context.nodeByUnityId.set(id, node);
    }
  }
  writePrefabPluginData(node, {
    strippedRectTransformIds: uniqueIds
  });
  if (report) {
    report.strippedRectTransformIds = uniqueIds;
    report.registeredParentAliasCount = uniqueIds.length;
  }
  return uniqueIds;
}

function buildPrefabInstanceParentIdSet(prefabInstances) {
  const ids = new Set();
  for (const item of prefabInstances || []) {
    const parentRectId = String(((item || {}).instanceOverride || {}).parentRectId || "");
    if (parentRectId) {
      ids.add(parentRectId);
    }
  }
  return ids;
}

function prefabInstanceNeedsChildContainer(item, prefabParentIds) {
  if (!item || !prefabParentIds) {
    return false;
  }
  const ids = Array.isArray(item.strippedRectTransformIds) ? item.strippedRectTransformIds : [];
  return ids.some((id) => prefabParentIds.has(String(id || "")));
}

function createPrefabInstanceContainerFrame(parent, instanceOverride, component) {
  const frame = figma.createFrame();
  parent.appendChild(frame);
  frame.name = String((instanceOverride || {}).name || (component && component.name) || "PrefabInstance");
  frame.clipsContent = false;
  frame.fills = [];
  frame.strokes = [];
  return frame;
}

function fitPrefabComponentInstanceInContainer(instance, container) {
  if (!instance || !container) {
    return;
  }
  instance.x = 0;
  instance.y = 0;
  if ("resize" in instance) {
    instance.resize(positiveOr(container.width, instance.width || 1), positiveOr(container.height, instance.height || 1));
  }
  if ("constraints" in instance) {
    instance.constraints = { horizontal: "SCALE", vertical: "SCALE" };
  }
}

function markPrefabMutatedNode(node, context) {
  if (node && node.id) {
    context.mutatedNodeIds.push(node.id);
  }
}

/** 杩藉姞缁撴瀯鍖栭樆濉為敊璇紝渚?LLM 鍙鏍告姤鍛娿€?*/
function addPrefabBlockingError(context, code, message, details) {
  context.blockingErrors.push({
    code,
    message,
    details: Array.isArray(details) ? details : [details || {}]
  });
}

/** 鎶?Unity 棰滆壊瀵硅薄杞崲涓?Figma SOLID paint銆?*/
function prefabSolidPaint(color, fallback) {
  const source = color && typeof color === "object" ? color : fallback;
  return solidPaintFromManifest(source || { r: 0, g: 0, b: 0 }, firstDefined(source && source.a, 1));
}

/** 鍏煎 {x,y,width,height} 鍜?[x,y,w,h] 涓ょ rect銆?*/
function prefabRectObject(value) {
  if (Array.isArray(value)) {
    return {
      x: numericOr(value[0], 0),
      y: numericOr(value[1], 0),
      width: positiveOr(value[2], 1),
      height: positiveOr(value[3], 1)
    };
  }
  const rect = value || {};
  return {
    x: numericOr(rect.x, 0),
    y: numericOr(rect.y, 0),
    width: positiveOr(rect.width, 1),
    height: positiveOr(rect.height, 1)
  };
}

/** Export top-level imported node screenshot as Relay verification evidence. */
async function exportPrefabWriteScreenshot(root, context) {
  if (!context || !context.screenshotPolicy || context.screenshotPolicy.export !== true) {
    context.warnings.push("Prefab 写入阶段已跳过 Relay 截图导出，避免大节点导出阻塞；请使用 Figma 截图工具做最终视觉验收。");
    return null;
  }
  try {
    return await exportRootScreenshot(root, context);
  } catch (error) {
    context.warnings.push(`Prefab screenshot export failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** 鐢熸垚鍐欏叆鍚庣殑缁熶竴楠岃瘉缁撴灉锛屽苟鎶婄‖闂ㄧ澶辫触杩藉姞鍒?blockingErrors銆?*/
function validatePrefabWriteResult(topLevelNode, context, componentResult, screenshot) {
  validatePrefabUnityNodeReadback(context);
  const expectedNodeCount = (context.package.nodes || []).length;
  const checks = {
    nodeCount: makePrefabCheck(
      context.nodeByUnityId.size === expectedNodeCount,
      { expected: expectedNodeCount, actual: context.nodeByUnityId.size },
      context.nodeByUnityId.size === expectedNodeCount ? [] : [{ expected: expectedNodeCount, actual: context.nodeByUnityId.size }]
    ),
    imageFillHashLength: makePrefabCheck(
      context.imageHashReports.every((item) => item.pass) && context.stats.missingAssetCount === 0,
      { imageHashCount: context.imageHashReports.length, missingAssetCount: context.stats.missingAssetCount },
      context.imageHashReports.filter((item) => !item.pass)
    ),
    imageLayerVisual: makePrefabCheck(
      context.imageLayerVisualReports.every((item) => item.pass),
      { imageLayerCount: context.imageLayerVisualReports.length },
      context.imageLayerVisualReports.filter((item) => !item.pass)
    ),
    tmpMaterialPluginData: makePrefabCheck(
      context.tmpMaterialReports.every((item) => item.pass),
      { tmpMaterialTextCount: context.tmpMaterialReports.length },
      context.tmpMaterialReports.filter((item) => !item.pass)
    ),
    textOutlineStroke: makePrefabCheck(
      context.outlineReports.every((item) => item.pass),
      { outlineTextCount: context.outlineReports.length },
      context.outlineReports.filter((item) => !item.pass)
    ),
    nineSliceSourceImageMetadata: makePrefabCheck(
      context.nineSliceReports.every((item) => item.pass),
      { nineSliceCount: context.nineSliceReports.length },
      context.nineSliceReports.filter((item) => !item.pass)
    ),
    unityNodeGeometry: validatePrefabUnityNodeGeometry(context),
    unityNodeOrder: validatePrefabUnityNodeOrder(context),
    unityNodeState: validatePrefabUnityNodeState(context),
    prefabInstanceNodeType: validatePrefabInstances(context),
    prefabInstanceGeometry: validatePrefabInstanceGeometry(context),
    componentModeResult: makePrefabCheck(
      !componentResult || !componentResult.requested || componentResult.created === true,
      { requested: !!(componentResult && componentResult.requested), created: !!(componentResult && componentResult.created), nodeId: componentResult && componentResult.nodeId || topLevelNode.id },
      componentResult && componentResult.requested && !componentResult.created ? [{ reason: "component_not_created" }] : []
    ),
    screenshotAcceptance: makePrefabCheck(
      true,
      { screenshotExported: !!screenshot, skipped: !screenshot },
      []
    ),
    fontConsistency: validatePrefabFontConsistency(topLevelNode, context)
  };
  context.checks = checks;
  for (const checkName of Object.keys(checks)) {
    if (!checks[checkName].pass) {
      addPrefabBlockingError(context, checkName, `${checkName} 楠岃瘉澶辫触`, checks[checkName].details || []);
    }
  }
  return {
    allPass: Object.keys(checks).every((key) => checks[key].pass),
    checkCount: Object.keys(checks).length,
    failedChecks: Object.keys(checks).filter((key) => !checks[key].pass)
  };
}

/** Verify every Unity frame read back from Figma so ordinary layout drift is blocking. */
function validatePrefabUnityNodeReadback(context) {
  context.unityNodeGeometryReports = [];
  context.unityNodeOrderReports = [];
  context.unityNodeStateReports = [];
  const nodes = (context.package && Array.isArray(context.package.nodes)) ? context.package.nodes : [];
  const nodeById = new Map();
  for (const node of nodes) {
    if (node && node.id) {
      nodeById.set(String(node.id), node);
    }
  }
  context.expectedGeometryScaleByUnityId = buildPrefabExpectedGeometryScaleMap(context.package && context.package.root);
  const rootId = context.package && context.package.root && context.package.root.id ? String(context.package.root.id) : "";
  for (const sourceNode of nodes) {
    if (!sourceNode || !sourceNode.id) {
      continue;
    }
    const sourceId = String(sourceNode.id);
    const figmaNode = context.nodeByUnityId.get(sourceId);
    context.unityNodeGeometryReports.push(buildPrefabUnityNodeGeometryReport(figmaNode, sourceNode, context, sourceId === rootId));
    context.unityNodeStateReports.push(buildPrefabUnityNodeStateReport(figmaNode, sourceNode, context, sourceId === rootId));
    const children = getPrefabSourceChildIds(sourceNode);
    if (children.length > 0) {
      context.unityNodeOrderReports.push(buildPrefabUnityNodeOrderReport(figmaNode, sourceNode, nodeById));
    }
  }
}

function buildPrefabExpectedGeometryScaleMap(rootNode) {
  const map = new Map();
  const visit = (sourceNode, inheritedScale) => {
    if (!sourceNode || !sourceNode.id) {
      return;
    }
    const geometryScale = resolvePrefabGeometryScale(inheritedScale);
    map.set(String(sourceNode.id), geometryScale);
    const childGeometryScale = resolvePrefabChildGeometryScale(geometryScale, sourceNode && sourceNode.rect ? sourceNode.rect : {});
    const children = Array.isArray(sourceNode.children) ? sourceNode.children : [];
    for (const child of children) {
      visit(child, childGeometryScale);
    }
  };
  visit(rootNode, { x: 1, y: 1 });
  return map;
}

function buildPrefabUnityNodeGeometryReport(figmaNode, sourceNode, context, isRoot) {
  const rect = sourceNode.rect || {};
  const expectedScale = resolvePrefabExpectedGeometryScale(sourceNode, context);
  const expected = {
    x: numericOr(rect.x, 0) * expectedScale.x,
    y: numericOr(rect.y, 0) * expectedScale.y,
    width: Math.max(0.01, positiveOr(rect.width, 1) * expectedScale.x),
    height: Math.max(0.01, positiveOr(rect.height, 1) * expectedScale.y)
  };
  if (!figmaNode) {
    return {
      pass: false,
      reason: "figma_node_missing",
      unityNodeId: String(sourceNode.id || ""),
      nodePath: sourceNode.path || sourceNode.name || "",
      expected,
      actual: null
    };
  }
  const expectedPosition = resolvePrefabExpectedReadbackPosition(sourceNode, context, expected, isRoot);
  expected.x = expectedPosition.x;
  expected.y = expectedPosition.y;
  const expectedTransform = buildPrefabExpectedRelativeTransform(rect, expected.x, expected.y, expected.width, expected.height);
  if (expectedTransform) {
    const actualTransform = figmaNode.relativeTransform || [];
    const actual = {
      width: positiveOr(figmaNode.width, 0),
      height: positiveOr(figmaNode.height, 0),
      relativeTransform: actualTransform
    };
    const pass = prefabNumberApproximatelyEqual(actual.width, expected.width) &&
      prefabNumberApproximatelyEqual(actual.height, expected.height) &&
      prefabTransformApproximatelyEqual(actualTransform, expectedTransform);
    return {
      pass,
      reason: pass ? "" : "transform_mismatch",
      unityNodeId: String(sourceNode.id || ""),
      figmaNodeId: figmaNode.id,
      nodePath: sourceNode.path || sourceNode.name || "",
      expected: { width: expected.width, height: expected.height, relativeTransform: expectedTransform },
      actual
    };
  }
  const actual = {
    x: expectedPosition.skipPosition ? expected.x : numericOr(figmaNode.x, 0),
    y: expectedPosition.skipPosition ? expected.y : numericOr(figmaNode.y, 0),
    width: positiveOr(figmaNode.width, 0),
    height: positiveOr(figmaNode.height, 0)
  };
  expected.x = expectedPosition.x;
  expected.y = expectedPosition.y;
  const pass = prefabRectApproximatelyEqual(actual, expected);
  return {
    pass,
    reason: pass ? "" : "rect_mismatch",
    unityNodeId: String(sourceNode.id || ""),
    figmaNodeId: figmaNode.id,
    nodePath: sourceNode.path || sourceNode.name || "",
    expected,
    actual
  };
}

function resolvePrefabExpectedGeometryScale(sourceNode, context) {
  const unityNodeId = String(sourceNode && sourceNode.id || "");
  const map = context && context.expectedGeometryScaleByUnityId;
  if (unityNodeId && map && typeof map.get === "function") {
    return resolvePrefabGeometryScale(map.get(unityNodeId));
  }
  return { x: 1, y: 1 };
}

function resolvePrefabExpectedReadbackPosition(sourceNode, context, expected, isRoot) {
  if (!isRoot) {
    return { x: expected.x, y: expected.y, skipPosition: false };
  }
  if (prefabNeedsImportBoundsWrapper(context.package, context.plan)) {
    const rootOffset = resolveImportBoundsRootOffset(sourceNode.rect || {}, context.package.visualBounds || {});
    return { x: rootOffset.x, y: rootOffset.y, skipPosition: false };
  }
  return { x: expected.x, y: expected.y, skipPosition: true };
}

function buildPrefabExpectedRelativeTransform(rect, x, y, width, height) {
  const rotation = numericOr(rect && rect.rotationZ, 0);
  const scaleX = numericOr(rect && rect.scaleX, 1);
  const scaleY = numericOr(rect && rect.scaleY, 1);
  const transformScaleX = scaleX < 0 ? -1 : 1;
  const transformScaleY = scaleY < 0 ? -1 : 1;
  if (Math.abs(rotation) < 0.001 && transformScaleX === 1 && transformScaleY === 1) {
    return null;
  }
  const radians = -rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const cx = width / 2;
  const cy = height / 2;
  const pivotX = x + cx;
  const pivotY = y + cy;
  const a = cos * transformScaleX;
  const b = sin * transformScaleY;
  const c = -sin * transformScaleX;
  const d = cos * transformScaleY;
  return [
    [a, b, pivotX - a * cx - b * cy],
    [c, d, pivotY - c * cx - d * cy]
  ];
}

function buildPrefabUnityNodeStateReport(figmaNode, sourceNode, context, isRoot) {
  const expectedVisible = sourceNode.active !== false;
  const expectedOpacity = resolvePrefabNodeOpacity(sourceNode);
  const expectedClipsContent = !!((sourceNode.clip || {}).enabled) ||
    shouldExpectPrefabRootViewportClip(sourceNode, context, isRoot);
  if (!figmaNode) {
    return {
      pass: false,
      reason: "figma_node_missing",
      unityNodeId: String(sourceNode.id || ""),
      nodePath: sourceNode.path || sourceNode.name || ""
    };
  }
  const actualVisible = figmaNode.visible !== false;
  const actualOpacity = numericOr(figmaNode.opacity, 1);
  const actualClipsContent = "clipsContent" in figmaNode ? !!figmaNode.clipsContent : false;
  const pass = actualVisible === expectedVisible &&
    prefabNumberApproximatelyEqual(actualOpacity, expectedOpacity) &&
    actualClipsContent === expectedClipsContent;
  return {
    pass,
    reason: pass ? "" : "state_mismatch",
    unityNodeId: String(sourceNode.id || ""),
    figmaNodeId: figmaNode.id,
    nodePath: sourceNode.path || sourceNode.name || "",
    expected: { visible: expectedVisible, opacity: expectedOpacity, clipsContent: expectedClipsContent },
    actual: { visible: actualVisible, opacity: actualOpacity, clipsContent: actualClipsContent }
  };
}

function shouldExpectPrefabRootViewportClip(sourceNode, context, isRoot) {
  if (!isRoot || !context || context.isCreatingNestedPrefabComponent === true) {
    return false;
  }
  const canvas = context.package && context.package.canvas ? context.package.canvas : {};
  const rect = sourceNode && sourceNode.rect ? sourceNode.rect : {};
  const canvasWidth = positiveOr(canvas.width, 0);
  const canvasHeight = positiveOr(canvas.height, 0);
  const rectWidth = positiveOr(rect.width, 0);
  const rectHeight = positiveOr(rect.height, 0);
  if (canvasWidth <= 0 || canvasHeight <= 0 || rectWidth <= 0 || rectHeight <= 0) {
    return false;
  }
  return Math.abs(rectWidth - canvasWidth) < 0.5 && Math.abs(rectHeight - canvasHeight) < 0.5;
}

function buildPrefabUnityNodeOrderReport(figmaNode, sourceNode, nodeById) {
  const expected = getPrefabSourceChildIds(sourceNode).filter((childId) => nodeById.has(String(childId)));
  if (!figmaNode || !Array.isArray(figmaNode.children)) {
    return {
      pass: false,
      reason: "figma_node_missing_or_not_container",
      unityNodeId: String(sourceNode.id || ""),
      nodePath: sourceNode.path || sourceNode.name || "",
      expected,
      actual: []
    };
  }
  const actual = [];
  for (const childNode of figmaNode.children) {
    if (!childNode || typeof childNode.getSharedPluginData !== "function" || !isPrefabUnityContainerNode(childNode)) {
      continue;
    }
    const childUnityId = childNode.getSharedPluginData(PrefabToFigmaNamespace, "unityNodeId");
    if (!childUnityId || String(childUnityId) === String(sourceNode.id || "") || !nodeById.has(String(childUnityId))) {
      continue;
    }
    actual.push(String(childUnityId));
  }
  const pass = arraysEqual(expected, actual);
  return {
    pass,
    reason: pass ? "" : "child_order_mismatch",
    unityNodeId: String(sourceNode.id || ""),
    figmaNodeId: figmaNode.id,
    nodePath: sourceNode.path || sourceNode.name || "",
    expected,
    actual
  };
}

function getPrefabSourceChildIds(sourceNode) {
  const unityChildren = sourceNode && sourceNode.unity && Array.isArray(sourceNode.unity.children) ? sourceNode.unity.children : null;
  if (unityChildren) {
    return unityChildren.map((childId) => String(childId || "")).filter(Boolean);
  }
  return (sourceNode && Array.isArray(sourceNode.children) ? sourceNode.children : [])
    .map((child) => String(child && child.id || ""))
    .filter(Boolean);
}

function validatePrefabUnityNodeGeometry(context) {
  const reports = context.unityNodeGeometryReports || [];
  const mismatches = reports.filter((item) => !item.pass);
  return makePrefabCheck(
    reports.length === ((context.package.nodes || []).length) && mismatches.length === 0,
    { checkedCount: reports.length, mismatchCount: mismatches.length },
    mismatches
  );
}

function validatePrefabUnityNodeOrder(context) {
  const reports = context.unityNodeOrderReports || [];
  const mismatches = reports.filter((item) => !item.pass);
  return makePrefabCheck(
    mismatches.length === 0,
    { checkedParentCount: reports.length, mismatchCount: mismatches.length },
    mismatches
  );
}

function validatePrefabUnityNodeState(context) {
  const reports = context.unityNodeStateReports || [];
  const mismatches = reports.filter((item) => !item.pass);
  return makePrefabCheck(
    reports.length === ((context.package.nodes || []).length) && mismatches.length === 0,
    { checkedCount: reports.length, mismatchCount: mismatches.length },
    mismatches
  );
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (String(a[i]) !== String(b[i])) {
      return false;
    }
  }
  return true;
}

/** PrefabInstance 鍒濈増鍙仛纭棬绂侊紝涓嶇敤 Frame 鍗犱綅浼 Instance銆?*/
function validatePrefabInstances(context) {
  const prefabInstances = getPlannedPrefabInstances(context);
  if (!Array.isArray(prefabInstances) || prefabInstances.length === 0) {
    const skippedCount = (context.plan.operations && Array.isArray(context.plan.operations.skippedPrefabInstances))
      ? context.plan.operations.skippedPrefabInstances.length
      : 0;
    return makePrefabCheck(true, { prefabInstanceCount: 0, instanceCount: 0, autoCreatedComponentCount: 0, skippedPrefabInstanceCount: skippedCount }, []);
  }
  const reports = context.prefabInstanceReports || [];
  const instanceCount = reports.filter((item) => item.instanceNodeType === "INSTANCE").length;
  const frameCount = reports.filter((item) => item.instanceNodeType === "FRAME" && item.renderMode === "frame").length;
  const missingPlaceholderCount = reports.filter((item) => item.instanceNodeType === "FRAME" && item.renderMode === "missing").length;
  const autoCreatedComponentCount = (context.nestedComponentReports || []).filter((item) => item.pass).length;
  const pass = reports.length === prefabInstances.length && reports.every((item) => item.pass);
  return makePrefabCheck(
    pass,
    { prefabInstanceCount: prefabInstances.length, instanceCount, frameCount, missingPlaceholderCount, autoCreatedComponentCount },
    reports.concat(context.nestedComponentReports || [])
  );
}

/** Verify prefab instance read-back geometry so layout drift cannot pass as long as node type is INSTANCE. */
function validatePrefabInstanceGeometry(context) {
  const planned = getPlannedPrefabInstances(context);
  const reports = context.prefabInstanceGeometryReports || [];
  if (!Array.isArray(planned) || planned.length === 0) {
    return makePrefabCheck(true, { prefabInstanceCount: 0, checkedCount: 0, mismatchCount: 0 }, []);
  }
  const mainInstanceIds = new Set((context.prefabInstanceReports || [])
    .map((item) => String(item && item.instanceNodeId || ""))
    .filter(Boolean));
  const mainReports = reports.filter((item) => mainInstanceIds.has(String(item && item.instanceNodeId || "")));
  const mismatchReports = mainReports.filter((item) => !item.pass);
  const missingCount = Math.max(0, planned.length - mainReports.length);
  return makePrefabCheck(
    mainReports.length >= planned.length && missingCount === 0 && mismatchReports.length === 0,
    {
      prefabInstanceCount: planned.length,
      checkedCount: mainReports.length,
      nestedCheckedCount: Math.max(0, reports.length - mainReports.length),
      mismatchCount: mismatchReports.length,
      missingCount
    },
    mismatchReports
  );
}

/** 妫€鏌ュ鍏ユ枃鏈妭鐐圭殑瀛椾綋涓庢枃浠舵娴嬪埌鐨勫亸濂藉瓧浣撲竴鑷淬€?
    濡傛灉鏂囨湰鑺傜偣浣跨敤浜?JSON 涓殑 sourceFontFamily锛堝 GROBOLD锛夛紝瑙嗕负鍚堟硶锛屼笉鏍囪涓?mismatch銆?*/
function validatePrefabFontConsistency(topLevelNode, context) {
  if (!context.fileFont) {
    return makePrefabCheck(true, { reason: "no_file_font_detected" }, []);
  }
  const textNodes = [];
  if ("findAll" in topLevelNode) {
    topLevelNode.findAll(n => {
      if (n.type === "TEXT" && !hasPrefabAncestorType(n, "INSTANCE", topLevelNode)) {
        textNodes.push(n);
      }
      return false;
    });
  }
  if (textNodes.length === 0) {
    return makePrefabCheck(true, { reason: "no_text_nodes", detectedFont: context.fileFont }, []);
  }
  // 鏀堕泦鎵€鏈?sourceFontFamily 浣滀负鍚堟硶瀛椾綋锛堜粠 context 涓凡浣跨敤鐨勫瓧浣撹褰曪級
  var allowedFamilies = context.allowedFontFamilies || {};
  var hasAllowed = Object.keys(allowedFamilies).length > 0;
  const mismatches = [];
  for (var i = 0; i < textNodes.length; i++) {
    var tn = textNodes[i];
    var fn = tn.fontName;
    if (!fn) continue;
    var isFileFont = (fn.family === context.fileFont.family && fn.style === context.fileFont.style);
    var isAllowedFont = hasAllowed && allowedFamilies[fn.family + "/" + fn.style];
    if (!isFileFont && !isAllowedFont) {
      mismatches.push({ nodeId: tn.id, nodeName: tn.parent.name || "", font: fn.family + " " + fn.style, expected: context.fileFont.family + " " + context.fileFont.style });
    }
  }
  const pass = mismatches.length === 0 && textNodes.length > 0;
  return makePrefabCheck(pass, { textNodeCount: textNodes.length, detectedFont: context.fileFont, mismatchCount: mismatches.length }, mismatches);
}

/** 判断节点祖先链中是否存在指定类型，用于跳过复用组件内部文本。 */
function hasPrefabAncestorType(node, type, stopNode) {
  var current = node && node.parent ? node.parent : null;
  while (current && current !== stopNode) {
    if (current.type === type) {
      return true;
    }
    current = current.parent || null;
  }
  return false;
}

/** 鏋勫缓宓屽 Prefab 鍙鐢ㄧ粍浠跺€欓€夊悕銆?*/
/** 涓哄祵濂?Prefab 鍒涘缓鐪熷疄 Figma Instance锛岀姝㈢敤 Frame 鍗犱綅浼銆?*/
async function appendPrefabInstanceNodes(topLevelNode, context) {
  const prefabInstances = getPlannedPrefabInstances(context);
  if (!Array.isArray(prefabInstances) || prefabInstances.length === 0) {
    context.prefabInstanceReports = [];
    context.stats.prefabInstanceCount = 0;
    return;
  }
  const reports = [];
  const prefabParentIds = buildPrefabInstanceParentIdSet(prefabInstances);
  for (const item of prefabInstances) {
    const sourcePrefab = item.sourcePrefab || {};
    const candidates = buildPrefabInstanceCandidateNames(sourcePrefab);
    const variantKey = buildPrefabInstanceVariantKey(item);
    const renderMode = resolvePrefabInstanceRenderMode(item, context);
    const instanceOverride = item.instanceOverride || {};
    const parentResolution = resolvePrefabInstanceParent(instanceOverride, topLevelNode, context);
    const parent = parentResolution.node;
    const report = {
      sourceGuid: sourcePrefab.guid || "",
      sourcePrefabAssetPath: sourcePrefab.assetPath || "",
      candidates,
      renderMode,
      parentRectId: parentResolution.parentRectId,
      parentResolved: parentResolution.parentResolved,
      parentFallbackToTopLevel: parentResolution.parentFallbackToTopLevel,
      parentNodeId: parentResolution.parentNodeId,
      parentNodeName: parentResolution.parentNodeName,
      parentNodeType: parentResolution.parentNodeType,
      pass: false
    };
    if (renderMode === "missing") {
      const placeholder = createMissingNestedPrefabPlaceholder(sourcePrefab, parent, instanceOverride, context, item);
      report.instanceNodeId = placeholder ? placeholder.id : "";
      report.instanceNodeName = placeholder ? placeholder.name : "";
      report.instanceNodeType = placeholder ? placeholder.type : "";
      registerPrefabInstanceStrippedRectAliases(placeholder, item, context, report);
      report.geometry = placeholder ? applyPrefabInstanceGeometry(placeholder, parent, instanceOverride, placeholder, sourcePrefab, context, variantKey) || {} : {};
      if (placeholder) {
        context.prefabInstanceGeometryReports.push(buildPrefabInstanceGeometryReport(placeholder, instanceOverride, report.geometry, report));
      }
      report.missingNestedPrefab = true;
      report.missingReason = String(item.missingReason || "source_prefab_asset_not_found");
      report.pass = !!placeholder && placeholder.type === "FRAME" && report.parentResolved === true;
      report.reason = report.pass ? "missing_nested_prefab_placeholder_created" : (report.parentResolved ? "missing_nested_prefab_placeholder_not_created" : "parent_rect_not_resolved");
      reports.push(report);
      continue;
    }
    if (renderMode === "frame") {
      const frame = await createNestedPrefabFrameInstance(sourcePrefab, parent, instanceOverride, context, variantKey);
      report.instanceNodeId = frame ? frame.id : "";
      report.instanceNodeName = frame ? frame.name : "";
      report.instanceNodeType = frame ? frame.type : "";
      registerPrefabInstanceStrippedRectAliases(frame, item, context, report);
      report.geometry = frame ? applyPrefabInstanceGeometry(frame, parent, instanceOverride, frame, sourcePrefab, context, variantKey) || {} : {};
      if (frame) {
        context.prefabInstanceGeometryReports.push(buildPrefabInstanceGeometryReport(frame, instanceOverride, report.geometry, report));
      }
      report.pass = !!frame && frame.type === "FRAME" && report.parentResolved === true;
      report.reason = report.pass ? "" : (report.parentResolved ? "nested_prefab_frame_not_created" : "parent_rect_not_resolved");
      reports.push(report);
      continue;
    }
    const component = await resolvePrefabInstanceComponent(sourcePrefab, candidates, context, variantKey);
    report.matchedComponentId = component ? component.id : "";
    report.matchedComponentName = component ? component.name : "";
    if (!component || (component.type !== "COMPONENT" && component.type !== "COMPONENT_SET")) {
      report.reason = "matched_component_not_found";
      reports.push(report);
      continue;
    }
    const sourceComponent = component.type === "COMPONENT_SET" && component.defaultVariant ? component.defaultVariant : component;
    const instance = sourceComponent.createInstance();
    const needsChildContainer = prefabInstanceNeedsChildContainer(item, prefabParentIds);
    let prefabNode = instance;
    let geometryReport = null;
    if (needsChildContainer) {
      prefabNode = createPrefabInstanceContainerFrame(parent, instanceOverride, component);
      geometryReport = applyPrefabInstanceGeometry(prefabNode, parent, instanceOverride, sourceComponent, sourcePrefab, context, variantKey);
      instance.name = `${prefabNode.name}__Component`;
      prefabNode.appendChild(instance);
      fitPrefabComponentInstanceInContainer(instance, prefabNode);
      writePrefabPluginData(instance, {
        nodeRole: "prefabInstanceComponent",
        sourcePrefabGuid: sourcePrefab.guid || "",
        sourcePrefabPath: sourcePrefab.assetPath || "",
        sourcePrefabFileId: sourcePrefab.fileID || ""
      });
    } else {
      parent.appendChild(instance);
      instance.name = String(instanceOverride.name || component.name || "PrefabInstance");
      geometryReport = applyPrefabInstanceGeometry(instance, parent, instanceOverride, sourceComponent, sourcePrefab, context, variantKey);
    }
    writePrefabPluginData(prefabNode, {
      nodeRole: "prefabInstance",
      sourcePrefabGuid: sourcePrefab.guid || "",
      sourcePrefabPath: sourcePrefab.assetPath || "",
      sourcePrefabFileId: sourcePrefab.fileID || "",
      parentRectId: String(instanceOverride.parentRectId || ""),
      sourceRectFileId: String(instanceOverride.sourceRectFileId || ""),
      usesChildContainer: needsChildContainer ? "true" : "false"
    });
    markPrefabCreatedNode(prefabNode, context);
    if (needsChildContainer) {
      markPrefabCreatedNode(instance, context);
      report.innerInstanceNodeId = instance.id;
      report.innerInstanceNodeName = instance.name;
      report.innerInstanceNodeType = instance.type;
    }
    report.instanceNodeId = prefabNode.id;
    report.instanceNodeName = prefabNode.name;
    report.instanceNodeType = prefabNode.type;
    report.usesChildContainer = needsChildContainer;
    registerPrefabInstanceStrippedRectAliases(prefabNode, item, context, report);
    report.geometry = geometryReport || {};
    context.prefabInstanceGeometryReports.push(buildPrefabInstanceGeometryReport(prefabNode, instanceOverride, report.geometry, report));
    report.pass = (needsChildContainer ? prefabNode.type === "FRAME" : prefabNode.type === "INSTANCE") && report.parentResolved === true;
    report.reason = report.pass ? "" : (report.parentResolved ? (needsChildContainer ? "created_container_is_not_frame" : "created_node_is_not_instance") : "parent_rect_not_resolved");
    reports.push(report);
  }
  context.prefabInstanceReports = reports;
  context.stats.prefabInstanceCount = reports.length;
}

function buildPrefabInstanceGeometryReport(node, instanceOverride, geometryReport, instanceReport) {
  const expected = resolvePrefabInstanceExpectedGeometry(instanceOverride, geometryReport);
  const actual = {
    x: numericOr(node && node.x, 0),
    y: numericOr(node && node.y, 0),
    width: positiveOr(node && node.width, 0),
    height: positiveOr(node && node.height, 0)
  };
  const deltas = {
    x: Math.abs(actual.x - expected.x),
    y: Math.abs(actual.y - expected.y),
    width: Math.abs(actual.width - expected.width),
    height: Math.abs(actual.height - expected.height)
  };
  const tolerance = 0.5;
  const parentResolved = instanceReport ? instanceReport.parentResolved === true : true;
  const pass = parentResolved && deltas.x <= tolerance && deltas.y <= tolerance &&
    deltas.width <= tolerance && deltas.height <= tolerance;
  return {
    sourceGuid: instanceReport && instanceReport.sourceGuid || "",
    sourcePrefabAssetPath: instanceReport && instanceReport.sourcePrefabAssetPath || "",
    instanceNodeId: node && node.id || "",
    instanceNodeName: node && node.name || "",
    instanceNodeType: node && node.type || "",
    parentRectId: instanceReport && instanceReport.parentRectId || "",
    parentResolved,
    parentFallbackToTopLevel: instanceReport ? instanceReport.parentFallbackToTopLevel === true : false,
    parentNodeId: instanceReport && instanceReport.parentNodeId || "",
    parentNodeName: instanceReport && instanceReport.parentNodeName || "",
    parentNodeType: instanceReport && instanceReport.parentNodeType || "",
    mode: String((geometryReport || {}).mode || ""),
    pass,
    tolerance,
    expected,
    actual,
    deltas
  };
}

function resolvePrefabInstanceExpectedGeometry(instanceOverride, geometryReport) {
  const geometry = geometryReport || {};
  if (geometry.mode && typeof geometry.x !== "undefined" && typeof geometry.y !== "undefined") {
    return {
      x: numericOr(geometry.x, 0),
      y: numericOr(geometry.y, 0),
      width: positiveOr(geometry.width, 1),
      height: positiveOr(geometry.height, 1)
    };
  }
  const rect = (instanceOverride && instanceOverride.rect) || {};
  return {
    x: numericOr(rect.x, 0),
    y: numericOr(rect.y, 0),
    width: positiveOr(rect.width, 1),
    height: positiveOr(rect.height, 1)
  };
}

function normalizeNestedPrefabComponentMode(value) {
  const mode = String(value || "");
  if (mode === "commonOnly" || mode === "none") {
    return mode;
  }
  return "all";
}

function getPlannedPrefabInstances(context) {
  const operations = context.plan && context.plan.operations ? context.plan.operations : {};
  const writes = Array.isArray(operations.prefabInstanceWrites) ? operations.prefabInstanceWrites : null;
  if (writes) {
    return writes.map((item) => ({
      fileId: item.fileId || "",
      sourcePrefab: item.sourcePrefab || {
        guid: item.sourceGuid || "",
        assetPath: item.sourcePrefabAssetPath || "",
        assetExists: item.sourcePrefabAssetExists
      },
      hasModification: !!item.hasModification,
      instanceOverride: item.instanceOverride || {},
      strippedRectTransformIds: item.strippedRectTransformIds || [],
      renderMode: item.renderMode || "",
      missingNestedPrefab: item.missingNestedPrefab === true,
      missingReason: item.missingReason || "",
      requiredAction: item.requiredAction || ""
    }));
  }
  const prefabInstances = context.package.prefabInstances || [];
  if (!Array.isArray(prefabInstances)) {
    return [];
  }
  if (context.nestedPrefabComponentMode === "none") {
    return [];
  }
  if (context.nestedPrefabComponentMode !== "commonOnly") {
    return prefabInstances;
  }
  return prefabInstances.filter((item) => isCommonPrefabInstance(item));
}

function resolvePrefabInstanceRenderMode(item, context) {
  if ((item || {}).missingNestedPrefab === true || String((item || {}).renderMode || "") === "missing") {
    return "missing";
  }
  if (String((item || {}).renderMode || "") === "frame") {
    return "frame";
  }
  if (context.nestedPrefabComponentMode === "none") {
    return "frame";
  }
  if (context.nestedPrefabComponentMode === "commonOnly" && !isCommonPrefabInstance(item)) {
    return "frame";
  }
  return "component";
}

function isCommonPrefabInstance(item) {
  const sourcePrefab = item && item.sourcePrefab ? item.sourcePrefab : {};
  const instanceOverride = item && item.instanceOverride ? item.instanceOverride : {};
  const names = [
    sourcePrefab.name || "",
    prefabBaseName(sourcePrefab.assetPath || ""),
    instanceOverride.name || ""
  ];
  return names.some((name) => isHierarchySourceCommonPrefabName(name));
}

function isHierarchySourceCommonPrefabName(name) {
  const normalized = String(name || "").trim().replace(/^\[|\]$/g, "");
  return /^(Common_|Common-|CommonPrefab_|Common_Prefab_|KaTong|KaTone)/.test(normalized);
}

function prefabBaseName(assetPath) {
  const fileName = String(assetPath || "").split(/[\\/]/).pop() || "";
  return fileName.replace(/\.prefab$/i, "");
}

/** 查找或自动创建嵌套 Prefab 对应的 Figma Component。 */
async function resolvePrefabInstanceComponent(sourcePrefab, candidates, context, variantKey) {
  const guid = String(sourcePrefab.guid || "").toLowerCase();
  const cacheKey = variantKey || guid;
  if (cacheKey && context.prefabComponentByGuid.has(cacheKey)) {
    return context.prefabComponentByGuid.get(cacheKey);
  }
  const nestedPackage = findNestedPrefabPackage(context.package, guid, String(sourcePrefab.assetPath || ""), variantKey);
  const expectedSignature = buildNestedPrefabComponentSignature(nestedPackage);
  // 先在全文件（含资源库 page）搜索已有 Component，优先复用而不是自建。
  // 命中的资源库手工组件没有 auto 标记，prefabComponentMatchesSignature 会直接判匹配。
  const allComponents = figma.root.findAll((node) => node.type === "COMPONENT" || node.type === "COMPONENT_SET");
  let component = findPrefabComponentByCandidates(allComponents, candidates, guid, expectedSignature);
  if (component && shouldRecreateAutoNestedPrefabComponent(component, expectedSignature)) {
    // 仅当命中的是旧的自动组件且几何签名不符时才丢弃重建；手工/资源库组件不受影响。
    reportIgnoredAutoNestedPrefabComponent(component, sourcePrefab, context);
    component = null;
  }
  // 文件内没有可复用组件时，才用导出包内嵌的子 Prefab package 自动创建。
  if (!component && nestedPackage && nestedPackage.root) {
    component = await createNestedPrefabComponent(sourcePrefab, context, variantKey);
  }
  if (!component) {
    component = await createNestedPrefabComponent(sourcePrefab, context, variantKey);
  }
  if (cacheKey && component) {
    context.prefabComponentByGuid.set(cacheKey, component);
  }
  return component;
}

/** 当前实例有复杂 override 时，生成与导出端一致的实例专用 package key。 */
function buildPrefabInstanceVariantKey(item) {
  const sourceGuid = String(((item || {}).sourcePrefab || {}).guid || "").toLowerCase();
  const override = (item || {}).instanceOverride || {};
  if (!sourceGuid || override.hasComplexOverride !== true) {
    return "";
  }
  return `${sourceGuid}__override_${String((item || {}).fileId || "")}`;
}

/** 生成当前嵌套 Prefab 的组件几何签名，用于避免复用旧导入遗留组件。 */
function buildNestedPrefabComponentSignature(nestedPackage) {
  if (!nestedPackage || !nestedPackage.root) {
    return null;
  }
  const rootRect = ((nestedPackage.root || {}).rect) || {};
  const visualBounds = nestedPackage.visualBounds || {};
  const needsWrapper = prefabNeedsImportBoundsWrapper(nestedPackage, {});
  return {
    rootRect,
    visualBounds,
    needsWrapper,
    rootOffset: needsWrapper ? resolveImportBoundsRootOffset(rootRect, visualBounds) : { x: 0, y: 0 }
  };
}

function shouldRecreateAutoNestedPrefabComponent(component, expectedSignature) {
  if (!component || !expectedSignature) {
    return false;
  }
  const mode = component.getSharedPluginData(PrefabToFigmaNamespace, "componentMode");
  if (mode !== "auto-created-nested-component") {
    return false;
  }
  return !prefabComponentMatchesSignature(component, expectedSignature);
}

function reportIgnoredAutoNestedPrefabComponent(component, sourcePrefab, context) {
  context.nestedComponentReports.push({
    sourceGuid: String(sourcePrefab.guid || "").toLowerCase(),
    sourcePrefabAssetPath: sourcePrefab.assetPath || "",
    componentId: component.id,
    componentName: component.name,
    pass: true,
    reason: "ignored_stale_auto_component"
  });
}

/** 褰撴枃浠跺唴娌℃湁鐜版垚缁勪欢鏃讹紝浣跨敤瀵煎嚭鍖呭唴宓岀殑瀛?Prefab package 鑷姩鍒涘缓 Component銆?*/
async function createNestedPrefabComponent(sourcePrefab, context, variantKey) {
  const guid = String(sourcePrefab.guid || "").toLowerCase();
  const cycleKey = String(variantKey || guid || "");
  if (cycleKey && context.creatingNestedPrefabGuids && context.creatingNestedPrefabGuids.has(cycleKey)) {
    context.nestedComponentReports.push({
      sourceGuid: guid,
      sourcePrefabAssetPath: sourcePrefab.assetPath || "",
      pass: false,
      reason: "nested_prefab_cycle_guard"
    });
    return null;
  }
  if (numericOr(context.nestedPrefabComponentDepth, 0) >= 3) {
    context.nestedComponentReports.push({
      sourceGuid: guid,
      sourcePrefabAssetPath: sourcePrefab.assetPath || "",
      pass: false,
      reason: "nested_prefab_depth_limit"
    });
    return null;
  }
  const nestedPackage = findNestedPrefabPackage(context.package, guid, String(sourcePrefab.assetPath || ""), variantKey);
  if (!nestedPackage || !nestedPackage.root) {
    context.nestedComponentReports.push({
      sourceGuid: guid,
      sourcePrefabAssetPath: sourcePrefab.assetPath || "",
      pass: false,
      reason: "missing_nested_package"
    });
    return null;
  }

  const originalPackage = context.package;
  const originalPlan = context.plan;
  const originalIsCreatingNestedPrefabComponent = context.isCreatingNestedPrefabComponent === true;
  const originalDepth = numericOr(context.nestedPrefabComponentDepth, 0);
  const previousIds = new Map(context.nodeByUnityId);
  context.package = nestedPackage;
  context.isCreatingNestedPrefabComponent = true;
  context.nestedPrefabComponentDepth = originalDepth + 1;
  if (cycleKey && context.creatingNestedPrefabGuids) {
    context.creatingNestedPrefabGuids.add(cycleKey);
  }
  context.plan = {
    root: {
      needsImportBoundsWrapper: prefabNeedsImportBoundsWrapper(nestedPackage, {})
    }
  };

  let frame = null;
  try {
    frame = await createNestedPrefabComponentFrame(context);
    if (!frame || frame.type !== "FRAME") {
      throw new Error(`nested prefab root is not FRAME: ${frame && frame.type}`);
    }
    placeAutoNestedPrefabFrame(frame, context);
    if (Array.isArray(nestedPackage.prefabInstances) && nestedPackage.prefabInstances.length > 0) {
      await promiseWithTimeout(appendPrefabInstanceNodes(frame, context), 30000, "nested appendPrefabInstanceNodes timeout");
    }
    const componentName = resolveNestedPrefabComponentName(sourcePrefab, nestedPackage, frame.name);
    const component = figma.createComponentFromNode(frame);
    component.name = variantKey ? `${componentName}__${String(variantKey).split("__override_").pop()}` : componentName;
    const nestedRootRect = ((nestedPackage.root || {}).rect) || {};
    const nestedVisualBounds = nestedPackage.visualBounds || {};
    const nestedNeedsWrapper = prefabNeedsImportBoundsWrapper(nestedPackage, {});
    const nestedRootOffset = nestedNeedsWrapper ? resolveImportBoundsRootOffset(nestedRootRect, nestedVisualBounds) : { x: 0, y: 0 };
    markPrefabMutatedNode(component, context);
    writePrefabPluginData(component, {
      nodeRole: "prefabComponent",
      componentMode: "auto-created-nested-component",
      prefabGuid: String(nestedPackage.prefabGuid || guid),
      prefabPath: String(nestedPackage.prefabPath || sourcePrefab.assetPath || ""),
      prefabVariantKey: String(variantKey || nestedPackage.prefabVariantKey || ""),
      nestedRootRect,
      nestedVisualBounds,
      nestedNeedsWrapper,
      nestedRootOffset
    });
    context.nestedComponentReports.push({
      sourceGuid: guid,
      sourcePrefabAssetPath: sourcePrefab.assetPath || "",
      componentId: component.id,
      componentName: component.name,
      pass: true,
      reason: "created_component_then_instance"
    });
    return component;
  } catch (error) {
    context.nestedComponentReports.push({
      sourceGuid: guid,
      sourcePrefabAssetPath: sourcePrefab.assetPath || "",
      pass: false,
      reason: error instanceof Error ? error.message : String(error)
    });
    if (frame && typeof frame.remove === "function") {
      frame.remove();
    }
    return null;
  } finally {
    context.package = originalPackage;
    context.plan = originalPlan;
    context.isCreatingNestedPrefabComponent = originalIsCreatingNestedPrefabComponent;
    context.nestedPrefabComponentDepth = originalDepth;
    if (cycleKey && context.creatingNestedPrefabGuids) {
      context.creatingNestedPrefabGuids.delete(cycleKey);
    }
    context.nodeByUnityId = previousIds;
  }
}

/** 自动创建嵌套 Prefab 组件时使用 Unity root 作为组件根，避免 ImportBounds 外框改变实例槽位对齐。 */
async function createNestedPrefabComponentFrame(context) {
  const rootSource = context && context.package ? (context.package.root || {}) : {};
  const frame = await createPrefabUnityFrame(rootSource, context);
  frame.clipsContent = false;
  const parent = context && context.importPage ? context.importPage : figma.currentPage;
  parent.appendChild(frame);
  return frame;
}

async function createNestedPrefabFrameInstance(sourcePrefab, parent, instanceOverride, context, variantKey) {
  const guid = String(sourcePrefab.guid || "").toLowerCase();
  const nestedPackage = findNestedPrefabPackage(context.package, guid, String(sourcePrefab.assetPath || ""), variantKey);
  if (!nestedPackage || !nestedPackage.root) {
    context.nestedComponentReports.push({
      sourceGuid: guid,
      sourcePrefabAssetPath: sourcePrefab.assetPath || "",
      pass: false,
      reason: "missing_nested_package_for_frame"
    });
    return null;
  }

  const originalPackage = context.package;
  const originalPlan = context.plan;
  const originalIsCreatingNestedPrefabComponent = context.isCreatingNestedPrefabComponent === true;
  const originalDepth = numericOr(context.nestedPrefabComponentDepth, 0);
  const previousIds = new Map(context.nodeByUnityId);
  context.package = nestedPackage;
  context.isCreatingNestedPrefabComponent = false;
  context.nestedPrefabComponentDepth = originalDepth + 1;
  context.plan = {
    root: {
      needsImportBoundsWrapper: prefabNeedsImportBoundsWrapper(nestedPackage, {})
    }
  };

  let frame = null;
  try {
    frame = await createNestedPrefabComponentFrame(context);
    if (!frame || frame.type !== "FRAME") {
      throw new Error(`nested prefab frame is not FRAME: ${frame && frame.type}`);
    }
    parent.appendChild(frame);
    frame.name = String(instanceOverride.name || resolveNestedPrefabComponentName(sourcePrefab, nestedPackage, frame.name));
    if (Array.isArray(nestedPackage.prefabInstances) && nestedPackage.prefabInstances.length > 0) {
      await promiseWithTimeout(appendPrefabInstanceNodes(frame, context), 30000, "nested frame appendPrefabInstanceNodes timeout");
    }
    writePrefabPluginData(frame, {
      nodeRole: "prefabInstanceFrame",
      sourcePrefabGuid: String(nestedPackage.prefabGuid || guid),
      sourcePrefabPath: String(nestedPackage.prefabPath || sourcePrefab.assetPath || ""),
      sourcePrefabFileId: sourcePrefab.fileID || "",
      parentRectId: String(instanceOverride.parentRectId || ""),
      sourceRectFileId: String(instanceOverride.sourceRectFileId || ""),
      renderMode: "frame"
    });
    markPrefabCreatedNode(frame, context);
    context.nestedComponentReports.push({
      sourceGuid: guid,
      sourcePrefabAssetPath: sourcePrefab.assetPath || "",
      nodeId: frame.id,
      nodeName: frame.name,
      pass: true,
      reason: "created_nested_prefab_frame"
    });
    return frame;
  } catch (error) {
    if (frame && typeof frame.remove === "function") {
      frame.remove();
    }
    context.nestedComponentReports.push({
      sourceGuid: guid,
      sourcePrefabAssetPath: sourcePrefab.assetPath || "",
      pass: false,
      reason: "create_nested_prefab_frame_failed",
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  } finally {
    context.package = originalPackage;
    context.plan = originalPlan;
    context.isCreatingNestedPrefabComponent = originalIsCreatingNestedPrefabComponent;
    context.nestedPrefabComponentDepth = originalDepth;
    context.nodeByUnityId = previousIds;
  }
}

function createMissingNestedPrefabPlaceholder(sourcePrefab, parent, instanceOverride, context, item) {
  const frame = figma.createFrame();
  parent.appendChild(frame);
  frame.name = String(instanceOverride.name || (sourcePrefab && sourcePrefab.name) || "MissingNestedPrefab");
  frame.clipsContent = true;
  frame.fills = [{
    type: "SOLID",
    color: { r: 0.62, g: 0.1, b: 0.1 },
    opacity: 0.18
  }];
  frame.strokes = [{
    type: "SOLID",
    color: { r: 0.86, g: 0.17, b: 0.17 },
    opacity: 0.9
  }];
  frame.strokeWeight = 1;
  frame.dashPattern = [6, 4];
  writePrefabPluginData(frame, {
    nodeRole: "missingNestedPrefabPlaceholder",
    sourcePrefabGuid: sourcePrefab && sourcePrefab.guid || "",
    sourcePrefabPath: sourcePrefab && sourcePrefab.assetPath || "",
    sourcePrefabFileId: sourcePrefab && sourcePrefab.fileID || "",
    missingReason: String((item || {}).missingReason || "source_prefab_asset_not_found"),
    requiredAction: String((item || {}).requiredAction || "create_missing_nested_prefab_placeholder"),
    parentRectId: String(instanceOverride.parentRectId || ""),
    sourceRectFileId: String(instanceOverride.sourceRectFileId || ""),
    renderMode: "missing"
  });
  markPrefabCreatedNode(frame, context);
  return frame;
}

/** 自动创建的子 Prefab 组件放到页面空位，避免和正式导入根节点在 (0,0) 重叠污染截图。 */
function placeAutoNestedPrefabFrame(frame, context) {
  if (!frame || !context || !context.importPage) {
    return;
  }
  const width = positiveOr(frame.width, 1);
  const height = positiveOr(frame.height, 1);
  const placement = resolveAutoNestedPrefabPlacement(context.importPage, context, width, height);
  frame.x = placement.x;
  frame.y = placement.y;
}

/** 为自动创建的子组件按批次横向排布，优先放在主导入节点右侧。 */
function resolveAutoNestedPrefabPlacement(page, context, width, height) {
  const margin = 80;
  const topLevel = context.currentTopLevelNode;
  const startX = topLevel && "x" in topLevel && "width" in topLevel
    ? numericOr(topLevel.x, 0) + positiveOr(topLevel.width, 0) + margin
    : 0;
  const startY = topLevel && "y" in topLevel ? numericOr(topLevel.y, 0) : 0;
  const index = positiveOr(context.autoNestedComponentPlacementCount, 0);
  context.autoNestedComponentPlacementCount = index + 1;

  const columns = 3;
  const column = index % columns;
  const row = Math.floor(index / columns);
  const x = startX + column * (positiveOr(width, 1) + margin);
  const y = startY + row * (positiveOr(height, 1) + margin);
  if (!prefabPagePositionOverlaps(page.children || [], x, y, width, height)) {
    return { x, y };
  }
  return resolvePrefabPageFreePosition(page, width, height, x, y);
}

/** Prefab 写入任务较大时 UI 回包可能丢失，主线程先直接回传结果作为兜底。 */
async function postPrefabWriteResultDirectly(message, result) {
  const job = message && message.job ? message.job : {};
  const relayUrl = String(job.relayUrl || job.bridgeUrl || "").replace(/\/+$/, "");
  const requestId = String(message && message.requestId || "");
  if (!relayUrl || !requestId) {
    return;
  }
  try {
    await promiseWithTimeout(fetch(`${relayUrl}/figma/result`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Figma-Relay-Internal": "plugin-runtime"
      },
      body: JSON.stringify({ requestId, result })
    }), 5000, "Prefab result direct post timeout");
  } catch (error) {
    pluginLogger.warn("Prefab 结果直接回传失败", { error: error && error.message ? error.message : String(error) });
  }
}

/** 浠庝富鍖呴€掑綊鏌ユ壘鎸囧畾 GUID 鎴栬矾寰勭殑宓屽 Prefab package銆?*/
function findNestedPrefabPackage(prefabPackage, guid, assetPath, variantKey) {
  const nested = prefabPackage && prefabPackage.nestedPrefabPackages;
  const normalizedGuid = String(guid || "").toLowerCase();
  const normalizedPath = normalizePrefabPath(assetPath);
  const normalizedVariantKey = String(variantKey || "").toLowerCase();
  if (!nested) {
    return null;
  }
  if (normalizedVariantKey && !Array.isArray(nested) && nested[normalizedVariantKey]) {
    return nested[normalizedVariantKey];
  }
  const values = Array.isArray(nested) ? nested : Object.values(nested);
  for (const item of values) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const itemVariantKey = String(item.prefabVariantKey || "").toLowerCase();
    if (normalizedVariantKey && itemVariantKey === normalizedVariantKey) {
      return item;
    }
  }
  for (const item of values) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const itemGuid = String(item.prefabGuid || "").toLowerCase();
    const itemPath = normalizePrefabPath(item.prefabPath || "");
    if (!normalizedVariantKey && ((normalizedGuid && itemGuid === normalizedGuid) || (normalizedPath && itemPath === normalizedPath))) {
      return item;
    }
    const found = findNestedPrefabPackage(item, normalizedGuid, normalizedPath, normalizedVariantKey);
    if (found) {
      return found;
    }
  }
  return null;
}

function normalizePrefabPath(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

/** 瑙ｆ瀽鑷姩鍒涘缓鐨勫祵濂?Prefab 缁勪欢鍚嶏紝閬垮厤鎶?__ImportBounds 鍖呭洿灞傛毚闇茬粰鐢ㄦ埛銆?*/
function resolveNestedPrefabComponentName(sourcePrefab, nestedPackage, fallbackName) {
  const rootName = String(((nestedPackage || {}).root || {}).name || "").trim();
  if (rootName) {
    return rootName;
  }
  const sourceName = String((sourcePrefab || {}).name || "").trim();
  if (sourceName && !sourceName.endsWith("__ImportBounds")) {
    return sourceName;
  }
  const assetPath = String((sourcePrefab || {}).assetPath || "").trim();
  const fileName = assetPath.split(/[\\/]/).pop() || "";
  const baseName = fileName.replace(/\.prefab$/i, "").trim();
  if (baseName) {
    return baseName;
  }
  return String(fallbackName || "NestedPrefab").replace(/__ImportBounds$/i, "");
}

/** 鎸?PrefabInstance RectTransform override 璁剧疆 Instance 鐨勪綅缃拰灏哄銆?*/
function applyPrefabInstanceGeometry(instance, parent, instanceOverride, component, sourcePrefab, context, variantKey) {
  const explicitRect = instanceOverride.rect || {};
  let rect = explicitRect.width || explicitRect.height ? explicitRect : null;
  if (!rect && instanceOverride.rectTransform) {
    rect = resolvePrefabInstanceRect(instanceOverride.rectTransform, positiveOr(parent.width, 1), positiveOr(parent.height, 1));
  }
  if (!rect) {
    return { mode: "missing_rect" };
  }
  applyPrefabInstanceConstraints(instance, instanceOverride);
  const nestedRect = prefabInstanceHasExplicitRect(instanceOverride)
    ? null
    : resolveNestedPrefabInstanceRect(rect, component, instanceOverride, sourcePrefab, context, variantKey);
  if (nestedRect) {
    instance.x = numericOr(nestedRect.x, 0);
    instance.y = numericOr(nestedRect.y, 0);
    if ("resize" in instance) {
      instance.resize(positiveOr(nestedRect.width, instance.width || 1), positiveOr(nestedRect.height, instance.height || 1));
    }
    return nestedRect.report;
  }
  // 鍒ゆ柇鏄惁涓?stretch-to-fill锛堝瓙鑺傜偣濉弧鐖惰妭鐐癸級锛歳ect 灏哄绛変簬鐖惰妭鐐瑰昂瀵?  // 鑻ョ粍浠堕粯璁ゅ昂瀵歌繙灏忎簬鐖惰妭鐐癸紙濡傚簳閮ㄦ爮锛夛紝涓?resize锛屽彧瀹氫綅鍒扮埗鑺傜偣搴曢儴
  // 判断是否为 stretch-to-fill（子节点填满父节点）
  // 使用相对容差：max(0.5px, 父节点尺寸 * 0.001)
  const relTolerance = 0.001; // 0.1% of parent dimension
  const absTolerance = 0.5;   // absolute minimum for small parents
  const tolX = Math.max(absTolerance, (parent.width || 0) * relTolerance);
  const tolY = Math.max(absTolerance, (parent.height || 0) * relTolerance);
  const isStretchFill = (
    Math.abs(numericOr(rect.x, 0)) < tolX &&
    Math.abs(numericOr(rect.y, 0)) < tolY &&
    Math.abs(rect.width - (parent.width || 0)) < tolX &&
    Math.abs(rect.height - (parent.height || 0)) < tolY
  );
  if (isStretchFill) {
    var instanceW = positiveOr(instance.width, 1);
    var instanceH = positiveOr(instance.height, 1);
    // 缁勪欢榛樿灏哄杩滃皬浜庣埗鑺傜偣 鈫?瑙嗚鍐呭鍥哄畾锛屼笉 resize 楂樺害锛岃创搴曞榻愶紝瀹藉害濉弧鐖惰妭鐐?
    if (instanceH > 0 && instanceH < parent.height * 0.5) {
      instance.x = 0;
      instance.y = Math.max(0, parent.height - instanceH);
      if (instanceW !== parent.width) {
        instance.resize(parent.width, instanceH);
      }
      return { mode: "stretch_fill_keep_visual_height", x: instance.x, y: instance.y, width: instance.width, height: instance.height };
    }
    instance.x = 0;
    instance.y = 0;
    instance.resize(parent.width, parent.height);
    return { mode: "stretch_fill", x: instance.x, y: instance.y, width: instance.width, height: instance.height };
  }
  instance.x = numericOr(rect.x, 0);
  instance.y = numericOr(rect.y, 0);
  if ("resize" in instance) {
    instance.resize(positiveOr(rect.width, instance.width || 1), positiveOr(rect.height, instance.height || 1));
  }
  return { mode: "rect", x: instance.x, y: instance.y, width: instance.width, height: instance.height };
}

function prefabInstanceHasExplicitRect(instanceOverride) {
  const rect = instanceOverride && instanceOverride.rect ? instanceOverride.rect : {};
  return !!(rect.width || rect.height);
}

function applyPrefabInstanceConstraints(instance, instanceOverride) {
  if (!("constraints" in instance)) {
    return;
  }
  const constraints = instanceOverride && instanceOverride.constraints
    ? instanceOverride.constraints
    : rectTransformConstraintsToFigma(instanceOverride && instanceOverride.rectTransform);
  if (!constraints) {
    return;
  }
  instance.constraints = {
    horizontal: normalizePrefabHierarchyConstraint(constraints.horizontal, "CENTER"),
    vertical: normalizePrefabHierarchyConstraint(constraints.vertical, "CENTER")
  };
}

function rectTransformConstraintsToFigma(rectTransform) {
  if (!rectTransform) {
    return null;
  }
  const anchorMin = readPrefabVec2(rectTransform.m_AnchorMin, 0.5, 0.5);
  const anchorMax = readPrefabVec2(rectTransform.m_AnchorMax, anchorMin.x, anchorMin.y);
  return {
    horizontal: unityAnchorAxisToFigmaConstraint(anchorMin.x, anchorMax.x, false),
    vertical: unityAnchorAxisToFigmaConstraint(anchorMin.y, anchorMax.y, true)
  };
}

function unityAnchorAxisToFigmaConstraint(minValue, maxValue, isVertical) {
  if (prefabNumberApproximatelyEqual(minValue, 0) && prefabNumberApproximatelyEqual(maxValue, 1)) {
    return "STRETCH";
  }
  const center = (numericOr(minValue, 0.5) + numericOr(maxValue, 0.5)) * 0.5;
  if (isVertical) {
    if (prefabNumberApproximatelyEqual(center, 1)) return "MIN";
    if (prefabNumberApproximatelyEqual(center, 0)) return "MAX";
  } else {
    if (prefabNumberApproximatelyEqual(center, 0)) return "MIN";
    if (prefabNumberApproximatelyEqual(center, 1)) return "MAX";
  }
  return "CENTER";
}

function normalizePrefabHierarchyConstraint(value, fallback) {
  const normalized = String(value || fallback || "CENTER").toUpperCase();
  return ["MIN", "CENTER", "MAX", "STRETCH"].indexOf(normalized) >= 0 ? normalized : fallback;
}

/** 鑷姩鍒涘缓鐨勫瓙 Prefab 缁勪欢鑻ユ湁 ImportBounds wrapper锛岄渶瑕佺敤 wrapper 鍙嶅悜瀵归綈 Unity 鏍?Rect銆?*/
function resolveNestedPrefabInstanceRect(rect, component, instanceOverride, sourcePrefab, context, variantKey) {
  const bounds = resolveNestedPrefabBounds(component, sourcePrefab, context, variantKey);
  if (!bounds || !bounds.needsWrapper || !bounds.componentUsesWrapper) {
    return null;
  }
  const rootRect = bounds.rootRect;
  const visualBounds = bounds.visualBounds;
  const rootOffset = resolveNestedPrefabPlacementOffset(bounds, rect, instanceOverride);
  const rootWidth = positiveOr(rootRect.width, positiveOr(rect.width, component.width || 1));
  const rootHeight = positiveOr(rootRect.height, positiveOr(rect.height, component.height || 1));
  const scaleX = positiveOr(rect.width, rootWidth) / rootWidth;
  const scaleY = positiveOr(rect.height, rootHeight) / rootHeight;
  const visualX = numericOr(visualBounds.x, 0);
  const visualY = numericOr(visualBounds.y, 0);
  const visualWidth = positiveOr(visualBounds.width, positiveOr(rootWidth, component.width || 1));
  const visualHeight = positiveOr(visualBounds.height, positiveOr(rootHeight, component.height || 1));
  const x = numericOr(rect.x, 0) + visualX * scaleX;
  const y = numericOr(rect.y, 0) + visualY * scaleY;
  const width = visualWidth * scaleX;
  const height = visualHeight * scaleY;
  return {
    x,
    y,
    width,
    height,
    report: {
      mode: rootOffset.mode || "import_bounds_root_aligned",
      source: bounds.source,
      layoutResolvedType: String(((instanceOverride || {}).layoutResolved || {}).type || ""),
      slotRect: rect,
      rootRect,
      visualBounds,
      rootOffset,
      rawRootOffset: bounds.rootOffset,
      rootScale: { x: scaleX, y: scaleY },
      x,
      y,
      width,
      height
    }
  };
}

// 布局系统已经把子 Prefab 放入槽位时，按可视包围盒溢出量对齐，避免 wrapper 左边界替代 Unity 槽位。
function resolveNestedPrefabPlacementOffset(bounds, rect, instanceOverride) {
  const layoutType = String((((instanceOverride || {}).layoutResolved || {}).type) || "");
  if (layoutType === "HorizontalLayoutGroup" || layoutType === "VerticalLayoutGroup" || layoutType === "GridLayoutGroup") {
    const rootOffset = bounds.rootOffset || { x: 0, y: 0 };
    return {
      x: numericOr(rootOffset.x, 0),
      y: numericOr(rootOffset.y, 0),
      mode: "import_bounds_layout_root_aligned"
    };
  }
  const rootOffset = bounds.rootOffset || { x: 0, y: 0 };
  return {
    x: numericOr(rootOffset.x, 0),
    y: numericOr(rootOffset.y, 0),
    mode: "import_bounds_root_aligned"
  };
}

function resolveNestedPrefabBounds(component, sourcePrefab, context, variantKey) {
  const guid = String((sourcePrefab || {}).guid || "").toLowerCase();
  const assetPath = String((sourcePrefab || {}).assetPath || "");
  const nestedPackage = findNestedPrefabPackage(context && context.package, guid, assetPath, variantKey);
  if (nestedPackage && nestedPackage.root) {
    const rootRect = ((nestedPackage.root || {}).rect) || {};
    const visualBounds = nestedPackage.visualBounds || {};
    const needsWrapper = prefabNeedsImportBoundsWrapper(nestedPackage, {});
    return buildNestedPrefabBounds(component, rootRect, visualBounds, needsWrapper, "nested_package");
  }
  if (component && typeof component.getSharedPluginData === "function") {
    const rootRect = readPrefabSharedJson(component, "nestedRootRect");
    const visualBounds = readPrefabSharedJson(component, "nestedVisualBounds");
    const needsWrapper = readPrefabSharedBool(component, "nestedNeedsWrapper");
    if (Object.keys(rootRect).length > 0 && Object.keys(visualBounds).length > 0) {
      return buildNestedPrefabBounds(component, rootRect, visualBounds, needsWrapper, "component_plugin_data");
    }
  }
  return null;
}

function buildNestedPrefabBounds(component, rootRect, visualBounds, needsWrapper, source) {
  const rootOffset = needsWrapper ? resolveImportBoundsRootOffset(rootRect, visualBounds) : { x: 0, y: 0 };
  const componentUsesWrapper = componentLooksLikeImportBoundsWrapper(component, rootRect, visualBounds);
  return {
    rootRect,
    visualBounds,
    rootOffset,
    needsWrapper,
    componentUsesWrapper,
    source
  };
}

function componentLooksLikeImportBoundsWrapper(component, rootRect, visualBounds) {
  if (!component) {
    return false;
  }
  const name = String(component.name || "");
  if (name.endsWith("__ImportBounds")) {
    return true;
  }
  const visualWidth = positiveOr(visualBounds.width, 0);
  const visualHeight = positiveOr(visualBounds.height, 0);
  const rootWidth = positiveOr(rootRect.width, 0);
  const rootHeight = positiveOr(rootRect.height, 0);
  const componentWidth = positiveOr(component.width, 0);
  const componentHeight = positiveOr(component.height, 0);
  if (visualWidth > 0 && visualHeight > 0 &&
    Math.abs(componentWidth - visualWidth) < 0.5 &&
    Math.abs(componentHeight - visualHeight) < 0.5) {
    return true;
  }
  return rootWidth > 0 && rootHeight > 0 &&
    (Math.abs(componentWidth - rootWidth) >= 0.5 || Math.abs(componentHeight - rootHeight) >= 0.5);
}
/** 璇诲彇 SharedPluginData 涓殑 JSON 鍏冩暟鎹€?*/
function readPrefabSharedJson(node, key) {
  if (!node || typeof node.getSharedPluginData !== "function") {
    return {};
  }
  const raw = node.getSharedPluginData(PrefabToFigmaNamespace, key);
  if (!raw) {
    return {};
  }
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : {};
  } catch (error) {
    return {};
  }
}

/** 璇诲彇 SharedPluginData 涓殑甯冨皵鍏冩暟鎹€?*/
function readPrefabSharedBool(node, key) {
  if (!node || typeof node.getSharedPluginData !== "function") {
    return false;
  }
  const raw = node.getSharedPluginData(PrefabToFigmaNamespace, key);
  return raw === "true" || raw === "1";
}

/** 澶嶅埢 Unity RectTransform 鍒?Figma 宸︿笂鍧愭爣鐨勮浆鎹紝鐢ㄤ簬宓屽 PrefabInstance銆?*/
function resolvePrefabInstanceRect(fields, parentWidth, parentHeight) {
  const anchorMin = readPrefabVec2(fields.m_AnchorMin, 0.5, 0.5);
  const anchorMax = readPrefabVec2(fields.m_AnchorMax, anchorMin.x, anchorMin.y);
  const sizeDelta = readPrefabVec2(fields.m_SizeDelta, 0, 0);
  const pivot = readPrefabVec2(fields.m_Pivot, 0.5, 0.5);
  const anchoredPosition = readPrefabVec2(fields.m_AnchoredPosition, 0, 0);
  const localScale = readPrefabVec2(fields.m_LocalScale, 1, 1);
  const spanWidth = (anchorMax.x - anchorMin.x) * parentWidth;
  const spanHeight = (anchorMax.y - anchorMin.y) * parentHeight;
  const baseWidth = spanWidth + sizeDelta.x;
  const baseHeight = spanHeight + sizeDelta.y;
  const pivotX = anchorMin.x * parentWidth + spanWidth * pivot.x + anchoredPosition.x;
  const pivotY = anchorMin.y * parentHeight + spanHeight * pivot.y + anchoredPosition.y;
  const left = pivotX - pivot.x * baseWidth * localScale.x;
  const right = pivotX + (1 - pivot.x) * baseWidth * localScale.x;
  const bottom = pivotY - pivot.y * baseHeight * localScale.y;
  const top = pivotY + (1 - pivot.y) * baseHeight * localScale.y;
  return {
    x: Math.min(left, right),
    y: parentHeight - Math.max(bottom, top),
    width: Math.abs(right - left),
    height: Math.abs(top - bottom)
  };
}

/** 璇诲彇 PrefabInstance override 涓殑浜岀淮鍚戦噺銆?*/
function readPrefabVec2(value, fallbackX, fallbackY) {
  const source = value && typeof value === "object" ? value : {};
  return {
    x: numericOr(source.x, fallbackX),
    y: numericOr(source.y, fallbackY)
  };
}

function buildPrefabInstanceCandidateNames(sourcePrefab) {
  const names = [];
  const assetPath = String(sourcePrefab.assetPath || "");
  const fileName = assetPath.split(/[\\/]/).pop() || "";
  const baseName = fileName.replace(/\.prefab$/i, "");
  for (const name of [sourcePrefab.name, baseName, `${baseName}__ImportBounds`]) {
    if (name && names.indexOf(name) < 0) {
      names.push(String(name));
    }
  }
  return names;
}

/** 鍦ㄥ叏鏂囦欢鑼冨洿鍐呮寜鍊欓€夊悕鎴栧叡浜厓鏁版嵁 GUID 鏌ユ壘 Component銆?*/
function findPrefabComponentByCandidates(components, candidates, sourceGuid, expectedSignature) {
  const guid = String(sourceGuid || "").toLowerCase();
  const guidMatches = [];
  for (const component of components) {
    const storedGuid = component.getSharedPluginData(PrefabToFigmaNamespace, "prefabGuid") ||
      component.getSharedPluginData(PrefabToFigmaNamespace, "spriteGuid");
    if (guid && String(storedGuid || "").toLowerCase() === guid) {
      guidMatches.push(component);
    }
  }
  const guidMatch = selectPrefabComponentMatch(guidMatches, expectedSignature);
  if (guidMatch) {
    return guidMatch;
  }
  const nameMatches = [];
  for (const component of components) {
    if (candidates.indexOf(component.name) >= 0) {
      nameMatches.push(component);
    }
  }
  return selectPrefabComponentMatch(nameMatches, expectedSignature);
}

/** 按当前几何签名选择组件；旧的自动组件签名不一致时跳过并强制重建。 */
function selectPrefabComponentMatch(matches, expectedSignature) {
  if (!matches || matches.length === 0) {
    return null;
  }
  if (!expectedSignature) {
    return matches[0];
  }
  for (const component of matches) {
    if (prefabComponentMatchesSignature(component, expectedSignature)) {
      return component;
    }
  }
  const nonAuto = matches.find((component) =>
    component.getSharedPluginData(PrefabToFigmaNamespace, "componentMode") !== "auto-created-nested-component"
  );
  return nonAuto || null;
}

/** 比较自动组件的 rootRect、visualBounds 和 rootOffset，防止复用旧公式生成的组件。 */
function prefabComponentMatchesSignature(component, expectedSignature) {
  if (!component || !expectedSignature) {
    return false;
  }
  const mode = component.getSharedPluginData(PrefabToFigmaNamespace, "componentMode");
  if (mode !== "auto-created-nested-component") {
    return true;
  }
  const actualRootRect = readPrefabSharedJson(component, "nestedRootRect");
  const actualVisualBounds = readPrefabSharedJson(component, "nestedVisualBounds");
  const actualRootOffset = readPrefabSharedJson(component, "nestedRootOffset");
  const actualNeedsWrapper = readPrefabSharedBool(component, "nestedNeedsWrapper");
  return actualNeedsWrapper === !!expectedSignature.needsWrapper &&
    prefabRectApproximatelyEqual(actualRootRect, expectedSignature.rootRect) &&
    prefabRectApproximatelyEqual(actualVisualBounds, expectedSignature.visualBounds) &&
    prefabPointApproximatelyEqual(actualRootOffset, expectedSignature.rootOffset);
}

function prefabRectApproximatelyEqual(a, b) {
  return prefabNumberApproximatelyEqual(a && a.x, b && b.x) &&
    prefabNumberApproximatelyEqual(a && a.y, b && b.y) &&
    prefabNumberApproximatelyEqual(a && a.width, b && b.width) &&
    prefabNumberApproximatelyEqual(a && a.height, b && b.height);
}

function prefabPointApproximatelyEqual(a, b) {
  return prefabNumberApproximatelyEqual(a && a.x, b && b.x) &&
    prefabNumberApproximatelyEqual(a && a.y, b && b.y);
}

function prefabTransformApproximatelyEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 2 || b.length !== 2) {
    return false;
  }
  for (let row = 0; row < 2; row++) {
    if (!Array.isArray(a[row]) || !Array.isArray(b[row]) || a[row].length !== 3 || b[row].length !== 3) {
      return false;
    }
    for (let col = 0; col < 3; col++) {
      if (!prefabNumberApproximatelyEqual(a[row][col], b[row][col])) {
        return false;
      }
    }
  }
  return true;
}

function prefabNumberApproximatelyEqual(a, b) {
  return Math.abs(numericOr(a, 0) - numericOr(b, 0)) < 0.01;
}

/** 鍒涘缓缁熶竴瀹℃牳 check 瀵硅薄銆?*/
function makePrefabCheck(pass, summary, details) {
  return {
    pass: !!pass,
    summary: summary || {},
    details: Array.isArray(details) ? details : []
  };
}

/** 鏍规嵁闃诲閿欒鍜岀‖闂ㄧ缁撴灉鍐冲畾鏈€缁堢姸鎬併€?*/
function buildPrefabWriteStatus(context) {
  if (context.blockingErrors.length > 0) {
    return "completed_with_errors";
  }
  return "completed";
}

/** 瀵煎嚭鎸囧畾 Figma 鑺傜偣锛屼緵 Unity Prefab 鐢熸垚娴佺▼绂荤嚎娑堣垂銆?*/
async function exportFigmaToPrefabJob(job) {
  const target = job && job.target ? job.target : {};
  const nodeId = target && target.nodeId ? String(target.nodeId) : "";
  if (!nodeId) {
    throw new Error("FIGMA_TO_PREFAB_EXPORT missing target.nodeId");
  }

  const root = await figma.getNodeByIdAsync(nodeId).catch(() => null);
  if (!root) {
    throw new Error(`Figma node not found: ${nodeId}`);
  }
  await setCurrentPageForNode(root);

  const warnings = [];
  const rootBounds = getNodeBounds(root);
  const nodeRecords = [];
  const imageRequests = [];
  await collectFigmaPrefabNodes(root, root, rootBounds, nodeRecords, imageRequests, warnings);

  const imageExportManifest = await exportFigmaPrefabImages(imageRequests, warnings);
  const imageHealthErrors = validateImageExports(imageExportManifest.exports || []);
  applyImageValidationErrors(imageExportManifest.exports || [], imageHealthErrors);
  imageExportManifest.healthSummary = summarizeImageHealth(imageExportManifest.exports || []);
  const blockingErrors = [
    ...imageHealthErrors,
    ...validateFigmaPrefabSlicedExports(imageExportManifest.exports || [])
  ];
  const requestExport = job && job.request && job.request.export ? job.request.export : {};
  const manifestExport = job && job.manifest && job.manifest.export ? job.manifest.export : {};
  const includeScreenshot = requestExport.includeScreenshot !== false
    && manifestExport.includeScreenshot !== false
    && job.includeScreenshot !== false
    && job.exportScreenshot !== false;
  const screenshot = includeScreenshot ? await exportNodePngScreenshot(root) : null;
  const figmaNodeManifest = {
    schemaVersion: 1,
    source: "figma-relay",
    fileKey: figma.fileKey || "",
    documentName: figma.root && figma.root.name ? figma.root.name : "",
    pageName: figma.currentPage.name,
    rootNodeId: root.id,
    rootName: root.name,
    rootBounds: boundsToManifest(rootBounds),
    nodes: nodeRecords
  };

  return {
    status: blockingErrors.length === 0 ? "completed" : "blocked",
    allPass: blockingErrors.length === 0,
    rootNodeId: root.id,
    rootName: root.name,
    createdCount: nodeRecords.length,
    figmaNodeManifest,
    imageExportManifest,
    screenshot,
    warnings,
    blockingErrors,
    errors: []
  };
}

/** 递归收集 Figma 节点树，并转换为相对父节点的数据记录。 */
async function collectFigmaPrefabNodes(node, root, rootBounds, output, imageRequests, warnings, parentId, parentBounds) {
  if (!node || node.removed || node.visible === false || isCleanupRecoveryNode(node)) {
    return;
  }

  const bounds = getNodeBounds(node);
  // 使用 parentBounds 计算相对坐标（而非 rootBounds），确保 Unity 导入时 Y 轴正确
  const refBounds = parentBounds || rootBounds;
  const record = {
    id: node.id,
    parentId: parentId || "",
    name: node.name || "",
    type: node.type,
    path: buildNodePath(node, root),
    visible: node.visible !== false,
    opacity: typeof node.opacity === "number" ? node.opacity : 1,
    bounds: boundsToManifest(bounds),
    relativeBounds: boundsToRelativeManifest(bounds, refBounds),
    fills: serializePaints(node.fills),
    strokes: serializePaints(node.strokes),
    effects: node.type === "TEXT" ? serializeEffects(node.effects) : [],
    constraints: readFigmaPrefabConstraints(node),
    strokeWeight: node.type === "TEXT" ? readFigmaStrokeWeight(node) : 0,
    cornerRadius: typeof node.cornerRadius === "number" ? node.cornerRadius : 0,
    characters: node.type === "TEXT" ? String(node.characters || "") : "",
    fontSize: readFigmaFontSize(node),
    textAlignHorizontal: node.type === "TEXT" ? String(node.textAlignHorizontal || "") : "",
    textAlignVertical: node.type === "TEXT" ? String(node.textAlignVertical || "") : "",
    childIds: []
  };
  const componentInfo = await buildFigmaPrefabComponentInfo(node, warnings);
  if (componentInfo && componentInfo.source) {
    record.component = componentInfo;
  }
  output.push(record);

  const nineSliceInfo = buildFigmaPrefabNineSliceInfo(node);
  if (nineSliceInfo) {
    record.imageType = "Sliced";
    record.border = nineSliceInfo.border;
    record.nineSlice = {
      border: nineSliceInfo.border,
      sliceKind: nineSliceInfo.sliceKind,
      sliceCount: nineSliceInfo.sliceCount,
      minSize: nineSliceInfo.minSize,
      sourceVisibleSize: nineSliceInfo.sourceVisibleSize
    };
  }

  const imageHash = findFirstImageHash(node, !!nineSliceInfo);
  if (imageHash) {
    const request = {
      id: `img_${imageRequests.length}`,
      nodeId: node.id,
      nodePath: record.path,
      source: "imageHash",
      imageHash
    };
    if (nineSliceInfo) {
      Object.assign(request, {
        imageType: "Sliced",
        sliceKind: nineSliceInfo.sliceKind,
        border: nineSliceInfo.border,
        expectedMinSize: nineSliceInfo.minSize,
        sourceVisibleSize: nineSliceInfo.sourceVisibleSize,
        sliceCount: nineSliceInfo.sliceCount
      });
    }
    imageRequests.push(request);
  } else if (nineSliceInfo) {
    const childHash = findNineSliceSourceHash(node);
    if (childHash) {
      warnings.push(`Nine-slice source fallback to slice child: ${record.path || node.id}`);
      imageRequests.push({
        id: `img_${imageRequests.length}`,
        nodeId: node.id,
        nodePath: record.path,
        source: "imageHash",
        imageHash: childHash,
        sourceReason: "sliceFillFallback",
        imageType: "Sliced",
        sliceKind: nineSliceInfo.sliceKind,
        border: nineSliceInfo.border,
        expectedMinSize: nineSliceInfo.minSize,
        sourceVisibleSize: nineSliceInfo.sourceVisibleSize,
        sliceCount: nineSliceInfo.sliceCount
      });
    }
  } else if (shouldExportNodeAsImage(node)) {
    imageRequests.push({
      id: `img_${imageRequests.length}`,
      nodeId: node.id,
      nodePath: record.path,
      source: "nodeExport"
    });
  }

  if ("children" in node && Array.isArray(node.children)) {
    for (const child of node.children) {
      if (child && child.visible !== false && !isCleanupRecoveryNode(child)) {
        record.childIds.push(child.id);
        // 传递当前节点 bounds 作为子节点的 parentBounds
        await collectFigmaPrefabNodes(child, root, rootBounds, output, imageRequests, warnings, node.id, bounds);
      }
    }
  }
}

/** 读取 Figma 原生组件身份，供 Unity 导入时判断本地 ComponentSet。 */
async function buildFigmaPrefabComponentInfo(node, warnings) {
  const info = {
    isComponentSet: node && node.type === "COMPONENT_SET",
    isComponent: node && node.type === "COMPONENT",
    isInstance: node && node.type === "INSTANCE",
    componentSetId: "",
    componentSetName: "",
    componentId: "",
    componentName: "",
    variantProperties: {},
    mainComponentId: "",
    mainComponentName: "",
    mainComponentSetId: "",
    mainComponentSetName: "",
    source: ""
  };

  if (!node) {
    return info;
  }

  if (node.type === "COMPONENT_SET") {
    info.componentSetId = node.id;
    info.componentSetName = node.name || "";
    info.source = "component_set";
    return info;
  }

  if (node.type === "COMPONENT") {
    info.componentId = node.id;
    info.componentName = node.name || "";
    info.variantProperties = clonePlainObject(node.variantProperties);
    if (node.parent && node.parent.type === "COMPONENT_SET") {
      info.componentSetId = node.parent.id;
      info.componentSetName = node.parent.name || "";
    }
    info.source = "component";
    return info;
  }

  if (node.type !== "INSTANCE") {
    return info;
  }

  info.source = "instance";
  try {
    const mainComponent = typeof node.getMainComponentAsync === "function"
      ? await node.getMainComponentAsync()
      : (node.mainComponent || null);
    if (!mainComponent) {
      return info;
    }
    info.mainComponentId = mainComponent.id || "";
    info.mainComponentName = mainComponent.name || "";
    info.componentId = mainComponent.id || "";
    info.componentName = mainComponent.name || "";
    info.variantProperties = clonePlainObject(mainComponent.variantProperties);
    if (mainComponent.parent && mainComponent.parent.type === "COMPONENT_SET") {
      info.mainComponentSetId = mainComponent.parent.id;
      info.mainComponentSetName = mainComponent.parent.name || "";
      info.componentSetId = mainComponent.parent.id;
      info.componentSetName = mainComponent.parent.name || "";
    }
  } catch (error) {
    warnings.push(`Component metadata failed for ${node.name || node.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return info;
}

/** 复制可 JSON 序列化的普通对象，避免 Figma 代理对象污染 manifest。 */
function clonePlainObject(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  const result = {};
  for (const key of Object.keys(value)) {
    const raw = value[key];
    if (raw === undefined || raw === null) {
      result[key] = "";
    } else {
      result[key] = String(raw);
    }
  }
  return result;
}

/** 导出图片资源；优先使用 imageHash 原图，必要时导出节点 PNG。 */
async function exportFigmaPrefabImages(imageRequests, warnings) {
  const exports = [];
  const seenHash = {};
  for (const request of imageRequests) {
    try {
      if (request.source === "imageHash" && request.imageHash) {
        const exportKey = buildFigmaPrefabImageExportKey(request);
        if (seenHash[exportKey]) {
          exports.push(Object.assign({}, request, {
            duplicateOf: seenHash[exportKey],
            byteLength: 0,
            base64: "",
            health: createImageHealth("repaired", "duplicateReused", { sourceExportId: seenHash[exportKey] })
          }));
          continue;
        }
        const image = figma.getImageByHash(request.imageHash);
        if (!image) {
          warnings.push(`Image hash not found: ${request.imageHash}`);
          exports.push(Object.assign({}, request, { width: 0, height: 0, byteLength: 0, base64: "", health: createImageHealth("blocked", "imageHashNotFound") }));
          continue;
        }
        const size = await image.getSizeAsync();
        const exportResult = request.imageType === "Sliced"
          ? await exportMinimumNineSliceImage(request, size, warnings)
          : await exportImageAtFrameSize(request, image, size, warnings);
        seenHash[exportKey] = request.id;
        exports.push(Object.assign({}, request, {
          mimeType: "image/png",
          width: exportResult.width || 0,
          height: exportResult.height || 0,
          byteLength: exportResult.bytes.length,
          base64: bytesToBase64(exportResult.bytes),
          health: createImageHealth(exportResult.fallbackReason ? "repaired" : "healthy", exportResult.fallbackReason || "exported", {
            originalWidth: exportResult.originalWidth,
            originalHeight: exportResult.originalHeight
          })
        }));
        continue;
      }

      const node = await figma.getNodeByIdAsync(request.nodeId).catch(() => null);
      if (!node || !("exportAsync" in node)) {
        warnings.push(`Node cannot export PNG: ${request.nodePath || request.nodeId}`);
        exports.push(Object.assign({}, request, { width: 0, height: 0, byteLength: 0, base64: "", health: createImageHealth("blocked", "nodeCannotExport") }));
        continue;
      }
      const bounds = getNodeBounds(node);
      // contentOnly+SCALE×1 防止投影/描边外扩使 PNG 尺寸超出节点帧尺寸
      const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 }, contentsOnly: true });
      exports.push(Object.assign({}, request, {
        mimeType: "image/png",
        width: Math.round(bounds.width || 0),
        height: Math.round(bounds.height || 0),
        byteLength: bytes.length,
        base64: bytesToBase64(bytes),
        health: createImageHealth("healthy", "exported")
      }));
    } catch (error) {
      warnings.push(`PNG export failed for ${request.nodePath || request.nodeId}: ${error instanceof Error ? error.message : String(error)}`);
      exports.push(Object.assign({}, request, { width: 0, height: 0, byteLength: 0, base64: "", health: createImageHealth("blocked", "exportFailed") }));
    }
  }

  return {
    schemaVersion: 1,
    exports,
    healthSummary: summarizeImageHealth(exports)
  };
}

/** 构建图片去重键，九宫图需要把边框与最小尺寸纳入键。 */

function buildFigmaPrefabImageExportKey(request) {
  if (!request || request.imageType !== "Sliced") {
    return String(request && request.imageHash || "");
  }
  const border = request.border || {};
  const minSize = request.expectedMinSize || {};
  const visibleSize = request.sourceVisibleSize || {};
  return [
    request.imageHash || "",
    "sliced",
    request.sliceKind || "9slice",
    border.left || 0,
    border.bottom || 0,
    border.right || 0,
    border.top || 0,
    minSize.width || 0,
    minSize.height || 0,
    visibleSize.width || 0,
    visibleSize.height || 0
  ].join(":");
}

// 导出 Unity 九宫 Sprite 的最小 PNG，避免把 Figma 可见拉伸大图写入工程。
async function exportMinimumNineSliceImage(request, imageSize, warnings) {
  const border = request.border || {};
  const left = Math.max(0, Math.round(positiveOr(border.left, 0)));
  const right = Math.max(0, Math.round(positiveOr(border.right, 0)));
  const top = Math.max(0, Math.round(positiveOr(border.top, 0)));
  const bottom = Math.max(0, Math.round(positiveOr(border.bottom, 0)));
  const sliceKind = normalizeFigmaPrefabSliceKind(request.sliceKind, border);
  const targetSize = buildFigmaPrefabNineSliceTargetSize(request, border, sliceKind);
  const width = targetSize.width;
  const height = targetSize.height;
  const sourceSize = imageSize || {};
  const sourceWidth = Math.max(width, positiveOr(sourceSize.width, width));
  const sourceHeight = Math.max(height, positiveOr(sourceSize.height, height));

  const frame = figma.createFrame();
  frame.name = `__tmp_min_nine_${safeFileName(request.nodeId || request.id)}`;
  frame.resize(width, height);
  frame.fills = [];
  frame.strokes = [];
  frame.clipsContent = true;
  frame.x = -100000;
  frame.y = -100000;
  figma.currentPage.appendChild(frame);

  const columns = buildFigmaPrefabNineSliceColumns(sliceKind, width, sourceWidth, left, right);
  const rows = buildFigmaPrefabNineSliceRows(sliceKind, height, sourceHeight, top, bottom);

  try {
    for (const column of columns) {
      for (const row of rows) {
        if (column.targetSize <= 0 || row.targetSize <= 0 || column.sourceSize <= 0 || row.sourceSize <= 0) {
          continue;
        }
        const rect = figma.createRectangle();
        rect.name = "__min_slice";
        frame.appendChild(rect);
        rect.x = column.targetStart;
        rect.y = row.targetStart;
        rect.resize(column.targetSize, row.targetSize);
        rect.strokes = [];
        rect.fills = [{
          type: "IMAGE",
          scaleMode: "CROP",
          imageHash: request.imageHash,
          imageTransform: [
            [column.sourceSize / sourceWidth, 0, column.sourceStart / sourceWidth],
            [0, row.sourceSize / sourceHeight, row.sourceStart / sourceHeight]
          ]
        }];
      }
    }
    const bytes = await frame.exportAsync({ format: "PNG" });
    return { width, height, bytes };
  } catch (error) {
    warnings.push(`PNG export failed for ${request.nodePath || request.nodeId}: ${error instanceof Error ? error.message : String(error)}`);
    const image = figma.getImageByHash(request.imageHash);
    return { width: imageSize.width || 0, height: imageSize.height || 0, bytes: await image.getBytesAsync() };
  } finally {
    frame.remove();
  }
}

function normalizeFigmaPrefabSliceKind(sliceKind, border) {
  const value = String(sliceKind || "").toLowerCase();
  if (value === "h3slice" || value === "h3-slice") {
    return "h3slice";
  }
  if (value === "v3slice" || value === "v3-slice") {
    return "v3slice";
  }
  const hasHorizontalBorder = border && border.left > 0 && border.right > 0;
  const hasVerticalBorder = border && border.top > 0 && border.bottom > 0;
  if (hasHorizontalBorder && !hasVerticalBorder) {
    return "h3slice";
  }
  if (!hasHorizontalBorder && hasVerticalBorder) {
    return "v3slice";
  }
  return "9slice";
}

function buildFigmaPrefabNineSliceTargetSize(request, border, sliceKind) {
  const visibleSize = request.sourceVisibleSize || {};
  const minWidth = Math.max(1, Math.round(positiveOr(border.left, 0) + positiveOr(border.right, 0) + 2));
  const minHeight = Math.max(1, Math.round(positiveOr(border.top, 0) + positiveOr(border.bottom, 0) + 2));
  if (sliceKind === "h3slice") {
    return {
      width: minWidth,
      height: Math.max(1, Math.round(positiveOr(visibleSize.height, minHeight)))
    };
  }
  if (sliceKind === "v3slice") {
    return {
      width: Math.max(1, Math.round(positiveOr(visibleSize.width, minWidth))),
      height: minHeight
    };
  }
  return {
    width: minWidth,
    height: minHeight
  };
}

function buildFigmaPrefabNineSliceColumns(sliceKind, targetWidth, sourceWidth, left, right) {
  if (sliceKind === "v3slice") {
    return [{ targetStart: 0, targetSize: targetWidth, sourceStart: 0, sourceSize: sourceWidth }];
  }
  return [
    { targetStart: 0, targetSize: left, sourceStart: 0, sourceSize: left },
    { targetStart: left, targetSize: 2, sourceStart: left, sourceSize: Math.max(1, sourceWidth - left - right) },
    { targetStart: left + 2, targetSize: right, sourceStart: Math.max(0, sourceWidth - right), sourceSize: right }
  ];
}

function buildFigmaPrefabNineSliceRows(sliceKind, targetHeight, sourceHeight, top, bottom) {
  if (sliceKind === "h3slice") {
    return [{ targetStart: 0, targetSize: targetHeight, sourceStart: 0, sourceSize: sourceHeight }];
  }
  return [
    { targetStart: 0, targetSize: top, sourceStart: 0, sourceSize: top },
    { targetStart: top, targetSize: 2, sourceStart: top, sourceSize: Math.max(1, sourceHeight - top - bottom) },
    { targetStart: top + 2, targetSize: bottom, sourceStart: Math.max(0, sourceHeight - bottom), sourceSize: bottom }
  ];
}

function validateFigmaPrefabSlicedExports(exports) {
  const errors = [];
  for (const item of exports || []) {
    if (!item || item.imageType !== "Sliced" || item.duplicateOf) {
      continue;
    }
    const border = item.border || {};
    const sliceKind = normalizeFigmaPrefabSliceKind(item.sliceKind, border);
    const expected = buildFigmaPrefabNineSliceTargetSize(item, border, sliceKind);
    const actualWidth = Math.round(positiveOr(item.width, 0));
    const actualHeight = Math.round(positiveOr(item.height, 0));
    if (actualWidth !== expected.width || actualHeight !== expected.height) {
      errors.push({
        code: "slicedExportSizeMismatch",
        nodeId: item.nodeId || "",
        nodePath: item.nodePath || "",
        sliceKind,
        expectedSize: `${expected.width}x${expected.height}`,
        actualSize: `${actualWidth}x${actualHeight}`
      });
    }
  }
  return errors;
}

/** 导出图片节点在其自身帧尺寸下的渲染结果，而非源图原生分辨率。 */
// 按帧尺寸导出图片；contentOnly + SCALE×1 防止投影/描边外扩导致 PNG > 帧尺寸。
async function exportImageAtFrameSize(request, sourceImage, sourceSize, warnings) {
  let fallbackReason = "frameExportFailed";
  let originalWidth = 0;
  let originalHeight = 0;
  try {
    const node = await figma.getNodeByIdAsync(request.nodeId);
    originalWidth = Number(node && node.width) || 0;
    originalHeight = Number(node && node.height) || 0;
    if (node && "exportAsync" in node && node.width >= 1 && node.height >= 1) {
      const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 }, contentsOnly: true });
      return { width: Math.round(node.width), height: Math.round(node.height), bytes };
    }
    if (node && originalWidth > 0 && originalHeight > 0) fallbackReason = "tinyFrameFallback";
  } catch (e) {
    warnings.push(`Frame-size export failed for ${request.nodePath || request.nodeId}, falling back to source native.`);
  }
  const sourceBytes = await sourceImage.getBytesAsync();
  return {
    width: sourceSize.width || 0,
    height: sourceSize.height || 0,
    bytes: sourceBytes,
    fallbackReason,
    originalWidth,
    originalHeight
  };
}

async function exportNodePngScreenshot(node) {
  if (!node || !("exportAsync" in node)) {
    return null;
  }
  const bounds = getNodeBounds(node);
  const bytes = await node.exportAsync({ format: "PNG" });
  return {
    fileName: `${safeFileName(node.name || "figma_node")}_${node.id.replace(":", "_")}.png`,
    mimeType: "image/png",
    width: Math.round(bounds.width || 0),
    height: Math.round(bounds.height || 0),
    byteLength: bytes.length,
    base64: bytesToBase64(bytes)
  };
}

/** 判断节点是否需要作为整图导出。 */
function shouldExportNodeAsImage(node) {
  if (!node || node.type === "TEXT" || node.type === "PAGE") {
    return false;
  }
  const hasChildren = "children" in node && Array.isArray(node.children) && node.children.length > 0;
  const hasVisiblePaint = hasRenderablePaint(node.fills) || hasRenderablePaint(node.strokes);
  return !hasChildren && hasVisiblePaint && hasPositiveBounds(node);
}

/** 读取节点边界，兼容 absoluteBoundingBox 缺失的节点。 */
function getNodeBounds(node) {
  const bounds = node && node.absoluteBoundingBox ? node.absoluteBoundingBox : null;
  return {
    x: bounds ? bounds.x : 0,
    y: bounds ? bounds.y : 0,
    width: bounds ? bounds.width : (node && node.width ? node.width : 0),
    height: bounds ? bounds.height : (node && node.height ? node.height : 0)
  };
}

function boundsToManifest(bounds) {
  return {
    x: roundNumber(bounds.x),
    y: roundNumber(bounds.y),
    width: roundNumber(bounds.width),
    height: roundNumber(bounds.height)
  };
}

function readFigmaPrefabConstraints(node) {
  if (!node || !("constraints" in node) || !node.constraints) {
    return { horizontal: "CENTER", vertical: "CENTER" };
  }
  return {
    horizontal: normalizePrefabHierarchyConstraint(node.constraints.horizontal, "CENTER"),
    vertical: normalizePrefabHierarchyConstraint(node.constraints.vertical, "CENTER")
  };
}

function boundsToRelativeManifest(bounds, rootBounds) {
  return {
    x: roundNumber(bounds.x - rootBounds.x),
    y: roundNumber(bounds.y - rootBounds.y),
    width: roundNumber(bounds.width),
    height: roundNumber(bounds.height)
  };
}

function buildNodePath(node, root) {
  const names = [];
  let current = node;
  while (current && current.id !== root.id) {
    names.unshift(current.name || current.id);
    current = current.parent;
  }
  names.unshift(root.name || root.id);
  return names.join("/");
}

function readFigmaFontSize(node) {
  if (!node || node.type !== "TEXT" || typeof node.fontSize !== "number") {
    return 0;
  }
  return node.fontSize;
}

/** 读取文本描边粗细，供 Unity TMP 材质近似还原描边。 */
function readFigmaStrokeWeight(node) {
  if (!node || node.type !== "TEXT" || typeof node.strokeWeight !== "number") {
    return 0;
  }
  return roundNumber(node.strokeWeight);
}

/** 构建层级整理错误结果，保持 Relay 返回结构稳定。 */
function buildHierarchyCleanupErrorResult(error, stage) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: "error",
    allPass: false,
    blockingErrors: [{
      code: "hierarchyCleanupPluginException",
      message: `Figma 层级整理 ${stage} 阶段发生异常。`,
      details: { error: message }
    }],
    warnings: [],
    summary: {},
    checks: {},
    artifacts: {},
    errors: [message]
  };
}

/** 执行层级整理只读分析，不修改 Figma 文档。 */
async function analyzeFigmaHierarchyCleanupJob(job) {
  const target = job && job.target ? job.target : {};
  const options = job && job.options ? job.options : {};
  const nodeId = String(target.nodeId || "");
  if (!nodeId) {
    throw new Error("FIGMA_HIERARCHY_CLEANUP_ANALYZE missing target.nodeId");
  }

  const root = await figma.getNodeByIdAsync(nodeId).catch(() => null);
  if (!root) {
    throw new Error(`Figma node not found: ${nodeId}`);
  }
  if (!("children" in root)) {
    throw new Error(`Figma node has no children: ${root.type}`);
  }

  await setCurrentPageForNode(root);
  const includeHidden = !!options.includeHidden;
  const includeScreenshot = options.includeScreenshot !== false;
  const maxDepth = positiveOr(options.maxDepth, 8);
  const rootBounds = getNodeBounds(root);
  const directChildren = collectHierarchyDirectChildren(root, rootBounds, includeHidden);
  const nodes = [];
  collectHierarchyCleanupNodes(root, root, rootBounds, nodes, includeHidden, maxDepth, 0, "");
  const screenshot = includeScreenshot ? await exportNodePngScreenshot(root) : null;
  const topLevelGroups = collectHierarchyTopLevelGroups(root);

  return {
    status: "completed",
    allPass: true,
    rootNodeId: root.id,
    rootName: root.name || "",
    nodeType: root.type,
    fileKey: figma.fileKey || "",
    documentName: figma.root && figma.root.name ? figma.root.name : "",
    pageName: figma.currentPage.name,
    rootBounds: boundsToManifest(rootBounds),
    directChildCount: directChildren.length,
    directChildren,
    nodes,
    topLevelGroups,
    screenshot,
    blockingErrors: [],
    warnings: [],
    summary: {
      rootNodeId: root.id,
      rootName: root.name || "",
      directChildCount: directChildren.length,
      nodeCount: nodes.length,
      topLevelGroupCount: topLevelGroups.length
    },
    checks: {
      rootHasChildren: { pass: directChildren.length > 0 },
      screenshotExported: { pass: !!screenshot || !includeScreenshot }
    },
    artifacts: {
      analyzedAt: new Date().toISOString()
    }
  };
}

/** Analyze repeat-like hierarchy candidates without modifying the Figma document. */
async function handleFigmaHierarchyRepeatClusterAnalyze(message) {
  try {
    const result = await analyzeFigmaHierarchyRepeatClusterJob(message.job || {});
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_REPEAT_CLUSTER_ANALYZE_RESULT",
      requestId: message.requestId,
      result
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_REPEAT_CLUSTER_ANALYZE_RESULT",
      requestId: message.requestId,
      result: buildHierarchyCleanupErrorResult(error, "repeatClusterAnalyze")
    });
  }
}

async function analyzeFigmaHierarchyRepeatClusterJob(job) {
  const target = job && job.target ? job.target : {};
  const options = job && job.options ? job.options : {};
  const nodeId = String(target.nodeId || "");
  if (!nodeId) {
    throw new Error("FIGMA_HIERARCHY_REPEAT_CLUSTER_ANALYZE missing target.nodeId");
  }

  const root = await figma.getNodeByIdAsync(nodeId).catch(() => null);
  if (!root) {
    throw new Error(`Figma node not found: ${nodeId}`);
  }
  if (!("children" in root)) {
    throw new Error(`Figma node has no children: ${root.type}`);
  }

  await setCurrentPageForNode(root);
  const includeHidden = !!options.includeHidden;
  const maxDepth = positiveOr(options.maxDepth, 4);
  const confidenceThreshold = Math.max(0, Math.min(1, numericOr(options.confidenceThreshold, 0.85)));
  const rootBounds = getNodeBounds(root);
  const records = [];
  collectHierarchyRepeatClusterRecords(root, root, rootBounds, records, includeHidden, maxDepth, 0);
  const childRecords = records.filter((record) => record.id !== root.id);
  const result = detectHierarchyRepeatCluster(childRecords, {
    confidenceThreshold,
    expectedXCount: positiveOr(options.expectedXCount, 7),
    expectedYCount: positiveOr(options.expectedYCount, 5)
  });

  return {
    status: result.status === "auto" ? "completed" : "rejected",
    allPass: result.status === "auto",
    rootNodeId: root.id,
    rootName: root.name || "",
    nodeType: root.type,
    fileKey: figma.fileKey || "",
    documentName: figma.root && figma.root.name ? figma.root.name : "",
    pageName: figma.currentPage.name,
    rootBounds: boundsToManifest(rootBounds),
    nodeCount: childRecords.length,
    clusterType: result.clusterType,
    confidence: result.confidence,
    groups: result.groups,
    nodeAssignments: result.nodeAssignments,
    rejectReasons: result.rejectReasons,
    candidates: result.candidates,
    usedSignals: result.usedSignals,
    ignoredSignals: result.ignoredSignals,
    warnings: [],
    blockingErrors: result.status === "auto" ? [] : result.rejectReasons,
    summary: {
      rootNodeId: root.id,
      rootName: root.name || "",
      nodeCount: childRecords.length,
      clusterType: result.clusterType,
      confidence: result.confidence,
      groupCount: result.groups.length,
      ignoredSignals: result.ignoredSignals
    },
    checks: {
      highConfidence: { pass: result.status === "auto", threshold: confidenceThreshold, actual: result.confidence },
      noNameSignals: { pass: true, ignoredSignals: result.ignoredSignals },
      readOnly: { pass: true }
    },
    artifacts: {
      analyzedAt: new Date().toISOString()
    }
  };
}

function collectHierarchyRepeatClusterRecords(node, root, rootBounds, output, includeHidden, maxDepth, depth) {
  if (!node || (!includeHidden && node.visible === false)) {
    return;
  }
  const bounds = getNodeBounds(node);
  output.push({
    id: node.id,
    type: node.type || "",
    x: bounds.x - rootBounds.x,
    y: bounds.y - rootBounds.y,
    width: bounds.width,
    height: bounds.height,
    visible: node.visible !== false,
    opacity: numericOr(node.opacity, 1),
    childCount: "children" in node && Array.isArray(node.children) ? node.children.length : 0,
    isNineSliceLike: isHierarchyNineSliceLikeNode(node),
    depth
  });
  if (!("children" in node) || depth >= maxDepth) {
    return;
  }
  for (const child of node.children || []) {
    collectHierarchyRepeatClusterRecords(child, root, rootBounds, output, includeHidden, maxDepth, depth + 1);
  }
}

function detectHierarchyRepeatCluster(nodes, options) {
  const confidenceThreshold = numericOr(options && options.confidenceThreshold, 0.85);
  const candidates = [
    detectHierarchyAxisRepeatCluster(nodes, "x", positiveOr(options && options.expectedXCount, 7), confidenceThreshold),
    detectHierarchyAxisRepeatCluster(nodes, "y", positiveOr(options && options.expectedYCount, 5), confidenceThreshold),
    detectHierarchyProgressRepeatCluster(nodes, confidenceThreshold)
  ];
  const autoCandidates = candidates
    .filter((candidate) => candidate.status === "auto")
    .sort((left, right) => right.confidence - left.confidence);
  if (autoCandidates.length === 0) {
    const rejected = buildHierarchyRepeatRejected("noHighConfidenceCandidate", 0, { candidates: candidates.map(summarizeHierarchyRepeatCandidate) });
    rejected.candidates = candidates.map(summarizeHierarchyRepeatCandidate);
    return rejected;
  }
  if (autoCandidates.length > 1 && Math.abs(autoCandidates[0].confidence - autoCandidates[1].confidence) < 0.03) {
    const rejected = buildHierarchyRepeatRejected("ambiguousCandidates", autoCandidates[0].confidence, { candidates: candidates.map(summarizeHierarchyRepeatCandidate) });
    rejected.candidates = candidates.map(summarizeHierarchyRepeatCandidate);
    return rejected;
  }
  autoCandidates[0].candidates = candidates.map(summarizeHierarchyRepeatCandidate);
  return autoCandidates[0];
}

function detectHierarchyAxisRepeatCluster(nodes, axis, expectedCount, confidenceThreshold) {
  const usable = filterHierarchyRepeatUsableNodes(nodes);
  const anchors = usable
    .filter((node) => {
      if (node.isNineSliceLike) {
        return axis === "y" ? node.width >= 300 && node.height >= 100 : node.width >= 80 && node.height >= 100;
      }
      if (node.type !== "FRAME" && node.type !== "RECTANGLE") {
        return false;
      }
      const nodeArea = Math.max(0, node.width) * Math.max(0, node.height);
      return axis === "x"
        ? nodeArea >= 10000 && node.height >= 100
        : nodeArea >= 30000 && node.width >= 300;
    })
    .sort((left, right) => axis === "x" ? left.x - right.x : left.y - right.y);
  const directAnchors = anchors.filter((node) => numericOr(node.depth, 0) === 1);
  const selectedAnchors = (directAnchors.length >= expectedCount ? directAnchors : anchors)
    .slice(0, expectedCount)
    .sort((left, right) => axis === "x" ? left.x - right.x : left.y - right.y);
  if (selectedAnchors.length < expectedCount) {
    return buildHierarchyRepeatRejected("anchorCount", 0, { axis, expectedCount, actualCount: selectedAnchors.length });
  }

  const selected = selectedAnchors;
  const gaps = [];
  for (let index = 1; index < selected.length; index += 1) {
    gaps.push(axis === "x" ? selected[index].x - selected[index - 1].x : selected[index].y - selected[index - 1].y);
  }
  const step = hierarchyMedian(gaps);
  if (step < 20) {
    return buildHierarchyRepeatRejected("axisCollapsed", 0, { axis, step, expectedCount });
  }
  const maxGapDelta = gaps.reduce((max, gap) => Math.max(max, Math.abs(gap - step)), 0);
  const confidence = Math.max(0, 1 - maxGapDelta / Math.max(1, step));
  if (confidence < confidenceThreshold) {
    return buildHierarchyRepeatRejected("lowConfidence", confidence, { axis, step, maxGapDelta, threshold: confidenceThreshold });
  }

  const assignments = {};
  for (const node of usable) {
    const nodeCenter = hierarchyCenter(node);
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    selected.forEach((anchor, index) => {
      const anchorCenter = hierarchyCenter(anchor);
      const distance = axis === "x" ? Math.abs(nodeCenter.x - anchorCenter.x) : Math.abs(nodeCenter.y - anchorCenter.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    assignments[node.id] = `${axis}_group_${bestIndex + 1}`;
  }
  return buildHierarchyRepeatAuto(axis === "x" ? "horizontal-list" : "vertical-list", confidence, assignments, selected.map((anchor, index) => ({
    key: `${axis}_group_${index + 1}`,
    anchorNodeId: anchor.id
  })), ["mainAxisGapStability"]);
}

function detectHierarchyProgressRepeatCluster(nodes, confidenceThreshold) {
  const usable = filterHierarchyRepeatUsableNodes(nodes);
  const assignments = {};
  for (const track of usable.filter((node) => node.width > 500 && node.height < 100)) {
    assignments[track.id] = "track";
  }
  const markers = usable
    .filter((node) => node.width <= 25 && node.height >= 40 && node.height <= 75)
    .sort((left, right) => left.x - right.x);
  if (markers.length < 4) {
    return buildHierarchyRepeatRejected("markerCount", 0, { expectedCount: 4, actualCount: markers.length });
  }
  const slots = markers.slice(0, 4).map((marker, index) => ({ key: `slot_${index + 1}`, x: hierarchyCenter(marker).x }));
  const gaps = slots.slice(1).map((slot, index) => slot.x - slots[index].x);
  const step = hierarchyMedian(gaps);
  const maxGapDelta = gaps.reduce((max, gap) => Math.max(max, Math.abs(gap - step)), 0);
  const confidence = Math.max(0, 1 - maxGapDelta / Math.max(1, step));
  if (confidence < confidenceThreshold) {
    return buildHierarchyRepeatRejected("lowConfidence", confidence, { step, maxGapDelta, threshold: confidenceThreshold });
  }
  const minX = Math.min.apply(null, usable.map((node) => node.x));
  const maxX = Math.max.apply(null, usable.map((node) => node.x + node.width));
  for (const node of usable) {
    if (assignments[node.id]) {
      continue;
    }
    const nodeCenter = hierarchyCenter(node);
    if (nodeCenter.x < minX + 130) {
      assignments[node.id] = "start";
    } else if (nodeCenter.x > maxX - 120) {
      assignments[node.id] = "final";
    } else {
      let best = slots[0];
      for (const slot of slots) {
        if (Math.abs(nodeCenter.x - slot.x) < Math.abs(nodeCenter.x - best.x)) {
          best = slot;
        }
      }
      assignments[node.id] = best.key;
    }
  }
  return buildHierarchyRepeatAuto("progress", confidence, assignments, [
    { key: "track" },
    { key: "start" },
    ...slots.map((slot) => ({ key: slot.key })),
    { key: "final" }
  ], ["markerGapStability", "edgeSlots"]);
}

function buildHierarchyRepeatAuto(clusterType, confidence, assignments, groupSeeds, extraSignals) {
  const groups = groupSeeds
    .map((seed) => {
      const nodeIds = Object.keys(assignments).filter((nodeId) => assignments[nodeId] === seed.key);
      return Object.assign({}, seed, { nodeIds });
    })
    .filter((group) => group.nodeIds.length > 0);
  return {
    status: "auto",
    clusterType,
    confidence,
    groups,
    nodeAssignments: assignments,
    rejectReasons: [],
    usedSignals: ["type", "x", "y", "width", "height", "visible", "opacity", "childCount", "isNineSliceLike"].concat(extraSignals || []),
    ignoredSignals: ["name", "path", "characters"]
  };
}

function buildHierarchyRepeatRejected(reason, confidence, details) {
  return {
    status: "rejected",
    clusterType: "unknown",
    confidence,
    groups: [],
    nodeAssignments: {},
    rejectReasons: [{ reason, details }],
    usedSignals: ["type", "x", "y", "width", "height", "visible", "opacity", "childCount", "isNineSliceLike"],
    ignoredSignals: ["name", "path", "characters"],
    candidates: []
  };
}

function summarizeHierarchyRepeatCandidate(candidate) {
  return {
    status: candidate.status,
    clusterType: candidate.clusterType,
    confidence: numericOr(candidate.confidence, 0),
    rejectReasons: candidate.rejectReasons || []
  };
}

function filterHierarchyRepeatUsableNodes(nodes) {
  return (nodes || []).filter((node) => node && node.id && node.visible !== false && numericOr(node.opacity, 1) > 0 && numericOr(node.width, 0) > 0 && numericOr(node.height, 0) > 0);
}

function hierarchyCenter(node) {
  return {
    x: numericOr(node.x, 0) + numericOr(node.width, 0) / 2,
    y: numericOr(node.y, 0) + numericOr(node.height, 0) / 2
  };
}

function hierarchyMedian(values) {
  const sorted = (values || []).slice().sort((left, right) => left - right);
  if (sorted.length === 0) {
    return 0;
  }
  return sorted[Math.floor(sorted.length / 2)];
}

function isHierarchyNineSliceLikeNode(node) {
  if (!node || !("children" in node)) {
    return false;
  }
  const children = Array.from(node.children || []);
  if (children.length !== 3 && children.length !== 9) {
    return false;
  }
  return children.every((child) => String(child && child.name || "").indexOf("__slice_") === 0);
}

/** Export only a target node PNG screenshot. */
async function exportFigmaNodeScreenshotJob(job) {
  const target = job && job.target ? job.target : {};
  const nodeId = String(target.nodeId || "");
  if (!nodeId) {
    throw new Error("FIGMA_EXPORT_NODE_SCREENSHOT missing target.nodeId");
  }

  const root = await figma.getNodeByIdAsync(nodeId).catch(() => null);
  if (!root) {
    throw new Error(`Figma node not found: ${nodeId}`);
  }

  await setCurrentPageForNode(root);
  const rootBounds = getNodeBounds(root);
  const screenshot = await exportNodePngScreenshot(root);

  return {
    status: screenshot ? "completed" : "blocked",
    allPass: !!screenshot,
    rootNodeId: root.id,
    rootName: root.name || "",
    nodeType: root.type,
    fileKey: figma.fileKey || "",
    documentName: figma.root && figma.root.name ? figma.root.name : "",
    pageName: figma.currentPage.name,
    rootBounds: boundsToManifest(rootBounds),
    screenshot,
    blockingErrors: screenshot ? [] : [{
      code: "screenshotExported",
      message: "PNG screenshot export returned empty data."
    }],
    warnings: [],
    summary: {
      rootNodeId: root.id,
      rootName: root.name || "",
      screenshotByteLength: screenshot ? screenshot.byteLength : 0
    },
    checks: {
      screenshotExported: { pass: !!screenshot }
    },
    artifacts: {
      exportedAt: new Date().toISOString()
    },
    errors: []
  };
}

/** 执行确认后的层级整理计划。 */
async function applyFigmaHierarchyCleanupJob(job) {
  const plan = job && job.plan ? job.plan : {};
  const target = job && job.target ? job.target : (plan.target || {});
  const options = job && job.options ? job.options : {};
  const nodeId = String(target.nodeId || (plan.target && plan.target.nodeId) || "");
  if (!nodeId) {
    throw new Error("FIGMA_HIERARCHY_CLEANUP_APPLY missing target.nodeId");
  }
  if (!Array.isArray(plan.groups) || plan.groups.length === 0) {
    throw new Error("FIGMA_HIERARCHY_CLEANUP_APPLY missing plan.groups");
  }

  const root = await figma.getNodeByIdAsync(nodeId).catch(() => null);
  if (!root) {
    throw new Error(`Figma node not found: ${nodeId}`);
  }
  if (!("children" in root)) {
    throw new Error(`Figma node has no children: ${root.type}`);
  }

  await setCurrentPageForNode(root);
  if (isHierarchyAutoLayoutNode(root)) {
    return buildHierarchyCleanupBlockedResult(root, [], [{
      code: "rootAutoLayoutUnsupported",
      message: "目标根节点启用了 Auto Layout，自动层级整理可能改变布局，已阻止写入。",
      details: { layoutMode: root.layoutMode }
    }]);
  }
  // Run all zero-write preflight checks before backup clone or grouping.
  const beforeBounds = getNodeBounds(root);
  const beforeChildren = collectHierarchyDirectChildren(root, beforeBounds, true);
  const beforeChildIds = beforeChildren.map((child) => child.id);
  const validationErrors = validateHierarchyCleanupPlan(plan, beforeChildren, {
    rootNodeId: root.id,
    targetNodeId: nodeId
  });
  validationErrors.push(...buildHierarchyPlanSemanticBlockingErrors(plan, beforeChildren, root.name || ""));
  if (validationErrors.length > 0) {
    return buildHierarchyCleanupBlockedResult(root, beforeChildren, validationErrors);
  }
  const resolvedPlanNodes = await resolveHierarchyCleanupPlanChildNodes(root, plan, beforeChildren);
  if (resolvedPlanNodes.errors.length > 0) {
    return buildHierarchyCleanupBlockedResult(root, beforeChildren, resolvedPlanNodes.errors);
  }

  // 如果 plan 指定了 createBackup，先复制整个根节点作为隐藏备份
  const backupInfo = {};
  if (plan.createBackup) {
    try {
      const page = findContainingPage(root) || figma.currentPage;
      const clone = root.clone();
      page.appendChild(clone);
      clone.x = root.x + root.width + 100;
      clone.y = root.y;
      clone.visible = false;
      clone.name = `[Backup]${root.name || ""}`;
      backupInfo.cloneId = clone.id;
      backupInfo.cloneName = clone.name;
      backupInfo.success = true;
    } catch (error) {
      backupInfo.success = false;
      backupInfo.error = error instanceof Error ? error.message : String(error);
    }
  }
  const beforeBoundsById = {};
  const beforeChildrenById = {};
  for (const child of beforeChildren) {
    beforeBoundsById[child.id] = child.bounds;
    beforeChildrenById[child.id] = child;
  }

  const createdGroups = [];
  const movedNodeIds = [];
  for (const groupPlan of plan.groups) {
    const groupNode = createHierarchyCleanupGroup(root, groupPlan, beforeChildren);
    createdGroups.push({
      id: groupNode.id,
      name: groupNode.name,
      childCount: Array.isArray(groupPlan.childNodeIds) ? groupPlan.childNodeIds.length : 0
    });
    const childIds = groupPlan.childNodeIds || [];
    for (const childId of childIds) {
      const child = resolvedPlanNodes.nodesById[String(childId)];
      const beforeRecord = beforeChildrenById[String(childId)];
      if (!child || !beforeRecord || !("appendChild" in groupNode)) {
        throw new Error(`Hierarchy cleanup internal error: unresolved child ${childId}`);
      }
      groupNode.appendChild(child);
      preserveHierarchyChildAbsoluteBounds(child, groupNode, beforeRecord.bounds);
      movedNodeIds.push(child.id);
    }
    // 如果 groupPlan 指定了 renameChildren，移动后重命名对应子节点
    if (groupPlan.renameChildren) {
      for (const [childId, newName] of Object.entries(groupPlan.renameChildren)) {
        if (!childId || !newName) continue;
        const child = await figma.getNodeByIdAsync(String(childId)).catch(() => null);
        if (child) {
          child.name = String(newName);
        }
      }
    }
  }

  const afterBounds = getNodeBounds(root);
  const originalNodesAfter = await collectHierarchyOriginalNodesAfter(plan, beforeBoundsById);
  const topLevelGroups = collectHierarchyTopLevelGroups(root);
  const driftNodes = collectHierarchyBoundsDrift(originalNodesAfter, beforeBoundsById, 0.01);
  const includeScreenshot = options.includeScreenshot !== false;
  const screenshot = includeScreenshot ? await exportNodePngScreenshot(root) : null;
  const checks = {
    rootSizeUnchanged: {
      pass: Math.abs(beforeBounds.width - afterBounds.width) <= 0.01 && Math.abs(beforeBounds.height - afterBounds.height) <= 0.01,
      before: boundsToManifest(beforeBounds),
      after: boundsToManifest(afterBounds)
    },
    rootPositionStable: {
      pass: Math.abs(beforeBounds.x - afterBounds.x) <= 0.01 && Math.abs(beforeBounds.y - afterBounds.y) <= 0.01,
      before: { x: beforeBounds.x, y: beforeBounds.y },
      after: { x: afterBounds.x, y: afterBounds.y },
      driftX: Math.round((beforeBounds.x - afterBounds.x) * 100) / 100,
      driftY: Math.round((beforeBounds.y - afterBounds.y) * 100) / 100
    },
    allOriginalChildrenAssignedOnce: {
      pass: movedNodeIds.length === beforeChildIds.length && uniqueStrings(movedNodeIds).length === beforeChildIds.length,
      movedCount: movedNodeIds.length,
      expected: beforeChildIds.length
    },
    boundsPreserved: {
      pass: driftNodes.length === 0,
      driftCount: driftNodes.length,
      driftNodes
    },
    topLevelGroupsMatchPlan: {
      pass: topLevelGroups.map((item) => item.name).join("|") === plan.groups.map((item) => String(item.name || "")).join("|"),
      actual: topLevelGroups.map((item) => item.name),
      expected: plan.groups.map((item) => String(item.name || ""))
    },
    screenshotExported: { pass: !!screenshot || !includeScreenshot }
  };
  const semanticErrors = buildHierarchyLiveSemanticBlockingErrors(root, { mode: "cleanupApply", plan });
  if (semanticErrors.length > 0) {
    checks.semanticHierarchyRules = {
      pass: false,
      errors: semanticErrors
    };
  }
  const blockingErrors = buildHierarchyApplyBlockingErrors(checks).concat(semanticErrors);

  return {
    status: blockingErrors.length === 0 ? "completed" : "blocked",
    allPass: blockingErrors.length === 0,
    rootNodeId: root.id,
    rootName: root.name || "",
    rootBounds: boundsToManifest(afterBounds),
    originalNodesAfter,
    topLevelGroups,
    screenshot,
    backupInfo,
    blockingErrors,
    warnings: [],
    summary: {
      beforeDirectChildCount: beforeChildren.length,
      afterDirectChildCount: topLevelGroups.length,
      createdGroups: createdGroups.length,
      movedOriginalNodes: movedNodeIds.length
    },
    checks,
    artifacts: {
      before: {
        rootBounds: boundsToManifest(beforeBounds),
        directChildIds: beforeChildIds
      },
      after: {
        rootBounds: boundsToManifest(afterBounds)
      },
      plan,
      createdGroups,
      backupInfo,
      mutatedNodeIds: movedNodeIds
    },
    errors: []
  };
}

/** 执行根节点直接子节点重排，专用于修正视觉栈层级。 */
/** Create a nested wrapper chain and move current direct children to the deepest wrapper. */
async function wrapFigmaHierarchyChainJob(job) {
  const target = job && job.target ? job.target : {};
  const options = job && job.options ? job.options : {};
  const nodeId = String(target.nodeId || "");
  if (!nodeId) {
    throw new Error("FIGMA_HIERARCHY_WRAP_CHAIN missing target.nodeId");
  }
  const wrapperChain = normalizeHierarchyWrapperChain(job.wrapperChain || (job.plan && job.plan.wrapperChain));
  if (wrapperChain.length < 2) {
    throw new Error("FIGMA_HIERARCHY_WRAP_CHAIN requires wrapperChain with at least two names");
  }

  const root = await figma.getNodeByIdAsync(nodeId).catch(() => null);
  if (!root) {
    throw new Error(`Figma node not found: ${nodeId}`);
  }
  if (!("children" in root)) {
    throw new Error(`Figma node has no children: ${root.type}`);
  }

  await setCurrentPageForNode(root);
  const wrapperSemanticErrors = buildHierarchyWrapperChainSemanticBlockingErrors(root, wrapperChain);
  if (wrapperSemanticErrors.length > 0) {
    return buildHierarchyCleanupBlockedResult(root, [], wrapperSemanticErrors);
  }
  if (isHierarchyAutoLayoutNode(root)) {
    return buildHierarchyCleanupBlockedResult(root, [], [{
      code: "rootAutoLayoutUnsupported",
      message: "Wrapper chain target uses Auto Layout and was not modified.",
      details: { layoutMode: root.layoutMode }
    }]);
  }

  const beforeBounds = getNodeBounds(root);
  const beforeChildren = collectHierarchyDirectChildren(root, beforeBounds, true);
  if (beforeChildren.length === 0) {
    return buildHierarchyCleanupBlockedResult(root, beforeChildren, [{
      code: "emptyWrapperRoot",
      message: "Wrapper chain target has no direct children.",
      details: { rootNodeId: root.id, rootName: root.name || "" }
    }]);
  }

  const beforeChildIds = beforeChildren.map((child) => child.id);
  const beforeBoundsById = {};
  const beforeChildrenById = {};
  for (const child of beforeChildren) {
    beforeBoundsById[child.id] = child.bounds;
    beforeChildrenById[child.id] = child;
  }

  const createdGroups = [];
  let parent = root;
  for (let index = 1; index < wrapperChain.length; index++) {
    const name = wrapperChain[index];
    const groupNode = index === 1
      ? createHierarchyCleanupGroup(parent, { name, childNodeIds: beforeChildIds }, beforeChildren)
      : createFullSizeHierarchyWrapper(parent, name);
    createdGroups.push({
      id: groupNode.id,
      name: groupNode.name,
      parentId: parent.id,
      index: index - 1,
      bounds: boundsToManifest(getNodeBounds(groupNode))
    });
    parent = groupNode;
  }

  const deepestGroup = parent;
  const movedNodeIds = [];
  for (const childId of beforeChildIds) {
    const child = await figma.getNodeByIdAsync(String(childId)).catch(() => null);
    const beforeRecord = beforeChildrenById[String(childId)];
    if (!child || !beforeRecord || child.parent !== root) {
      throw new Error(`Hierarchy wrap-chain internal error: unresolved direct child ${childId}`);
    }
    deepestGroup.appendChild(child);
    preserveHierarchyChildAbsoluteBounds(child, deepestGroup, beforeRecord.bounds);
    movedNodeIds.push(child.id);
  }

  const afterBounds = getNodeBounds(root);
  const originalNodesAfter = await collectHierarchyWrapChainOriginalNodesAfter(beforeChildIds, beforeBoundsById);
  const topLevelGroups = collectHierarchyTopLevelGroups(root);
  const driftNodes = collectHierarchyBoundsDrift(originalNodesAfter, beforeBoundsById, 0.01);
  const includeScreenshot = options.includeScreenshot !== false;
  const screenshot = includeScreenshot ? await exportNodePngScreenshot(root) : null;
  const expectedTopLevelName = wrapperChain[1];
  const checks = {
    rootSizeUnchanged: {
      pass: Math.abs(beforeBounds.width - afterBounds.width) <= 0.01 && Math.abs(beforeBounds.height - afterBounds.height) <= 0.01,
      before: boundsToManifest(beforeBounds),
      after: boundsToManifest(afterBounds)
    },
    rootPositionStable: {
      pass: Math.abs(beforeBounds.x - afterBounds.x) <= 0.01 && Math.abs(beforeBounds.y - afterBounds.y) <= 0.01,
      before: { x: beforeBounds.x, y: beforeBounds.y },
      after: { x: afterBounds.x, y: afterBounds.y }
    },
    allOriginalChildrenAssignedOnce: {
      pass: movedNodeIds.length === beforeChildIds.length && uniqueStrings(movedNodeIds).length === beforeChildIds.length,
      movedCount: movedNodeIds.length,
      expected: beforeChildIds.length
    },
    boundsPreserved: {
      pass: driftNodes.length === 0,
      driftCount: driftNodes.length,
      driftNodes
    },
    topLevelChainMatchesPlan: {
      pass: topLevelGroups.length === 1 && topLevelGroups[0].name === expectedTopLevelName,
      actual: topLevelGroups.map((item) => item.name),
      expected: [expectedTopLevelName]
    },
    wrapperChainCreated: {
      pass: createdGroups.length === wrapperChain.length - 1 && createdGroups.map((item) => item.name).join("|") === wrapperChain.slice(1).join("|"),
      actual: createdGroups.map((item) => item.name),
      expected: wrapperChain.slice(1)
    },
    screenshotExported: { pass: !!screenshot || !includeScreenshot }
  };
  const semanticErrors = buildHierarchyLiveSemanticBlockingErrors(root, { mode: "wrapChain", wrapperChain });
  if (semanticErrors.length > 0) {
    checks.semanticHierarchyRules = {
      pass: false,
      errors: semanticErrors
    };
  }
  const blockingErrors = buildHierarchyApplyBlockingErrors(checks).concat(semanticErrors);

  return {
    status: blockingErrors.length === 0 ? "completed" : "blocked",
    allPass: blockingErrors.length === 0,
    rootNodeId: root.id,
    rootName: root.name || "",
    rootBounds: boundsToManifest(afterBounds),
    originalNodesAfter,
    topLevelGroups,
    screenshot,
    blockingErrors,
    warnings: [],
    summary: {
      beforeDirectChildCount: beforeChildren.length,
      afterDirectChildCount: topLevelGroups.length,
      createdGroups: createdGroups.length,
      movedOriginalNodes: movedNodeIds.length,
      deepestGroupId: deepestGroup.id,
      deepestGroupName: deepestGroup.name || ""
    },
    checks,
    artifacts: {
      before: {
        rootBounds: boundsToManifest(beforeBounds),
        directChildIds: beforeChildIds
      },
      after: {
        rootBounds: boundsToManifest(afterBounds)
      },
      wrapperChain,
      createdGroups,
      deepestGroupId: deepestGroup.id,
      deepestGroupName: deepestGroup.name || "",
      mutatedNodeIds: movedNodeIds
    },
    errors: []
  };
}

function normalizeHierarchyWrapperChain(value) {
  const raw = Array.isArray(value) ? value : String(value || "").replace(/\//g, ">").split(">");
  const names = [];
  for (const item of raw) {
    const text = String(item || "").trim();
    if (!text) {
      continue;
    }
    names.push(text.startsWith("[") && text.endsWith("]") ? text : `[${text.replace(/^\[|\]$/g, "")}]`);
  }
  return names;
}

function createFullSizeHierarchyWrapper(parent, name) {
  const frame = figma.createFrame();
  frame.name = String(name || "[Group]");
  frame.x = 0;
  frame.y = 0;
  frame.resize(Math.max(parent.width || 0.01, 0.01), Math.max(parent.height || 0.01, 0.01));
  frame.fills = [];
  frame.strokes = [];
  frame.clipsContent = false;
  if ("layoutMode" in frame) {
    frame.layoutMode = "NONE";
  }
  parent.appendChild(frame);
  return frame;
}

function normalizeHierarchySemanticName(value) {
  return String(value || "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/[\s_\-\[\]]+/g, "");
}

function isHierarchyListLikeName(value) {
  const name = normalizeHierarchySemanticName(value);
  return name.indexOf("tasklist") >= 0 || name.indexOf("listroot") >= 0 || name === "list" || name.endsWith("list");
}

function isHierarchyItemName(value) {
  const name = normalizeHierarchySemanticName(value);
  return /^item\d*/.test(name) || /^taskitem\d*/.test(name) || /^rewarditem\d*/.test(name);
}

function isHierarchyScrollViewName(value) {
  return normalizeHierarchySemanticName(value) === "scrollview";
}

function isHierarchyViewportName(value) {
  return normalizeHierarchySemanticName(value) === "viewport";
}

function isHierarchyContentName(value) {
  return normalizeHierarchySemanticName(value) === "content";
}

function isHierarchyProgressTrackName(value) {
  const name = normalizeHierarchySemanticName(value);
  return name === "progresstrack" || name === "progressbar";
}

function isHierarchyRewardSlotName(value) {
  const name = normalizeHierarchySemanticName(value);
  return name.indexOf("rewardslot") >= 0 || name.indexOf("milestone") >= 0;
}

function isHierarchyMarkerName(value) {
  const name = normalizeHierarchySemanticName(value);
  return name.indexOf("jdtbig3") >= 0 || name.indexOf("marker") >= 0 || name.indexOf("tick") >= 0;
}

function isHierarchyTrackOnlyName(value) {
  const name = normalizeHierarchySemanticName(value);
  return name.indexOf("slice") >= 0 || name.indexOf("jiugong") >= 0 || name.indexOf("track") >= 0 || name.indexOf("fill") >= 0 || name.indexOf("jdtbig1") >= 0 || name.indexOf("jdtbig2") >= 0;
}

function buildHierarchyPlanSemanticBlockingErrors(plan, beforeChildren, rootName) {
  const errors = [];
  const groups = Array.isArray(plan && plan.groups) ? plan.groups : [];
  const childNameById = {};
  for (const child of beforeChildren || []) {
    if (child && child.id) {
      childNameById[String(child.id)] = String(child.name || "");
    }
  }
  const groupNames = groups.map((group) => String(group && group.name || ""));
  const hasItemGroups = groupNames.some(isHierarchyItemName);
  const listLike = isHierarchyListLikeName(rootName) || groupNames.some(isHierarchyListLikeName);
  const hasScrollView = groupNames.some(isHierarchyScrollViewName);
  const hasViewport = groupNames.some(isHierarchyViewportName);
  const hasContent = groupNames.some(isHierarchyContentName);
  const targetIsContentChain = isHierarchyContentName(rootName) || isHierarchyViewportName(rootName) || isHierarchyScrollViewName(rootName);
  if (listLike && hasItemGroups && !targetIsContentChain && !(hasScrollView && hasViewport && hasContent)) {
    errors.push({
      code: "scrollViewChainMissing",
      message: "List-like cleanup plans with item groups must include [ScrollView] > [Viewport] > [Content].",
      details: {
        rootName: String(rootName || ""),
        groupNames,
        requiredStructure: "[ListRoot] > [ScrollView] > [Viewport] > [Content] > [Item_*]"
      }
    });
  }

  for (const group of groups) {
    const groupName = String(group && group.name || "");
    if (!isHierarchyProgressTrackName(groupName)) {
      continue;
    }
    const badChildren = [];
    for (const childId of group.childNodeIds || []) {
      const childName = childNameById[String(childId)] || String(childId);
      if (isHierarchyMarkerName(childName) && !isHierarchyTrackOnlyName(childName)) {
        badChildren.push({ nodeId: String(childId), name: childName });
      }
    }
    if (badChildren.length > 0 && groupNames.some(isHierarchyRewardSlotName)) {
      errors.push({
        code: "progressMarkerNotInRewardSlot",
        message: "Progress marker nodes must be owned by [RewardSlot_*] or [Milestone_*], not [ProgressTrack].",
        details: {
          groupName,
          badChildren,
          requiredStructure: "Move marker/tick/jdtbig3 nodes into matching [RewardSlot_*] or [Milestone_*]; keep [ProgressTrack] for track/fill/slice nodes only."
        }
      });
    }
  }
  return errors;
}

function buildHierarchyWrapperChainSemanticBlockingErrors(root, wrapperChain) {
  const errors = [];
  const rootName = root && root.name ? root.name : "";
  if (isHierarchyListLikeName(rootName)) {
    const hasScrollChainNames = wrapperChain.some(isHierarchyScrollViewName) && wrapperChain.some(isHierarchyViewportName) && wrapperChain.some(isHierarchyContentName);
    if (hasScrollChainNames && !isHierarchyScrollViewName(wrapperChain[1])) {
      errors.push({
        code: "scrollViewChainMissing",
        message: "Wrapper chain for a list-like target must create [ScrollView] as the first child under the target.",
        details: {
          rootName,
          wrapperChain,
          requiredWrapperChain: "[ListRoot] > [ScrollView] > [Viewport] > [Content]",
          note: "The first wrapperChain entry is treated as the current root label; the plugin creates entries from index 1."
        }
      });
    }
  }
  return errors;
}

function buildHierarchyLiveSemanticBlockingErrors(root, context) {
  const errors = [];
  errors.push(...buildHierarchyLiveListBlockingErrors(root, context));
  errors.push(...buildHierarchyLiveProgressMarkerBlockingErrors(root, context));
  return errors;
}

function buildHierarchyLiveListBlockingErrors(root, context) {
  const errors = [];
  if (!root || !("children" in root)) {
    return errors;
  }
  const rootName = root.name || "";
  const directChildren = Array.from(root.children || []);
  const rootListLike = isHierarchyListLikeName(rootName);
  const directItemChildren = directChildren.filter((child) => isHierarchyItemName(child.name || ""));
  const scroll = directChildren.find((child) => isHierarchyScrollViewName(child.name || ""));
  const viewport = scroll && "children" in scroll ? Array.from(scroll.children || []).find((child) => isHierarchyViewportName(child.name || "")) : null;
  const content = viewport && "children" in viewport ? Array.from(viewport.children || []).find((child) => isHierarchyContentName(child.name || "")) : null;
  const misplacedItems = [];
  collectHierarchySemanticNodes(root, (node) => {
    if (node === root || !isHierarchyItemName(node.name || "")) {
      return;
    }
    const parentName = node.parent ? node.parent.name || "" : "";
    if (!isHierarchyContentName(parentName)) {
      misplacedItems.push({
        nodeId: node.id,
        name: node.name || "",
        parentId: node.parent ? node.parent.id : "",
        parentName
      });
    }
  });

  if (rootListLike && directItemChildren.length > 0) {
    errors.push({
      code: "scrollViewChainMissing",
      message: "List item groups must be under [ScrollView] > [Viewport] > [Content], not directly under the list root.",
      details: {
        rootNodeId: root.id,
        rootName,
        directItemNames: directItemChildren.map((child) => child.name || ""),
        requiredStructure: "[ListRoot] > [ScrollView] > [Viewport] > [Content] > [Item_*]",
        context
      }
    });
  } else if (rootListLike && content && misplacedItems.length > 0) {
    errors.push({
      code: "scrollViewChainMissing",
      message: "List item groups must be direct children of [Content].",
      details: {
        rootNodeId: root.id,
        rootName,
        misplacedItems,
        requiredStructure: "[ListRoot] > [ScrollView] > [Viewport] > [Content] > [Item_*]",
        context
      }
    });
  } else if (rootListLike && (scroll || directChildren.some((child) => isHierarchyViewportName(child.name || "") || isHierarchyContentName(child.name || ""))) && (!scroll || !viewport || !content)) {
    errors.push({
      code: "scrollViewChainMissing",
      message: "List-like hierarchy has a partial ScrollView chain.",
      details: {
        rootNodeId: root.id,
        rootName,
        hasScrollView: !!scroll,
        hasViewport: !!viewport,
        hasContent: !!content,
        requiredStructure: "[ListRoot] > [ScrollView] > [Viewport] > [Content] > [Item_*]",
        context
      }
    });
  }
  return errors;
}

function buildHierarchyLiveProgressMarkerBlockingErrors(root, context) {
  const errors = [];
  const progressNodes = [];
  const rewardNodes = [];
  collectHierarchySemanticNodes(root, (node) => {
    if (isHierarchyProgressTrackName(node.name || "")) {
      progressNodes.push(node);
    }
    if (isHierarchyRewardSlotName(node.name || "")) {
      rewardNodes.push(node);
    }
  });
  if (rewardNodes.length === 0) {
    return errors;
  }
  for (const progressNode of progressNodes) {
    if (!progressNode || !("children" in progressNode)) {
      continue;
    }
    const badChildren = Array.from(progressNode.children || [])
      .filter((child) => isHierarchyMarkerName(child.name || "") && !isHierarchyTrackOnlyName(child.name || ""))
      .map((child) => ({ nodeId: child.id, name: child.name || "" }));
    if (badChildren.length > 0) {
      errors.push({
        code: "progressMarkerNotInRewardSlot",
        message: "Progress marker nodes must be owned by [RewardSlot_*] or [Milestone_*], not [ProgressTrack].",
        details: {
          progressNodeId: progressNode.id,
          progressName: progressNode.name || "",
          badChildren,
          rewardCandidates: rewardNodes.map((node) => ({ nodeId: node.id, name: node.name || "" })),
          requiredStructure: "Move marker/tick/jdtbig3 nodes into matching [RewardSlot_*] or [Milestone_*]; keep [ProgressTrack] for track/fill/slice nodes only.",
          context
        }
      });
    }
  }
  return errors;
}

function collectHierarchySemanticNodes(node, visitor) {
  if (!node) {
    return;
  }
  visitor(node);
  if (!("children" in node)) {
    return;
  }
  for (const child of node.children || []) {
    collectHierarchySemanticNodes(child, visitor);
  }
}

async function collectHierarchyWrapChainOriginalNodesAfter(childIds, beforeBoundsById) {
  const output = [];
  const rootBounds = { x: 0, y: 0, width: 0, height: 0 };
  for (const childId of childIds || []) {
    const node = await figma.getNodeByIdAsync(String(childId)).catch(() => null);
    if (!node) {
      continue;
    }
    output.push(buildHierarchyNodeRecord(node, node, rootBounds, node.parent ? node.parent.id : "", 0));
    output[output.length - 1].beforeBounds = beforeBoundsById[String(childId)] || null;
  }
  return output;
}

/** Execute explicit hierarchy operations sequentially without extra MCP round-trips. */
async function applyFigmaHierarchyBatchJob(job) {
  const rawSteps = Array.isArray(job.steps) ? job.steps : (job.plan && Array.isArray(job.plan.steps) ? job.plan.steps : []);
  if (rawSteps.length === 0) {
    throw new Error("FIGMA_HIERARCHY_BATCH_APPLY requires steps");
  }
  const refs = {};
  const stepSummaries = [];
  const blockingErrors = [];
  const warnings = [];
  const errors = [];
  const startedAt = Date.now();
  let finalScreenshot = null;
  let rootNodeId = "";
  let rootName = "";
  let completedSteps = 0;

  for (let index = 0; index < rawSteps.length; index++) {
    const step = rawSteps[index] || {};
    const stepStartedAt = Date.now();
    const stepType = normalizeHierarchyBatchStepType(step.type || step.kind);
    if (!stepType) {
      blockingErrors.push({
        code: "unsupportedBatchStepType",
        message: "Unsupported hierarchy batch step type.",
        details: { index, type: String(step.type || step.kind || "") }
      });
      break;
    }

    let result = null;
    try {
      const stepJob = buildHierarchyBatchStepJob(step, refs, job.options || {});
      if (stepType === "cleanupApply") {
        result = await applyFigmaHierarchyCleanupJob(stepJob);
      } else if (stepType === "wrapChain") {
        result = await wrapFigmaHierarchyChainJob(stepJob);
      } else if (stepType === "reorderChildren") {
        result = await reorderFigmaHierarchyChildrenJob(stepJob);
      } else if (stepType === "screenshot") {
        result = await exportFigmaNodeScreenshotJob(stepJob);
      }
    } catch (error) {
      result = buildHierarchyCleanupErrorResult(error, stepType);
    }

    if (result && result.rootNodeId) {
      rootNodeId = String(result.rootNodeId || "");
      rootName = String(result.rootName || "");
    }
    registerHierarchyBatchRefs(refs, step, result);
    const stepDurationMs = Date.now() - stepStartedAt;
    const summary = compactHierarchyBatchStepResult(index, step, stepType, result, stepDurationMs);
    stepSummaries.push(summary);
    if (Array.isArray(result && result.warnings)) {
      warnings.push(...result.warnings.map((item) => Object.assign({ stepIndex: index }, item)));
    }
    if (Array.isArray(result && result.errors)) {
      errors.push(...result.errors.map((item) => ({ stepIndex: index, message: String(item) })));
    }
    if (result && result.screenshot) {
      finalScreenshot = result.screenshot;
    }

    const stepBlocking = Array.isArray(result && result.blockingErrors) ? result.blockingErrors : [];
    if (!result || result.status !== "completed" || result.allPass === false || stepBlocking.length > 0) {
      blockingErrors.push({
        code: "batchStepFailed",
        message: "Hierarchy batch stopped because a step did not complete cleanly.",
        details: {
          index,
          name: String(step.name || step.id || ""),
          type: stepType,
          status: result ? result.status : "missing-result",
          allPass: result ? result.allPass : false,
          blockingErrors: stepBlocking
        }
      });
      break;
    }
    completedSteps += 1;
  }

  return {
    status: blockingErrors.length === 0 ? "completed" : "blocked",
    allPass: blockingErrors.length === 0,
    rootNodeId,
    rootName,
    screenshot: finalScreenshot,
    blockingErrors,
    warnings,
    summary: {
      totalSteps: rawSteps.length,
      completedSteps,
      durationMs: Date.now() - startedAt,
      stepSummaries
    },
    checks: {
      allStepsCompleted: {
        pass: blockingErrors.length === 0,
        completedSteps,
        expectedSteps: rawSteps.length
      },
      finalScreenshotExported: {
        pass: !!finalScreenshot || rawSteps.every((step) => normalizeHierarchyBatchStepType(step && (step.type || step.kind)) !== "screenshot")
      }
    },
    artifacts: {
      refs,
      steps: stepSummaries,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString()
    },
    errors
  };
}

function normalizeHierarchyBatchStepType(value) {
  const text = String(value || "").trim();
  if (["cleanupApply", "cleanup", "apply", "FIGMA_HIERARCHY_CLEANUP_APPLY"].includes(text)) {
    return "cleanupApply";
  }
  if (["wrapChain", "wrap", "FIGMA_HIERARCHY_WRAP_CHAIN"].includes(text)) {
    return "wrapChain";
  }
  if (["reorderChildren", "reorder", "FIGMA_HIERARCHY_REORDER_CHILDREN"].includes(text)) {
    return "reorderChildren";
  }
  if (["screenshot", "exportScreenshot", "FIGMA_EXPORT_NODE_SCREENSHOT"].includes(text)) {
    return "screenshot";
  }
  return "";
}

function buildHierarchyBatchStepJob(step, refs, batchOptions) {
  const stepJob = {};
  const target = step.target || {};
  stepJob.target = resolveHierarchyBatchTarget(target, refs);
  if (step.plan) {
    stepJob.plan = Object.assign({}, step.plan);
    const planTarget = stepJob.plan && typeof stepJob.plan.target === "object" && stepJob.plan.target
      ? Object.assign({}, stepJob.plan.target)
      : {};
    if (!String(planTarget.nodeId || "").trim() && stepJob.target && stepJob.target.nodeId) {
      planTarget.nodeId = stepJob.target.nodeId;
    }
    stepJob.plan.target = planTarget;
  }
  if (step.wrapperChain) {
    stepJob.wrapperChain = step.wrapperChain;
  }
  const stepOptions = Object.assign({}, step.options || {});
  if (normalizeHierarchyBatchStepType(step.type || step.kind) !== "screenshot" && batchOptions.includeIntermediateScreenshots !== true) {
    stepOptions.includeScreenshot = false;
  }
  stepJob.options = stepOptions;
  return stepJob;
}

function resolveHierarchyBatchTarget(target, refs) {
  const nodeId = String(target.nodeId || "");
  if (nodeId) {
    return { nodeId };
  }
  const refName = String(target.ref || target.nodeRef || target.targetRef || "");
  if (refName && refs[refName]) {
    return { nodeId: refs[refName] };
  }
  throw new Error(`Hierarchy batch target could not be resolved: ${refName || "missing nodeId/ref"}`);
}

function registerHierarchyBatchRefs(refs, step, result) {
  if (!result) {
    return;
  }
  const rootId = String(result.rootNodeId || "");
  const rootName = String(result.rootName || "");
  if (rootId && rootName) {
    refs[rootName] = rootId;
  }
  if (step.saveRootAs && rootId) {
    refs[String(step.saveRootAs)] = rootId;
  }
  const artifacts = result.artifacts || {};
  const createdGroups = Array.isArray(artifacts.createdGroups) ? artifacts.createdGroups : [];
  for (const group of createdGroups) {
    if (!group || !group.id || !group.name) {
      continue;
    }
    refs[String(group.name)] = String(group.id);
  }
  const deepestGroupId = String(artifacts.deepestGroupId || (result.summary && result.summary.deepestGroupId) || "");
  const deepestGroupName = String(artifacts.deepestGroupName || (result.summary && result.summary.deepestGroupName) || "");
  if (deepestGroupId && deepestGroupName) {
    refs[deepestGroupName] = deepestGroupId;
  }
  if (step.saveDeepestAs && deepestGroupId) {
    refs[String(step.saveDeepestAs)] = deepestGroupId;
  }
  if (step.id && rootId) {
    refs[String(step.id)] = rootId;
  }
}

function compactHierarchyBatchStepResult(index, step, stepType, result, durationMs) {
  const artifacts = result && result.artifacts ? result.artifacts : {};
  return {
    index,
    id: String(step.id || ""),
    name: String(step.name || ""),
    type: stepType,
    status: result ? result.status : "missing-result",
    allPass: !!(result && result.allPass),
    rootNodeId: result ? String(result.rootNodeId || "") : "",
    rootName: result ? String(result.rootName || "") : "",
    durationMs,
    summary: result && result.summary ? result.summary : {},
    checks: result && result.checks ? result.checks : {},
    createdGroups: Array.isArray(artifacts.createdGroups) ? artifacts.createdGroups : [],
    deepestGroupId: String(artifacts.deepestGroupId || ""),
    deepestGroupName: String(artifacts.deepestGroupName || ""),
    screenshot: result && result.screenshot ? result.screenshot : null,
    blockingErrors: Array.isArray(result && result.blockingErrors) ? result.blockingErrors : [],
    warningCount: Array.isArray(result && result.warnings) ? result.warnings.length : 0,
    errorCount: Array.isArray(result && result.errors) ? result.errors.length : 0
  };
}

async function reorderFigmaHierarchyChildrenJob(job) {
  const plan = job && job.plan ? job.plan : {};
  const target = job && job.target ? job.target : (plan.target || {});
  const options = job && job.options ? job.options : {};
  const nodeId = String(target.nodeId || (plan.target && plan.target.nodeId) || "");
  if (!nodeId) {
    throw new Error("FIGMA_HIERARCHY_REORDER_CHILDREN missing target.nodeId");
  }
  if (!Array.isArray(plan.childNodeIds) || plan.childNodeIds.length === 0) {
    throw new Error("FIGMA_HIERARCHY_REORDER_CHILDREN missing plan.childNodeIds");
  }

  const root = await figma.getNodeByIdAsync(nodeId).catch(() => null);
  if (!root) {
    throw new Error(`Figma node not found: ${nodeId}`);
  }
  if (!("children" in root)) {
    throw new Error(`Figma node has no children: ${root.type}`);
  }

  await setCurrentPageForNode(root);
  const beforeBounds = getNodeBounds(root);
  const beforeChildren = collectHierarchyDirectChildren(root, beforeBounds, true);
  const beforeChildIds = beforeChildren.map((child) => child.id);
  const requestedIds = plan.childNodeIds.map((childId) => String(childId || ""));
  const validationErrors = validateHierarchyReorderPlan(requestedIds, beforeChildIds);
  if (validationErrors.length > 0) {
    return buildHierarchyReorderBlockedResult(root, beforeChildren, validationErrors);
  }

  const beforeBoundsById = {};
  for (const child of beforeChildren) {
    beforeBoundsById[child.id] = child.bounds;
  }

  const reorderedNodeIds = [];
  for (let index = 0; index < requestedIds.length; index++) {
    const child = await figma.getNodeByIdAsync(requestedIds[index]).catch(() => null);
    if (!child || child.parent !== root) {
      continue;
    }
    root.insertChild(index, child);
    reorderedNodeIds.push(child.id);
  }

  const afterBounds = getNodeBounds(root);
  const afterChildren = collectHierarchyDirectChildren(root, afterBounds, true);
  const driftNodes = collectHierarchyReorderBoundsDrift(afterChildren, beforeBoundsById, 0.01);
  const includeScreenshot = options.includeScreenshot !== false;
  const screenshot = includeScreenshot ? await exportNodePngScreenshot(root) : null;
  const afterIds = afterChildren.map((child) => child.id);
  const afterNames = afterChildren.map((child) => child.name);
  const expectedNames = requestedIds.map((childId) => {
    const beforeRecord = beforeChildren.find((child) => child.id === childId);
    return beforeRecord ? beforeRecord.name : "";
  });
  const checks = {
    rootSizeUnchanged: {
      pass: Math.abs(beforeBounds.width - afterBounds.width) <= 0.01 && Math.abs(beforeBounds.height - afterBounds.height) <= 0.01,
      before: boundsToManifest(beforeBounds),
      after: boundsToManifest(afterBounds)
    },
    childSetPreserved: {
      pass: afterIds.length === beforeChildIds.length && uniqueStrings(afterIds).length === beforeChildIds.length && requestedIds.join("|") === afterIds.join("|"),
      before: beforeChildIds,
      expected: requestedIds,
      after: afterIds
    },
    orderMatchesPlan: {
      pass: requestedIds.join("|") === afterIds.join("|"),
      expectedNames,
      actualNames: afterNames
    },
    boundsPreserved: {
      pass: driftNodes.length === 0,
      driftCount: driftNodes.length,
      driftNodes
    },
    screenshotExported: { pass: !!screenshot || !includeScreenshot }
  };
  const blockingErrors = buildHierarchyApplyBlockingErrors(checks);

  return {
    status: blockingErrors.length === 0 ? "completed" : "blocked",
    allPass: blockingErrors.length === 0,
    rootNodeId: root.id,
    rootName: root.name || "",
    rootBounds: boundsToManifest(afterBounds),
    beforeChildren,
    afterChildren,
    screenshot,
    blockingErrors,
    warnings: [],
    summary: {
      beforeDirectChildCount: beforeChildren.length,
      afterDirectChildCount: afterChildren.length,
      reorderedChildren: reorderedNodeIds.length,
      order: afterNames
    },
    checks,
    artifacts: {
      before: {
        rootBounds: boundsToManifest(beforeBounds),
        directChildIds: beforeChildIds
      },
      after: {
        rootBounds: boundsToManifest(afterBounds),
        directChildIds: afterIds
      },
      plan,
      mutatedNodeIds: reorderedNodeIds
    },
    errors: []
};
}

/** 创建 ComponentSet，并把目标容器中的重复子节点替换为对应变体实例。 */
async function createComponentSetVariantsJob(job) {
  const plan = job && job.plan ? job.plan : {};
  const target = job && job.target ? job.target : (plan.target || {});
  const options = job && job.options ? job.options : {};
  if (isComponentSetSelectionSource(job, plan, target)) {
    return await createComponentSetVariantsFromSelectionJob(job, plan, target, options);
  }
  const nodeId = String(target.nodeId || (plan.target && plan.target.nodeId) || "");
  if (!nodeId) {
    throw new Error("FIGMA_CREATE_COMPONENT_SET_VARIANTS missing target.nodeId");
  }

  const root = await figma.getNodeByIdAsync(nodeId).catch(() => null);
  if (!root) {
    throw new Error(`Figma node not found: ${nodeId}`);
  }
  if (!("children" in root)) {
    throw new Error(`Figma node has no children: ${root.type}`);
  }

  await setCurrentPageForNode(root);
  const beforeBounds = getNodeBounds(root);
  const beforeChildren = collectHierarchyDirectChildren(root, beforeBounds, true);
  const variants = normalizeComponentSetVariantPlans(plan.variants);
  const variantProperty = String(plan.variantProperty || "State").trim() || "State";
  const componentSetName = String(plan.componentSetName || "Item").trim() || "Item";
  const validationErrors = validateComponentSetVariantPlan(root, beforeChildren, variants, variantProperty);
  if (validationErrors.length > 0) {
    return buildComponentSetVariantsBlockedResult(root, beforeChildren, validationErrors);
  }

  // 检测变体来源节点是否在备份帧内（坐标污染风险）
  const csWarnings = [];
  for (const variant of variants) {
    const nodeId = String(variant.nodeId || "");
    if (!nodeId) continue;
    const node = await figma.getNodeByIdAsync(nodeId).catch(() => null);
    if (node && node.parent && isBackupFrame(node.parent)) {
      csWarnings.push({
        code: "variantSourceInBackupFrame",
        message: `变体来源节点 "${variant.value || node.name}" (${nodeId}) 当前在备份帧 "${node.parent.name}" 中。ComponentSet 创建后 INSTANCE 内部子节点坐标可能偏移。建议先 restore 或 clone-node。`,
        details: { variantValue: variant.value, nodeId, parentName: node.parent.name }
      });
    }
  }

  const beforeNodeData = await collectComponentSetSourceNodeData(root, beforeChildren);
  const libraryFrame = createComponentSetLibraryFrame(root, componentSetName, beforeBounds, variants.length);
  const variantComponents = await createVariantComponentsInLibrary(libraryFrame, variants, beforeNodeData, variantProperty);
  const componentSet = figma.combineAsVariants(variantComponents, libraryFrame);
  componentSet.name = componentSetName;
  componentSet.x = 0;
  componentSet.y = 0;
  if ("clipsContent" in componentSet) {
    componentSet.clipsContent = false;
  }
  writePluginData(componentSet, {
    generatedBy: "componentSetVariants",
    sourceRootNodeId: root.id,
    variantProperty
  });

  const backupFrame = plan.createBackup === false
    ? null
    : createComponentSetBackupFrame(root, componentSetName, beforeBounds, libraryFrame);
  const variantComponentByValue = collectVariantComponentsByValue(componentSet, variantProperty);
  const replacement = plan.replaceOriginalsWithInstances === false
    ? { instances: [], movedSourceNodeIds: [] }
    : await replaceComponentSetSourcesWithInstances(root, beforeChildren, variants, beforeNodeData, variantComponentByValue, backupFrame, variantProperty);

  const afterBounds = getNodeBounds(root);
  const afterChildren = collectHierarchyDirectChildren(root, afterBounds, true);
  const driftNodes = collectComponentSetInstanceBoundsDrift(replacement.instances, beforeNodeData, 0.01);
  const variantNineSliceReports = buildVariantNineSliceReports(variants, beforeNodeData, variantComponentByValue, variantProperty);
  const includeScreenshot = options.includeScreenshot !== false;
  const screenshot = includeScreenshot ? await exportNodePngScreenshot(root) : null;
  const checks = {
    rootSizeUnchanged: {
      pass: Math.abs(beforeBounds.width - afterBounds.width) <= 0.01 && Math.abs(beforeBounds.height - afterBounds.height) <= 0.01,
      before: boundsToManifest(beforeBounds),
      after: boundsToManifest(afterBounds)
    },
    componentSetCreated: {
      pass: componentSet.type === "COMPONENT_SET" && componentSet.children.length === variants.length,
      componentSetId: componentSet.id,
      componentSetName: componentSet.name,
      variantCount: componentSet.children.length,
      expectedVariantCount: variants.length
    },
    contentChildCountPreserved: {
      pass: afterChildren.length === beforeChildren.length,
      before: beforeChildren.length,
      after: afterChildren.length
    },
    contentChildrenAreInstances: {
      pass: afterChildren.every((child) => child.type === "INSTANCE"),
      actualTypes: afterChildren.map((child) => child.type)
    },
    contentOrderPreserved: {
      pass: afterChildren.map((child) => child.name).join("|") === beforeChildren.map((child) => child.name).join("|"),
      before: beforeChildren.map((child) => child.name),
      after: afterChildren.map((child) => child.name)
    },
    boundsPreserved: {
      pass: driftNodes.length === 0,
      driftCount: driftNodes.length,
      driftNodes
    },
    sourceNodesBackedUp: {
      pass: !!backupFrame && replacement.movedSourceNodeIds.length === beforeChildren.length,
      backupFrameId: backupFrame ? backupFrame.id : "",
      movedSourceNodeIds: replacement.movedSourceNodeIds,
      expectedCount: beforeChildren.length
    },
    nineSlicePreservedInVariants: {
      pass: variantNineSliceReports.every((item) => item.pass),
      reports: variantNineSliceReports
    },
    screenshotExported: { pass: !!screenshot || !includeScreenshot }
  };
  const blockingErrors = buildHierarchyApplyBlockingErrors(checks);

  return {
    status: blockingErrors.length === 0 ? "completed" : "blocked",
    allPass: blockingErrors.length === 0,
    rootNodeId: root.id,
    rootName: root.name || "",
    nodeType: root.type,
    rootBounds: boundsToManifest(afterBounds),
    beforeChildren,
    afterChildren,
    screenshot,
    blockingErrors,
    warnings: csWarnings,
    summary: {
      componentSetId: componentSet.id,
      componentSetName: componentSet.name,
      variantProperty,
      variantCount: componentSet.children.length,
      replacedInstanceCount: replacement.instances.length,
      backupFrameId: backupFrame ? backupFrame.id : ""
    },
    checks,
    artifacts: {
      before: {
        rootBounds: boundsToManifest(beforeBounds),
        directChildIds: beforeChildren.map((child) => child.id)
      },
      after: {
        rootBounds: boundsToManifest(afterBounds),
        directChildIds: afterChildren.map((child) => child.id)
      },
      plan,
      componentSetId: componentSet.id,
      libraryFrameId: libraryFrame.id,
      backupFrameId: backupFrame ? backupFrame.id : "",
      instanceMappings: replacement.instances
    },
    errors: []
  };
}

/** 判断 ComponentSet 创建任务是否来自用户当前手动选择。 */
function isComponentSetSelectionSource(job, plan, target) {
  const source = String((job && job.source) || (plan && plan.source) || (target && target.source) || "").trim();
  return source === "selection" || source === "current-selection" || source === "currentSelection";
}

/** 基于用户当前选择创建 ComponentSet，不依赖 Content 直接子节点完整覆盖规则。 */
async function createComponentSetVariantsFromSelectionJob(job, plan, target, options) {
  const selection = figma.currentPage.selection.slice();
  const variantProperty = String(plan.variantProperty || "State").trim() || "State";
  const componentSetName = String(plan.componentSetName || target.componentSetName || "ManualSelectionSet").trim() || "ManualSelectionSet";
  const variants = normalizeSelectionComponentSetVariantPlans(selection, plan.variants, variantProperty);
  const validationErrors = validateSelectionComponentSetVariantPlan(selection, variants, variantProperty);
  if (validationErrors.length > 0) {
    return buildSelectionComponentSetBlockedResult(selection, validationErrors);
  }

  const selectionRecords = collectSelectionComponentSetRecords(selection);
  const sourceNodeData = await collectManualComponentSetSourceNodeData(selectionRecords);
  const selectionBounds = unionBounds(selectionRecords.map((item) => item.bounds));
  const libraryFrame = createManualComponentSetLibraryFrame(selection[0], componentSetName, selectionBounds, selectionRecords.length);
  const variantComponents = await createVariantComponentsInLibrary(libraryFrame, variants, sourceNodeData, variantProperty);
  const componentSet = figma.combineAsVariants(variantComponents, libraryFrame);
  componentSet.name = componentSetName;
  componentSet.x = 0;
  componentSet.y = 0;
  if ("clipsContent" in componentSet) {
    componentSet.clipsContent = false;
  }
  writePluginData(componentSet, {
    generatedBy: "manualSelectionComponentSet",
    source: "selection",
    variantProperty
  });

  const includeScreenshot = options.includeScreenshot !== false;
  const screenshot = includeScreenshot ? await exportNodePngScreenshot(componentSet) : null;
  const variantNineSliceReports = buildVariantNineSliceReports(variants, sourceNodeData, collectVariantComponentsByValue(componentSet, variantProperty), variantProperty);
  const preservedSourceNodeIds = await collectExistingNodeIds(selectionRecords.map((record) => record.id));
  const checks = {
    selectionCountMatches: {
      pass: selectionRecords.length === variants.length,
      selectionCount: selectionRecords.length,
      variantPlanCount: variants.length
    },
    componentSetCreated: {
      pass: componentSet.type === "COMPONENT_SET" && componentSet.children.length === variants.length,
      componentSetId: componentSet.id,
      componentSetName: componentSet.name,
      variantCount: componentSet.children.length,
      expectedVariantCount: variants.length
    },
    sourceNodesPreserved: {
      pass: preservedSourceNodeIds.length === selectionRecords.length,
      sourceNodeIds: selectionRecords.map((record) => record.id)
    },
    nineSlicePreservedInVariants: {
      pass: variantNineSliceReports.every((item) => item.pass),
      reports: variantNineSliceReports
    },
    screenshotExported: { pass: !!screenshot || !includeScreenshot }
  };
  const blockingErrors = buildHierarchyApplyBlockingErrors(checks);

  await setCurrentPageForNode(componentSet);
  figma.currentPage.selection = [componentSet];
  figma.viewport.scrollAndZoomIntoView([componentSet]);

  return {
    status: blockingErrors.length === 0 ? "completed" : "blocked",
    allPass: blockingErrors.length === 0,
    rootNodeId: componentSet.id,
    rootName: componentSet.name || "",
    nodeType: componentSet.type,
    rootBounds: boundsToManifest(getNodeBounds(componentSet)),
    beforeChildren: selectionRecords,
    afterChildren: collectHierarchyDirectChildren(componentSet, getNodeBounds(componentSet), true),
    screenshot,
    blockingErrors,
    warnings: [],
    summary: {
      source: "selection",
      componentSetId: componentSet.id,
      componentSetName: componentSet.name,
      variantProperty,
      variantCount: componentSet.children.length,
      selectedNodeCount: selectionRecords.length,
      replacedInstanceCount: 0,
      backupFrameId: ""
    },
    checks,
    artifacts: {
      before: {
        selectedNodeIds: selectionRecords.map((record) => record.id),
        selectedNodeNames: selectionRecords.map((record) => record.name)
      },
      after: {
        componentSetId: componentSet.id,
        variantComponentIds: componentSet.children.map((child) => child.id)
      },
      plan,
      componentSetId: componentSet.id,
      libraryFrameId: libraryFrame.id
    },
    errors: []
  };
}

/** 规范化 ComponentSet 变体计划，确保后续逻辑只处理字符串字段。 */
function normalizeComponentSetVariantPlans(rawVariants) {
  const output = [];
  for (const item of rawVariants || []) {
    if (!item) {
      continue;
    }
    const properties = {};
    if (item.properties && typeof item.properties === "object") {
      for (const key of Object.keys(item.properties)) {
        const normalizedKey = String(key || "").trim();
        const normalizedValue = String(item.properties[key] || "").trim();
        if (normalizedKey && normalizedValue) {
          properties[normalizedKey] = normalizedValue;
        }
      }
    }
    const fallbackValue = String(item.value || item.state || item.name || "").trim();
    output.push({
      nodeId: String(item.nodeId || "").trim(),
      value: fallbackValue,
      properties
    });
  }
  return output;
}

/** 根据当前选择和用户传入计划生成变体计划；未指定时按选择顺序生成 Variant1。 */
function normalizeSelectionComponentSetVariantPlans(selection, rawVariants, variantProperty) {
  const planned = normalizeComponentSetVariantPlans(rawVariants);
  const output = [];
  for (let index = 0; index < selection.length; index++) {
    const node = selection[index];
    const plan = planned[index] || {};
    const properties = plan.properties && Object.keys(plan.properties).length > 0
      ? plan.properties
      : {};
    output.push({
      nodeId: String(plan.nodeId || node.id || "").trim(),
      value: String(plan.value || `Variant${index + 1}`).trim(),
      properties
    });
  }
  return output;
}

/** 校验变体计划必须完整覆盖目标容器当前直接子节点。 */
function validateComponentSetVariantPlan(root, beforeChildren, variants, variantProperty) {
  const errors = [];
  if (isHierarchyAutoLayoutNode(root)) {
    errors.push({
      code: "rootAutoLayoutUnsupported",
      message: "目标 Content 启用了 Auto Layout，替换实例可能改变布局，已阻止写入。",
      details: { layoutMode: root.layoutMode }
    });
  }
  if (!variantProperty) {
    errors.push({ code: "missingVariantProperty", message: "缺少变体属性名。", details: {} });
  }
  if (!Array.isArray(variants) || variants.length === 0) {
    errors.push({ code: "missingVariants", message: "缺少 ComponentSet 变体计划。", details: {} });
    return errors;
  }
  const beforeIds = beforeChildren.map((child) => child.id);
  const variantIds = variants.map((item) => item.nodeId);
  const propertySignatures = variants.map((item) => buildVariantPropertySignature(item, variantProperty));
  const duplicateIds = uniqueStrings(variantIds.filter((id, index) => variantIds.indexOf(id) !== index));
  const duplicateValues = uniqueStrings(propertySignatures.filter((value, index, array) => array.indexOf(value) !== index));
  const missing = beforeIds.filter((id) => variantIds.indexOf(id) < 0);
  const extra = variantIds.filter((id) => beforeIds.indexOf(id) < 0);
  const emptyValues = variants.filter((item) => !buildVariantPropertySignature(item, variantProperty)).map((item) => item.nodeId);
  const unsupportedTypes = beforeChildren.filter((child) => variantIds.indexOf(child.id) >= 0 && child.type !== "FRAME");
  if (duplicateIds.length > 0) {
    errors.push({ code: "duplicateVariantNodeIds", message: "变体计划中存在重复节点 id。", details: { nodeIds: duplicateIds } });
  }
  if (duplicateValues.length > 0) {
    errors.push({ code: "duplicateVariantValues", message: "变体计划中存在重复变体属性组合。", details: { values: duplicateValues } });
  }
  if (missing.length > 0 || extra.length > 0 || variants.length !== beforeChildren.length) {
    errors.push({
      code: "variantNodeSetMismatch",
      message: "变体计划必须完整覆盖 Content 当前直接子节点。",
      details: { missing, extra, expectedCount: beforeChildren.length, actualCount: variants.length }
    });
  }
  if (emptyValues.length > 0) {
    errors.push({ code: "emptyVariantValues", message: "变体属性值不能为空。", details: { nodeIds: emptyValues } });
  }
  if (unsupportedTypes.length > 0) {
    errors.push({
      code: "unsupportedVariantSourceType",
      message: "当前只允许把 FRAME 任务项抽象为 ComponentSet 变体。",
      details: unsupportedTypes.map((child) => ({ id: child.id, name: child.name, type: child.type }))
    });
  }
  return errors;
}

/** 校验手动选择创建 ComponentSet 的输入，避免选择为空或变体重复。 */
function validateSelectionComponentSetVariantPlan(selection, variants, variantProperty) {
  const errors = [];
  if (!variantProperty) {
    errors.push({ code: "missingVariantProperty", message: "缺少变体属性名。", details: {} });
  }
  if (!Array.isArray(selection) || selection.length < 2) {
    errors.push({ code: "selectionTooSmall", message: "至少需要选中 2 个节点才能创建 ComponentSet。", details: { selectionCount: selection ? selection.length : 0 } });
    return errors;
  }
  if (!Array.isArray(variants) || variants.length !== selection.length) {
    errors.push({ code: "variantSelectionCountMismatch", message: "变体计划数量必须等于当前选择节点数量。", details: { selectionCount: selection.length, variantCount: variants ? variants.length : 0 } });
  }
  const unsupportedTypes = [];
  for (const node of selection) {
    if (!isManualComponentSetSourceNode(node)) {
      unsupportedTypes.push({ id: node.id, name: node.name || "", type: node.type });
    }
  }
  if (unsupportedTypes.length > 0) {
    errors.push({ code: "unsupportedSelectionSourceType", message: "当前选择中存在不能直接转 Component 的节点。", details: unsupportedTypes });
  }
  const variantIds = variants.map((item) => item.nodeId);
  const propertySignatures = variants.map((item) => buildVariantPropertySignature(item, variantProperty));
  const duplicateIds = uniqueStrings(variantIds.filter((id, index) => variantIds.indexOf(id) !== index));
  const duplicateValues = uniqueStrings(propertySignatures.filter((value, index, array) => array.indexOf(value) !== index));
  const emptyValues = variants.filter((item) => !buildVariantPropertySignature(item, variantProperty)).map((item) => item.nodeId);
  if (duplicateIds.length > 0) {
    errors.push({ code: "duplicateVariantNodeIds", message: "变体计划中存在重复节点 id。", details: { nodeIds: duplicateIds } });
  }
  if (duplicateValues.length > 0) {
    errors.push({ code: "duplicateVariantValues", message: "变体计划中存在重复变体属性组合。", details: { values: duplicateValues } });
  }
  if (emptyValues.length > 0) {
    errors.push({ code: "emptyVariantValues", message: "变体属性值不能为空。", details: { nodeIds: emptyValues } });
  }
  return errors;
}

/** 判断节点是否适合作为手动 ComponentSet 的源节点。 */
function isManualComponentSetSourceNode(node) {
  return !!node && "clone" in node && "width" in node && "height" in node;
}

/** 创建 ComponentSet 阻塞结果，避免计划不合法时产生部分写入。 */
function buildComponentSetVariantsBlockedResult(root, beforeChildren, validationErrors) {
  return {
    status: "blocked",
    allPass: false,
    rootNodeId: root.id,
    rootName: root.name || "",
    directChildren: beforeChildren,
    blockingErrors: validationErrors,
    warnings: [],
    summary: {
      beforeDirectChildCount: beforeChildren.length,
      variantCount: 0,
      replacedInstanceCount: 0
    },
    checks: {
      planValid: { pass: false }
    },
    artifacts: {},
    errors: validationErrors.map((item) => item.message)
  };
}

/** 创建手动选择 ComponentSet 的阻塞结果，不产生任何 Figma 写入。 */
function buildSelectionComponentSetBlockedResult(selection, validationErrors) {
  return {
    status: "blocked",
    allPass: false,
    rootNodeId: "",
    rootName: "",
    directChildren: collectSelectionComponentSetRecords(selection || []),
    blockingErrors: validationErrors,
    warnings: [],
    summary: {
      source: "selection",
      selectedNodeCount: selection ? selection.length : 0,
      variantCount: 0,
      replacedInstanceCount: 0
    },
    checks: {
      planValid: { pass: false }
    },
    artifacts: {},
    errors: validationErrors.map((item) => item.message)
  };
}

/** 收集源节点几何、约束和九宫数量，供替换实例后校验视觉不漂移。 */
async function collectComponentSetSourceNodeData(root, beforeChildren) {
  const data = {};
  for (const record of beforeChildren) {
    const node = await figma.getNodeByIdAsync(record.id).catch(() => null);
    if (!node || node.parent !== root) {
      continue;
    }
    data[record.id] = {
      node,
      name: node.name || "",
      type: node.type,
      x: numericOr(node.x, 0),
      y: numericOr(node.y, 0),
      width: positiveOr(node.width, 1),
      height: positiveOr(node.height, 1),
      bounds: record.bounds,
      constraints: "constraints" in node ? cloneObject(node.constraints) : null,
      nineSliceCount: countHierarchyNineSliceLikeNodes(node)
    };
  }
  return data;
}

/** 收集手动选择节点的轻量记录，用于回显和验证源节点未丢失。 */
function collectSelectionComponentSetRecords(selection) {
  const records = [];
  for (let index = 0; index < selection.length; index++) {
    const node = selection[index];
    const bounds = getNodeBounds(node);
    records.push({
      id: node.id,
      parentId: node.parent ? node.parent.id : "",
      index,
      name: node.name || "",
      type: node.type,
      path: node.name || "",
      visible: "visible" in node ? node.visible !== false : true,
      opacity: "opacity" in node ? numericOr(node.opacity, 1) : 1,
      bounds: boundsToManifest(bounds),
      relativeBounds: boundsToManifest({ x: 0, y: 0, width: bounds.width, height: bounds.height }),
      childCount: "children" in node ? node.children.length : 0,
      isNineSliceLike: isHierarchyNineSliceLike(node)
    });
  }
  return records;
}

/** 收集手动选择源节点的几何和九宫数量，供创建变体验证使用。 */
async function collectManualComponentSetSourceNodeData(selectionRecords) {
  const data = {};
  for (const record of selectionRecords) {
    const node = await figma.getNodeByIdAsync(record.id).catch(() => null);
    if (!node) {
      continue;
    }
    data[record.id] = {
      node,
      name: node.name || "",
      type: node.type,
      x: numericOr(node.x, 0),
      y: numericOr(node.y, 0),
      width: positiveOr(node.width, 1),
      height: positiveOr(node.height, 1),
      bounds: record.bounds,
      constraints: "constraints" in node ? cloneObject(node.constraints) : null,
      nineSliceCount: countHierarchyNineSliceLikeNodes(node)
    };
  }
  return data;
}

/** 合并多个 bounds，作为手动选择组件库摆放参考。 */
function unionBounds(boundsList) {
  const valid = (boundsList || []).filter((item) => item && positiveOr(item.width, 0) > 0 && positiveOr(item.height, 0) > 0);
  if (valid.length === 0) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  let left = valid[0].x;
  let top = valid[0].y;
  let right = valid[0].x + valid[0].width;
  let bottom = valid[0].y + valid[0].height;
  for (const bounds of valid.slice(1)) {
    left = Math.min(left, bounds.x);
    top = Math.min(top, bounds.y);
    right = Math.max(right, bounds.x + bounds.width);
    bottom = Math.max(bottom, bounds.y + bounds.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 使用 async API 检查节点是否仍存在，兼容 dynamic-page。 */
async function collectExistingNodeIds(nodeIds) {
  const existing = [];
  for (const nodeId of nodeIds || []) {
    const node = await figma.getNodeByIdAsync(nodeId).catch(() => null);
    if (node) {
      existing.push(nodeId);
    }
  }
  return existing;
}

/** 在当前页面创建组件库容器，放在目标 Content 右侧，避免影响原 UI 截图。 */
function createComponentSetLibraryFrame(root, componentSetName, rootBounds, variantCount) {
  const page = findContainingPage(root) || figma.currentPage;
  const frame = figma.createFrame();
  frame.name = makeUniqueDirectChildName(page, `[ComponentLibrary_${componentSetName}]`);
  frame.x = rootBounds.x + rootBounds.width + 160;
  frame.y = rootBounds.y;
  frame.resize(Math.max(rootBounds.width + 80, 1), Math.max(variantCount * (rootBounds.height + 40), rootBounds.height, 1));
  frame.fills = [];
  frame.strokes = [];
  frame.clipsContent = false;
  if ("layoutMode" in frame) {
    frame.layoutMode = "NONE";
  }
  page.appendChild(frame);
  return frame;
}

/** 在手动选择区域右侧创建组件库容器，不移动用户选中的源节点。 */
function createManualComponentSetLibraryFrame(anchorNode, componentSetName, selectionBounds, variantCount) {
  const page = findContainingPage(anchorNode) || figma.currentPage;
  const frame = figma.createFrame();
  frame.name = makeUniqueDirectChildName(page, `[ComponentLibrary_${componentSetName}]`);
  frame.x = numericOr(selectionBounds.x, 0) + positiveOr(selectionBounds.width, 1) + 160;
  frame.y = numericOr(selectionBounds.y, 0);
  frame.resize(Math.max(positiveOr(selectionBounds.width, 1) + 80, 1), Math.max(variantCount * (positiveOr(selectionBounds.height, 1) + 40), positiveOr(selectionBounds.height, 1), 1));
  frame.fills = [];
  frame.strokes = [];
  frame.clipsContent = false;
  if ("layoutMode" in frame) {
    frame.layoutMode = "NONE";
  }
  page.appendChild(frame);
  return frame;
}

/** 基于显式节点组创建 ComponentSet，并将每组散节点替换成一个变体实例。 */
async function createComponentSetFromNodeGroupsJob(job) {
  const plan = job && job.plan ? job.plan : {};
  const target = job && job.target ? job.target : (plan.target || {});
  const options = job && job.options ? job.options : {};
  const rootId = String(target.nodeId || (plan.target && plan.target.nodeId) || "").trim();
  if (!rootId) {
    throw new Error("FIGMA_CREATE_COMPONENT_SET_FROM_NODE_GROUPS missing target.nodeId");
  }
  const root = await figma.getNodeByIdAsync(rootId).catch(() => null);
  if (!root) {
    throw new Error(`Figma node not found: ${rootId}`);
  }
  if (!("children" in root)) {
    throw new Error(`Figma node has no children: ${root.type}`);
  }

  await setCurrentPageForNode(root);
  const beforeBounds = getNodeBounds(root);
  const componentSetName = String(plan.componentSetName || "ManualSelectionComponentSet").trim() || "ManualSelectionComponentSet";
  const variantProperty = String(plan.variantProperty || "Value").trim() || "Value";
  const groups = await collectNodeGroupSources(plan.groups || []);
  const validationErrors = validateComponentSetNodeGroupPlan(root, groups, variantProperty);
  if (validationErrors.length > 0) {
    return buildComponentSetNodeGroupBlockedResult(root, groups, validationErrors);
  }

  const libraryFrame = createComponentSetLibraryFrame(root, componentSetName, beforeBounds, groups.length);
  const variants = groups.map((group) => ({
    nodeId: group.id,
    value: group.value,
    properties: group.properties
  }));
  const variantComponents = await createVariantComponentsFromNodeGroups(libraryFrame, groups, variantProperty);
  const componentSet = figma.combineAsVariants(variantComponents, libraryFrame);
  componentSet.name = componentSetName;
  componentSet.x = 0;
  componentSet.y = 0;
  if ("clipsContent" in componentSet) {
    componentSet.clipsContent = false;
  }
  writePluginData(componentSet, {
    generatedBy: "componentSetFromNodeGroups",
    sourceRootNodeId: root.id,
    variantProperty
  });

  const backupFrame = plan.createBackup === false
    ? null
    : createComponentSetBackupFrame(root, componentSetName, beforeBounds, libraryFrame);
  const variantComponentByValue = collectVariantComponentsByValue(componentSet, variantProperty);
  const replacement = plan.replaceOriginalsWithInstances === false
    ? { instances: [], movedSourceNodeIds: [] }
    : await replaceNodeGroupsWithInstances(root, groups, variantComponentByValue, backupFrame, variantProperty);

  const afterBounds = getNodeBounds(root);
  const afterChildren = collectHierarchyDirectChildren(root, afterBounds, true);
  const driftNodes = collectNodeGroupInstanceBoundsDrift(replacement.instances, groups, 0.01);
  const variantNineSliceReports = buildNodeGroupVariantNineSliceReports(groups, variantComponentByValue, variantProperty);
  const includeScreenshot = options.includeScreenshot !== false;
  const screenshot = includeScreenshot ? await exportNodePngScreenshot(root) : null;
  const checks = {
    rootSizeUnchanged: {
      pass: Math.abs(beforeBounds.width - afterBounds.width) <= 0.01 && Math.abs(beforeBounds.height - afterBounds.height) <= 0.01,
      before: boundsToManifest(beforeBounds),
      after: boundsToManifest(afterBounds)
    },
    componentSetCreated: {
      pass: componentSet.type === "COMPONENT_SET" && componentSet.children.length === groups.length,
      componentSetId: componentSet.id,
      componentSetName: componentSet.name,
      variantCount: componentSet.children.length,
      expectedVariantCount: groups.length
    },
    groupsReplacedWithInstances: {
      pass: replacement.instances.length === groups.length,
      replacedInstanceCount: replacement.instances.length,
      expectedCount: groups.length
    },
    sourceNodesBackedUp: {
      pass: !!backupFrame && replacement.movedSourceNodeIds.length === flattenNodeGroupIds(groups).length,
      backupFrameId: backupFrame ? backupFrame.id : "",
      movedSourceNodeIds: replacement.movedSourceNodeIds,
      expectedCount: flattenNodeGroupIds(groups).length
    },
    boundsPreserved: {
      pass: driftNodes.length === 0,
      driftCount: driftNodes.length,
      driftNodes
    },
    nineSlicePreservedInVariants: {
      pass: variantNineSliceReports.every((item) => item.pass),
      reports: variantNineSliceReports
    },
    screenshotExported: { pass: !!screenshot || !includeScreenshot }
  };
  const blockingErrors = buildHierarchyApplyBlockingErrors(checks);

  figma.currentPage.selection = [componentSet];
  figma.viewport.scrollAndZoomIntoView([componentSet]);

  return {
    status: blockingErrors.length === 0 ? "completed" : "blocked",
    allPass: blockingErrors.length === 0,
    rootNodeId: root.id,
    rootName: root.name || "",
    nodeType: root.type,
    rootBounds: boundsToManifest(afterBounds),
    beforeChildren: groups.map((group) => serializeNodeGroupRecord(group)),
    afterChildren,
    screenshot,
    blockingErrors,
    warnings: [],
    summary: {
      source: "node-groups",
      componentSetId: componentSet.id,
      componentSetName: componentSet.name,
      variantProperty,
      variantCount: componentSet.children.length,
      replacedInstanceCount: replacement.instances.length,
      backupFrameId: backupFrame ? backupFrame.id : ""
    },
    checks,
    artifacts: {
      before: {
        rootBounds: boundsToManifest(beforeBounds),
        groups: groups.map((group) => serializeNodeGroupRecord(group))
      },
      after: {
        rootBounds: boundsToManifest(afterBounds),
        directChildIds: afterChildren.map((child) => child.id),
        directChildNames: afterChildren.map((child) => child.name)
      },
      plan,
      componentSetId: componentSet.id,
      libraryFrameId: libraryFrame.id,
      backupFrameId: backupFrame ? backupFrame.id : "",
      instanceMappings: replacement.instances
    },
    errors: []
  };
}

/** 收集计划中的跨父级节点组，并记录每组节点的绝对边界。 */
async function collectNodeGroupSources(rawGroups) {
  const groups = [];
  for (let index = 0; index < (rawGroups || []).length; index++) {
    const raw = rawGroups[index] || {};
    const nodeIds = Array.isArray(raw.nodeIds) ? raw.nodeIds.map((id) => String(id || "").trim()).filter((id) => !!id) : [];
    const nodes = [];
    for (const nodeId of nodeIds) {
      const node = await figma.getNodeByIdAsync(nodeId).catch(() => null);
      if (node) {
        nodes.push(node);
      }
    }
    const records = nodes.map((node, nodeIndex) => buildNodeGroupChildRecord(node, nodeIndex));
    const bounds = unionBounds(records.map((record) => record.bounds));
    const value = String(raw.value || raw.name || `Variant${index + 1}`).trim();
    const properties = {};
    if (raw.properties && typeof raw.properties === "object") {
      for (const key of Object.keys(raw.properties)) {
        const normalizedKey = String(key || "").trim();
        const normalizedValue = String(raw.properties[key] || "").trim();
        if (normalizedKey && normalizedValue) {
          properties[normalizedKey] = normalizedValue;
        }
      }
    }
    groups.push({
      id: `nodeGroup:${index + 1}`,
      name: String(raw.name || `[Milestone_${index + 1}_${value}]`).trim(),
      value,
      properties,
      nodeIds,
      nodes,
      records,
      bounds
    });
  }
  return groups;
}

/** 构建节点组成员记录，保留父级、索引和绝对边界用于校验。 */
function buildNodeGroupChildRecord(node, index) {
  const bounds = getNodeBounds(node);
  return {
    id: node.id,
    parentId: node.parent ? node.parent.id : "",
    index,
    name: node.name || "",
    type: node.type,
    visible: "visible" in node ? node.visible !== false : true,
    opacity: "opacity" in node ? numericOr(node.opacity, 1) : 1,
    bounds: boundsToManifest(bounds),
    width: positiveOr(node.width, bounds.width),
    height: positiveOr(node.height, bounds.height),
    childCount: "children" in node ? node.children.length : 0,
    isNineSliceLike: isHierarchyNineSliceLike(node),
    nineSliceCount: countHierarchyNineSliceLikeNodes(node)
  };
}

/** 校验跨父级节点组计划，避免节点缺失、重复或变体属性冲突。 */
function validateComponentSetNodeGroupPlan(root, groups, variantProperty) {
  const errors = [];
  if (isHierarchyAutoLayoutNode(root)) {
    errors.push({
      code: "rootAutoLayoutUnsupported",
      message: "目标容器启用了 Auto Layout，替换实例可能改变布局，已阻止写入。",
      details: { rootId: root.id, layoutMode: root.layoutMode }
    });
  }
  if (!variantProperty) {
    errors.push({ code: "missingVariantProperty", message: "缺少变体属性名。", details: {} });
  }
  if (!Array.isArray(groups) || groups.length < 2) {
    errors.push({ code: "nodeGroupTooSmall", message: "至少需要 2 组节点才能创建 ComponentSet。", details: { groupCount: groups ? groups.length : 0 } });
    return errors;
  }
  const allIds = flattenNodeGroupIds(groups);
  const duplicateIds = uniqueStrings(allIds.filter((id, index) => allIds.indexOf(id) !== index));
  if (duplicateIds.length > 0) {
    errors.push({ code: "duplicateNodeIds", message: "节点组计划中存在重复节点 id。", details: { nodeIds: duplicateIds } });
  }
  const missingGroups = groups.filter((group) => group.nodeIds.length === 0 || group.nodes.length !== group.nodeIds.length);
  if (missingGroups.length > 0) {
    errors.push({
      code: "nodeGroupMissingNodes",
      message: "节点组计划中存在找不到的节点。",
      details: missingGroups.map((group) => ({ name: group.name, expected: group.nodeIds, actual: group.nodes.map((node) => node.id) }))
    });
  }
  const unsupportedGroups = groups.filter((group) => group.nodes.some((node) => !isManualComponentSetSourceNode(node)));
  if (unsupportedGroups.length > 0) {
    errors.push({
      code: "unsupportedNodeGroupSourceType",
      message: "节点组中存在不能克隆为组件的节点。",
      details: unsupportedGroups.map((group) => ({ name: group.name, nodeIds: group.nodeIds }))
    });
  }
  const signatures = groups.map((group) => buildVariantPropertySignature({ value: group.value, properties: normalizeNodeGroupProperties(group, variantProperty) }, variantProperty));
  const duplicateValues = uniqueStrings(signatures.filter((value, index, array) => array.indexOf(value) !== index));
  if (duplicateValues.length > 0) {
    errors.push({ code: "duplicateVariantValues", message: "节点组变体属性组合重复。", details: { values: duplicateValues } });
  }
  const emptyValues = groups.filter((group, index) => !signatures[index]).map((group) => group.name);
  if (emptyValues.length > 0) {
    errors.push({ code: "emptyVariantValues", message: "节点组变体属性值不能为空。", details: { groups: emptyValues } });
  }
  return errors;
}

/** 创建节点组计划阻塞结果，不产生部分写入。 */
function buildComponentSetNodeGroupBlockedResult(root, groups, validationErrors) {
  return {
    status: "blocked",
    allPass: false,
    rootNodeId: root ? root.id : "",
    rootName: root ? root.name || "" : "",
    nodeType: root ? root.type : "",
    directChildren: (groups || []).map((group) => serializeNodeGroupRecord(group)),
    blockingErrors: validationErrors,
    warnings: [],
    summary: {
      source: "node-groups",
      groupCount: groups ? groups.length : 0,
      variantCount: 0,
      replacedInstanceCount: 0
    },
    checks: {
      planValid: { pass: false }
    },
    artifacts: {},
    errors: validationErrors.map((item) => item.message)
  };
}

/** 将节点组克隆为 Frame 后转 Component，供 combineAsVariants 合并。 */
async function createVariantComponentsFromNodeGroups(libraryFrame, groups, variantProperty) {
  const components = [];
  const gap = 40;
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    const frame = createFrameFromNodeGroupClones(group, buildVariantComponentName({ value: group.value, properties: normalizeNodeGroupProperties(group, variantProperty) }, variantProperty));
    libraryFrame.appendChild(frame);
    frame.x = 0;
    frame.y = index * (positiveOr(group.bounds.height, 1) + gap);
    safeResizeNode(frame, group.bounds.width, group.bounds.height);
    const component = figma.createComponentFromNode(frame);
    component.name = buildVariantComponentName({ value: group.value, properties: normalizeNodeGroupProperties(group, variantProperty) }, variantProperty);
    component.x = 0;
    component.y = index * (positiveOr(group.bounds.height, 1) + gap);
    safeResizeNode(component, group.bounds.width, group.bounds.height);
    writePluginData(component, {
      generatedBy: "componentSetNodeGroupVariant",
      sourceNodeIds: group.nodeIds.join(","),
      variantProperty,
      variantValue: buildVariantPropertySignature({ value: group.value, properties: normalizeNodeGroupProperties(group, variantProperty) }, variantProperty)
    });
    components.push(component);
  }
  return components;
}

/** 克隆节点组为 Frame，保持组内各节点的相对位置。 */
function createFrameFromNodeGroupClones(group, frameName) {
  const frame = figma.createFrame();
  frame.name = `[VariantSource_${frameName}]`;
  frame.resize(Math.max(positiveOr(group.bounds.width, 1), 1), Math.max(positiveOr(group.bounds.height, 1), 1));
  frame.fills = [];
  frame.strokes = [];
  frame.clipsContent = false;
  if ("layoutMode" in frame) {
    frame.layoutMode = "NONE";
  }
  for (const node of group.nodes) {
    const clone = node.clone();
    const bounds = getNodeBounds(node);
    frame.appendChild(clone);
    clone.x = numericOr(bounds.x, 0) - numericOr(group.bounds.x, 0);
    clone.y = numericOr(bounds.y, 0) - numericOr(group.bounds.y, 0);
    if ("constraints" in clone) {
      clone.constraints = { horizontal: "MIN", vertical: "MIN" };
    }
  }
  return frame;
}

/** 用变体实例替换跨父级散节点组，并将源节点移入隐藏备份。 */
async function replaceNodeGroupsWithInstances(root, groups, variantComponentByValue, backupFrame, variantProperty) {
  const instances = [];
  const movedSourceNodeIds = [];
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    const variantKey = buildVariantPropertySignature({ value: group.value, properties: normalizeNodeGroupProperties(group, variantProperty) }, variantProperty);
    const variantComponent = variantComponentByValue[variantKey];
    if (!variantComponent) {
      continue;
    }
    const instance = variantComponent.createInstance();
    root.appendChild(instance);
    instance.name = group.name;
    safeResizeNode(instance, group.bounds.width, group.bounds.height);
    instance.x = numericOr(group.bounds.x, 0) - numericOr(getNodeBounds(root).x, 0);
    instance.y = numericOr(group.bounds.y, 0) - numericOr(getNodeBounds(root).y, 0);
    instances.push({
      groupId: group.id,
      groupName: group.name,
      instanceId: instance.id,
      instanceName: instance.name,
      variantValue: variantKey,
      beforeBounds: boundsToManifest(group.bounds),
      afterBounds: boundsToManifest(getNodeBounds(instance))
    });
    for (let nodeIndex = 0; nodeIndex < group.nodes.length; nodeIndex++) {
      const node = group.nodes[nodeIndex];
      if (!node) {
        continue;
      }
      if (backupFrame) {
        backupFrame.appendChild(node);
        node.x = nodeIndex * (positiveOr(group.bounds.width, 1) + 20);
        node.y = index * (positiveOr(group.bounds.height, 1) + 20);
      } else {
        node.remove();
      }
      movedSourceNodeIds.push(node.id);
    }
  }
  return { instances, movedSourceNodeIds };
}

/** 检查节点组替换后的实例绝对边界是否保持。 */
function collectNodeGroupInstanceBoundsDrift(instances, groups, tolerance) {
  const groupById = {};
  for (const group of groups || []) {
    groupById[group.id] = group;
  }
  const driftNodes = [];
  for (const item of instances || []) {
    const group = groupById[item.groupId];
    if (!group) {
      continue;
    }
    const before = boundsToManifest(group.bounds);
    const after = item.afterBounds;
    const delta = Math.max(
      Math.abs(numericOr(before.x, 0) - numericOr(after.x, 0)),
      Math.abs(numericOr(before.y, 0) - numericOr(after.y, 0)),
      Math.abs(numericOr(before.width, 0) - numericOr(after.width, 0)),
      Math.abs(numericOr(before.height, 0) - numericOr(after.height, 0))
    );
    if (delta > tolerance) {
      driftNodes.push({
        groupId: item.groupId,
        name: item.groupName,
        instanceId: item.instanceId,
        variantValue: item.variantValue,
        delta: roundNumber(delta),
        before,
        after
      });
    }
  }
  return driftNodes;
}

/** 校验节点组变体中的九宫节点数量不减少。 */
function buildNodeGroupVariantNineSliceReports(groups, variantComponentByValue, variantProperty) {
  const reports = [];
  for (const group of groups || []) {
    const variantKey = buildVariantPropertySignature({ value: group.value, properties: normalizeNodeGroupProperties(group, variantProperty) }, variantProperty);
    const component = variantComponentByValue[variantKey];
    const beforeCount = group.records.reduce((sum, record) => sum + numericOr(record.nineSliceCount, 0), 0);
    const afterCount = component ? countHierarchyNineSliceLikeNodes(component) : 0;
    reports.push({
      groupId: group.id,
      groupName: group.name,
      variantValue: variantKey,
      beforeCount,
      afterCount,
      pass: afterCount >= beforeCount
    });
  }
  return reports;
}

/** 生成节点组的变体属性，未显式传入时使用主变体属性。 */
function normalizeNodeGroupProperties(group, variantProperty) {
  const properties = {};
  const raw = group && group.properties ? group.properties : {};
  for (const key of Object.keys(raw)) {
    const normalizedKey = String(key || "").trim();
    const normalizedValue = String(raw[key] || "").trim();
    if (normalizedKey && normalizedValue) {
      properties[normalizedKey] = normalizedValue;
    }
  }
  if (Object.keys(properties).length === 0 && group && group.value) {
    properties[variantProperty] = String(group.value);
  }
  return properties;
}

/** 展平所有节点组成员 id。 */
function flattenNodeGroupIds(groups) {
  const output = [];
  for (const group of groups || []) {
    for (const id of group.nodeIds || []) {
      output.push(id);
    }
  }
  return output;
}

/** 输出节点组轻量记录，供 JSON 验证和人工审查。 */
function serializeNodeGroupRecord(group) {
  return {
    id: group.id,
    name: group.name,
    value: group.value,
    properties: group.properties,
    nodeIds: group.nodeIds,
    bounds: boundsToManifest(group.bounds),
    children: group.records
  };
}

/** 基于当前选中节点的同父级同类节点重建 ComponentSet，并替换为对应变体实例。 */
async function rebuildComponentSetFromSiblingsJob(job) {
  const plan = job && job.plan ? job.plan : {};
  const options = job && job.options ? job.options : {};
  const selection = figma.currentPage.selection.slice();
  const variantProperty = String(plan.variantProperty || "State").trim() || "State";
  const componentSetName = String(plan.componentSetName || "Item").trim() || "Item";
  const selectedNode = selection.length === 1 ? selection[0] : null;
  const sourceParent = selectedNode && selectedNode.parent && "children" in selectedNode.parent ? selectedNode.parent : null;
  const beforeBounds = sourceParent ? getNodeBounds(sourceParent) : { x: 0, y: 0, width: 1, height: 1 };
  const siblingNodes = sourceParent ? selectSiblingVariantSourceNodes(sourceParent, selectedNode, plan) : [];
  const beforeChildren = collectSelectionComponentSetRecords(siblingNodes);
  const variants = buildSiblingComponentSetVariants(beforeChildren, plan, variantProperty);
  const validationErrors = validateRebuildSiblingComponentSetPlan(selection, selectedNode, sourceParent, beforeChildren, variants, variantProperty);
  if (validationErrors.length > 0) {
    return buildRebuildSiblingComponentSetBlockedResult(selectedNode, sourceParent, beforeChildren, validationErrors);
  }

  await setCurrentPageForNode(sourceParent);
  const beforeNodeData = await collectComponentSetSourceNodeData(sourceParent, beforeChildren);
  const libraryFrame = createComponentSetLibraryFrame(sourceParent, componentSetName, beforeBounds, variants.length);
  const variantComponents = await createVariantComponentsInLibrary(libraryFrame, variants, beforeNodeData, variantProperty);
  const componentSet = figma.combineAsVariants(variantComponents, libraryFrame);
  componentSet.name = componentSetName;
  componentSet.x = 0;
  componentSet.y = 0;
  if ("clipsContent" in componentSet) {
    componentSet.clipsContent = false;
  }
  writePluginData(componentSet, {
    generatedBy: "rebuildComponentSetFromSiblings",
    sourceRootNodeId: sourceParent.id,
    selectedNodeId: selectedNode.id,
    variantProperty
  });

  const backupFrame = plan.createBackup === false
    ? null
    : createComponentSetBackupFrame(sourceParent, componentSetName, beforeBounds, libraryFrame);
  const variantComponentByValue = collectVariantComponentsByValue(componentSet, variantProperty);
  const replacement = plan.replaceOriginalsWithInstances === false
    ? { instances: [], movedSourceNodeIds: [] }
    : await replaceComponentSetSourcesWithInstances(sourceParent, beforeChildren, variants, beforeNodeData, variantComponentByValue, backupFrame, variantProperty);

  const afterBounds = getNodeBounds(sourceParent);
  const afterChildren = collectHierarchyDirectChildren(sourceParent, afterBounds, true);
  const driftNodes = collectComponentSetInstanceBoundsDrift(replacement.instances, beforeNodeData, 0.01);
  const variantNineSliceReports = buildVariantNineSliceReports(variants, beforeNodeData, variantComponentByValue, variantProperty);
  const includeScreenshot = options.includeScreenshot !== false;
  const screenshot = includeScreenshot ? await exportNodePngScreenshot(sourceParent) : null;
  const checks = {
    parentSizeUnchanged: {
      pass: Math.abs(beforeBounds.width - afterBounds.width) <= 0.01 && Math.abs(beforeBounds.height - afterBounds.height) <= 0.01,
      before: boundsToManifest(beforeBounds),
      after: boundsToManifest(afterBounds)
    },
    componentSetCreated: {
      pass: componentSet.type === "COMPONENT_SET" && componentSet.children.length === variants.length,
      componentSetId: componentSet.id,
      componentSetName: componentSet.name,
      variantCount: componentSet.children.length,
      expectedVariantCount: variants.length
    },
    contentChildCountPreserved: {
      pass: afterChildren.length === beforeChildren.length,
      before: beforeChildren.length,
      after: afterChildren.length
    },
    contentChildrenAreInstances: {
      pass: afterChildren.every((child) => child.type === "INSTANCE"),
      actualTypes: afterChildren.map((child) => child.type)
    },
    contentOrderPreserved: {
      pass: afterChildren.map((child) => child.name).join("|") === beforeChildren.map((child) => child.name).join("|"),
      before: beforeChildren.map((child) => child.name),
      after: afterChildren.map((child) => child.name)
    },
    boundsPreserved: {
      pass: driftNodes.length === 0,
      driftCount: driftNodes.length,
      driftNodes
    },
    sourceNodesBackedUp: {
      pass: !!backupFrame && replacement.movedSourceNodeIds.length === beforeChildren.length,
      backupFrameId: backupFrame ? backupFrame.id : "",
      movedSourceNodeIds: replacement.movedSourceNodeIds,
      expectedCount: beforeChildren.length
    },
    nineSlicePreservedInVariants: {
      pass: variantNineSliceReports.every((item) => item.pass),
      reports: variantNineSliceReports
    },
    screenshotExported: { pass: !!screenshot || !includeScreenshot }
  };
  const blockingErrors = buildHierarchyApplyBlockingErrors(checks);

  figma.currentPage.selection = [componentSet];
  figma.viewport.scrollAndZoomIntoView([componentSet]);

  return {
    status: blockingErrors.length === 0 ? "completed" : "blocked",
    allPass: blockingErrors.length === 0,
    rootNodeId: sourceParent.id,
    rootName: sourceParent.name || "",
    nodeType: sourceParent.type,
    rootBounds: boundsToManifest(afterBounds),
    beforeChildren,
    afterChildren,
    screenshot,
    blockingErrors,
    warnings: [],
    summary: {
      source: "selected-siblings",
      selectedNodeId: selectedNode.id,
      selectedNodeName: selectedNode.name || "",
      componentSetId: componentSet.id,
      componentSetName: componentSet.name,
      variantProperty,
      variantCount: componentSet.children.length,
      replacedInstanceCount: replacement.instances.length,
      backupFrameId: backupFrame ? backupFrame.id : ""
    },
    checks,
    artifacts: {
      before: {
        rootBounds: boundsToManifest(beforeBounds),
        directChildIds: beforeChildren.map((child) => child.id),
        directChildNames: beforeChildren.map((child) => child.name)
      },
      after: {
        rootBounds: boundsToManifest(afterBounds),
        directChildIds: afterChildren.map((child) => child.id),
        directChildNames: afterChildren.map((child) => child.name)
      },
      plan,
      componentSetId: componentSet.id,
      libraryFrameId: libraryFrame.id,
      backupFrameId: backupFrame ? backupFrame.id : "",
      instanceMappings: replacement.instances
    },
    errors: []
  };
}

/** 选择当前节点同父级的变体来源节点，默认使用父级全部直接子节点。 */
function selectSiblingVariantSourceNodes(parent, selectedNode, plan) {
  const children = parent && "children" in parent ? parent.children.slice() : [];
  const explicitIds = plan && Array.isArray(plan.siblingNodeIds)
    ? plan.siblingNodeIds.map((id) => String(id || "").trim()).filter((id) => !!id)
    : [];
  if (explicitIds.length > 0) {
    const byId = {};
    for (const child of children) {
      byId[child.id] = child;
    }
    return explicitIds.map((id) => byId[id]).filter((node) => !!node);
  }
  const selectedSize = selectedNode ? { width: selectedNode.width, height: selectedNode.height } : null;
  return children.filter((child) => isSiblingVariantCandidate(child, selectedSize));
}

/** 判断同级节点是否适合作为本次重建的变体来源。 */
function isSiblingVariantCandidate(node, selectedSize) {
  if (!isManualComponentSetSourceNode(node)) {
    return false;
  }
  if (!selectedSize) {
    return true;
  }
  return Math.abs(positiveOr(node.width, 0) - positiveOr(selectedSize.width, 0)) <= 0.01 &&
    Math.abs(positiveOr(node.height, 0) - positiveOr(selectedSize.height, 0)) <= 0.01;
}

/** 根据同级节点名称推断变体属性，并保留节点顺序生成稳定计划。 */
function buildSiblingComponentSetVariants(beforeChildren, plan, variantProperty) {
  const planned = normalizeComponentSetVariantPlans(plan.variants);
  const plannedByNodeId = {};
  for (const item of planned) {
    if (item.nodeId) {
      plannedByNodeId[item.nodeId] = item;
    }
  }
  const output = [];
  for (let index = 0; index < beforeChildren.length; index++) {
    const record = beforeChildren[index];
    const explicit = plannedByNodeId[record.id] || planned[index] || {};
    const inferred = inferVariantValueFromSiblingName(record.name, index);
    const value = String(explicit.value || inferred.state || `Variant${index + 1}`).trim();
    const properties = explicit.properties && Object.keys(explicit.properties).length > 0
      ? explicit.properties
      : {};
    if (Object.keys(properties).length === 0) {
      properties[variantProperty] = value;
      if (inferred.index) {
        properties.Index = inferred.index;
      }
    }
    output.push({
      nodeId: record.id,
      value,
      properties
    });
  }
  return output;
}

/** 从类似 [Item_1_InProgress] 的节点名中推断序号和状态。 */
function inferVariantValueFromSiblingName(name, fallbackIndex) {
  const text = String(name || "");
  const match = text.match(/\[(?:[^\]_]+_)?(\d+)_([^\]]+)\]/);
  if (match) {
    return { index: match[1], state: match[2] };
  }
  const parts = text.replace(/^\[/, "").replace(/\]$/, "").split("_").filter((item) => !!item);
  if (parts.length >= 2) {
    const maybeIndex = parts.find((item) => /^\d+$/.test(item));
    const state = parts[parts.length - 1];
    return { index: maybeIndex || String(fallbackIndex + 1), state };
  }
  return { index: String(fallbackIndex + 1), state: `Variant${fallbackIndex + 1}` };
}

/** 校验同级重建计划，避免选区错误或同级集合不完整导致误替换。 */
function validateRebuildSiblingComponentSetPlan(selection, selectedNode, sourceParent, beforeChildren, variants, variantProperty) {
  const errors = [];
  if (!Array.isArray(selection) || selection.length !== 1) {
    errors.push({ code: "selectionCountInvalid", message: "同级重建 ComponentSet 需要且只需要选中 1 个模板节点。", details: { selectionCount: selection ? selection.length : 0 } });
  }
  if (!selectedNode) {
    errors.push({ code: "selectedNodeMissing", message: "未找到当前选中节点。", details: {} });
  }
  if (!sourceParent || !("children" in sourceParent)) {
    errors.push({ code: "parentMissing", message: "选中节点没有可处理的父级容器。", details: selectedNode ? { selectedNodeId: selectedNode.id } : {} });
  }
  if (sourceParent && isHierarchyAutoLayoutNode(sourceParent)) {
    errors.push({
      code: "parentAutoLayoutUnsupported",
      message: "父级容器启用了 Auto Layout，替换实例可能改变布局，已阻止写入。",
      details: { parentId: sourceParent.id, layoutMode: sourceParent.layoutMode }
    });
  }
  if (!variantProperty) {
    errors.push({ code: "missingVariantProperty", message: "缺少变体属性名。", details: {} });
  }
  if (!Array.isArray(beforeChildren) || beforeChildren.length < 2) {
    errors.push({ code: "siblingSourceTooSmall", message: "至少需要 2 个同父级来源节点才能重建 ComponentSet。", details: { sourceCount: beforeChildren ? beforeChildren.length : 0 } });
    return errors;
  }
  const unsupportedTypes = beforeChildren.filter((child) => !isManualComponentSetSourceRecord(child));
  if (unsupportedTypes.length > 0) {
    errors.push({
      code: "unsupportedSiblingSourceType",
      message: "同级来源中存在不能克隆为 Component 变体的节点。",
      details: unsupportedTypes.map((child) => ({ id: child.id, name: child.name, type: child.type }))
    });
  }
  const variantIds = variants.map((item) => item.nodeId);
  const propertySignatures = variants.map((item) => buildVariantPropertySignature(item, variantProperty));
  const duplicateIds = uniqueStrings(variantIds.filter((id, index) => variantIds.indexOf(id) !== index));
  const duplicateValues = uniqueStrings(propertySignatures.filter((value, index, array) => array.indexOf(value) !== index));
  const emptyValues = variants.filter((item) => !buildVariantPropertySignature(item, variantProperty)).map((item) => item.nodeId);
  if (variants.length !== beforeChildren.length) {
    errors.push({ code: "variantSiblingCountMismatch", message: "变体计划数量必须等于同级来源节点数量。", details: { siblingCount: beforeChildren.length, variantCount: variants.length } });
  }
  if (duplicateIds.length > 0) {
    errors.push({ code: "duplicateVariantNodeIds", message: "变体计划中存在重复节点 id。", details: { nodeIds: duplicateIds } });
  }
  if (duplicateValues.length > 0) {
    errors.push({ code: "duplicateVariantValues", message: "变体计划中存在重复变体属性组合。", details: { values: duplicateValues } });
  }
  if (emptyValues.length > 0) {
    errors.push({ code: "emptyVariantValues", message: "变体属性值不能为空。", details: { nodeIds: emptyValues } });
  }
  return errors;
}

/** 判断轻量节点记录是否可作为同级变体来源。 */
function isManualComponentSetSourceRecord(record) {
  return !!record && positiveOr(record.bounds && record.bounds.width, 0) > 0 && positiveOr(record.bounds && record.bounds.height, 0) > 0;
}

/** 同级重建阻塞时返回稳定结构，禁止产生部分 Figma 写入。 */
function buildRebuildSiblingComponentSetBlockedResult(selectedNode, sourceParent, beforeChildren, validationErrors) {
  return {
    status: "blocked",
    allPass: false,
    rootNodeId: sourceParent ? sourceParent.id : "",
    rootName: sourceParent ? sourceParent.name || "" : "",
    nodeType: sourceParent ? sourceParent.type : "",
    directChildren: beforeChildren || [],
    blockingErrors: validationErrors,
    warnings: [],
    summary: {
      source: "selected-siblings",
      selectedNodeId: selectedNode ? selectedNode.id : "",
      selectedNodeName: selectedNode ? selectedNode.name || "" : "",
      siblingCount: beforeChildren ? beforeChildren.length : 0,
      variantCount: 0,
      replacedInstanceCount: 0
    },
    checks: {
      planValid: { pass: false }
    },
    artifacts: {},
    errors: validationErrors.map((item) => item.message)
  };
}

/** 克隆当前选择节点，合成一个 Frame 后转为普通 Component。 */
async function createComponentFromSelectionJob(job) {
  const plan = job && job.plan ? job.plan : {};
  const options = job && job.options ? job.options : {};
  const selection = figma.currentPage.selection.slice();
  const componentName = String(plan.componentName || job.componentName || "ManualSelectionComponent").trim() || "ManualSelectionComponent";
  const validationErrors = validateComponentFromSelectionPlan(selection);
  if (validationErrors.length > 0) {
    return buildComponentFromSelectionBlockedResult(selection, validationErrors);
  }

  const selectionRecords = collectSelectionComponentSetRecords(selection);
  const beforeBounds = unionBounds(selectionRecords.map((record) => record.bounds));
  const frame = createFrameFromSelectionClones(selection, componentName, beforeBounds);
  const component = figma.createComponentFromNode(frame);
  component.name = componentName;
  if ("clipsContent" in component) {
    component.clipsContent = false;
  }
  writePluginData(component, {
    generatedBy: "componentFromSelection",
    source: "selection-clone",
    sourceNodeIds: selectionRecords.map((record) => record.id).join(",")
  });

  const preservedSourceNodeIds = await collectExistingNodeIds(selectionRecords.map((record) => record.id));
  const includeScreenshot = options.includeScreenshot !== false;
  const screenshot = includeScreenshot ? await exportNodePngScreenshot(component) : null;
  const componentBounds = getNodeBounds(component);
  const checks = {
    componentCreated: {
      pass: component.type === "COMPONENT",
      componentId: component.id,
      componentName: component.name
    },
    sourceSelectionCountPreserved: {
      pass: selectionRecords.length > 0 && component.children.length === selectionRecords.length,
      sourceSelectionCount: selectionRecords.length,
      componentChildCount: component.children.length
    },
    sourceNodesPreserved: {
      pass: preservedSourceNodeIds.length === selectionRecords.length,
      sourceNodeIds: selectionRecords.map((record) => record.id)
    },
    componentBoundsValid: {
      pass: positiveOr(componentBounds.width, 0) > 0 && positiveOr(componentBounds.height, 0) > 0,
      before: boundsToManifest(beforeBounds),
      after: boundsToManifest(componentBounds)
    },
    screenshotExported: { pass: !!screenshot || !includeScreenshot }
  };
  const blockingErrors = buildHierarchyApplyBlockingErrors(checks);

  await setCurrentPageForNode(component);
  figma.currentPage.selection = [component];
  figma.viewport.scrollAndZoomIntoView([component]);

  return {
    status: blockingErrors.length === 0 ? "completed" : "blocked",
    allPass: blockingErrors.length === 0,
    rootNodeId: component.id,
    rootName: component.name || "",
    nodeType: component.type,
    rootBounds: boundsToManifest(componentBounds),
    beforeChildren: selectionRecords,
    afterChildren: collectHierarchyDirectChildren(component, componentBounds, true),
    screenshot,
    blockingErrors,
    warnings: [],
    summary: {
      source: "selection-clone",
      componentId: component.id,
      componentName: component.name,
      selectedNodeCount: selectionRecords.length,
      childCount: component.children.length
    },
    checks,
    artifacts: {
      before: {
        selectedNodeIds: selectionRecords.map((record) => record.id),
        selectedNodeNames: selectionRecords.map((record) => record.name)
      },
      after: {
        componentId: component.id,
        componentName: component.name,
        childNodeIds: component.children.map((child) => child.id)
      },
      plan
    },
    errors: []
  };
}

/** 校验手动选择生成普通 Component 的输入。 */
function validateComponentFromSelectionPlan(selection) {
  const errors = [];
  if (!Array.isArray(selection) || selection.length === 0) {
    errors.push({ code: "selectionEmpty", message: "当前没有选中任何节点，无法生成 Component。", details: {} });
    return errors;
  }
  const unsupportedTypes = [];
  for (const node of selection) {
    if (!isManualComponentSetSourceNode(node)) {
      unsupportedTypes.push({ id: node.id, name: node.name || "", type: node.type });
    }
  }
  if (unsupportedTypes.length > 0) {
    errors.push({ code: "unsupportedSelectionSourceType", message: "当前选择中存在不能克隆到 Component 的节点。", details: unsupportedTypes });
  }
  return errors;
}

/** 创建普通 Component 的阻塞结果，不写入 Figma。 */
function buildComponentFromSelectionBlockedResult(selection, validationErrors) {
  return {
    status: "blocked",
    allPass: false,
    rootNodeId: "",
    rootName: "",
    nodeType: "",
    beforeChildren: collectSelectionComponentSetRecords(selection || []),
    afterChildren: [],
    blockingErrors: validationErrors,
    warnings: [],
    summary: {
      source: "selection-clone",
      selectedNodeCount: selection ? selection.length : 0,
      componentId: "",
      componentName: ""
    },
    checks: {
      planValid: { pass: false }
    },
    artifacts: {},
    errors: validationErrors.map((item) => item.message)
  };
}

/** 克隆当前选择节点到一个新 Frame，保持源节点不动。 */
function createFrameFromSelectionClones(selection, componentName, selectionBounds) {
  const page = findContainingPage(selection[0]) || figma.currentPage;
  const frame = figma.createFrame();
  frame.name = makeUniqueDirectChildName(page, `[ComponentSource_${componentName}]`);
  frame.x = numericOr(selectionBounds.x, 0) + positiveOr(selectionBounds.width, 1) + 160;
  frame.y = numericOr(selectionBounds.y, 0);
  frame.resize(Math.max(positiveOr(selectionBounds.width, 1), 1), Math.max(positiveOr(selectionBounds.height, 1), 1));
  frame.fills = [];
  frame.strokes = [];
  frame.clipsContent = false;
  if ("layoutMode" in frame) {
    frame.layoutMode = "NONE";
  }
  page.appendChild(frame);

  for (const node of selection) {
    const clone = node.clone();
    const bounds = getNodeBounds(node);
    frame.appendChild(clone);
    clone.x = numericOr(bounds.x, 0) - numericOr(selectionBounds.x, 0);
    clone.y = numericOr(bounds.y, 0) - numericOr(selectionBounds.y, 0);
    if ("constraints" in clone) {
      clone.constraints = { horizontal: "MIN", vertical: "MIN" };
    }
  }
  return frame;
}

/** 将当前选择节点追加为已有 ComponentSet 的新变体。 */
async function addComponentSetVariantsJob(job) {
  const plan = job && job.plan ? job.plan : {};
  const target = job && job.target ? job.target : (plan.target || {});
  const options = job && job.options ? job.options : {};
  const componentSetId = String(target.componentSetId || (plan.target && plan.target.componentSetId) || plan.componentSetId || "").trim();
  if (!componentSetId) {
    throw new Error("FIGMA_ADD_COMPONENT_SET_VARIANTS missing target.componentSetId");
  }

  const componentSet = await figma.getNodeByIdAsync(componentSetId).catch(() => null);
  if (!componentSet) {
    throw new Error(`ComponentSet not found: ${componentSetId}`);
  }
  if (componentSet.type !== "COMPONENT_SET") {
    throw new Error(`Target node is not COMPONENT_SET: ${componentSet.type}`);
  }

  await setCurrentPageForNode(componentSet);
  const selection = figma.currentPage.selection.filter((node) => node.id !== componentSet.id);
  const variantProperty = String(plan.variantProperty || inferComponentSetPrimaryVariantProperty(componentSet) || "State").trim() || "State";
  const variants = normalizeSelectionComponentSetVariantPlans(selection, plan.variants, variantProperty);
  const validationErrors = validateAddComponentSetVariantPlan(componentSet, selection, variants, variantProperty);
  if (validationErrors.length > 0) {
    return buildAddComponentSetVariantsBlockedResult(componentSet, selection, validationErrors);
  }

  const beforeVariantCount = componentSet.children.length;
  const selectionRecords = collectSelectionComponentSetRecords(selection);
  const sourceNodeData = await collectManualComponentSetSourceNodeData(selectionRecords);
  const addedComponents = await appendVariantComponentsToComponentSet(componentSet, variants, sourceNodeData, variantProperty);
  const includeScreenshot = options.includeScreenshot !== false;
  const screenshot = includeScreenshot ? await exportNodePngScreenshot(componentSet) : null;
  const variantNineSliceReports = buildVariantNineSliceReports(variants, sourceNodeData, collectVariantComponentsByValue(componentSet, variantProperty), variantProperty);
  const preservedSourceNodeIds = await collectExistingNodeIds(selectionRecords.map((record) => record.id));
  const checks = {
    selectionCountMatches: {
      pass: selectionRecords.length === variants.length,
      selectionCount: selectionRecords.length,
      variantPlanCount: variants.length
    },
    componentSetVariantCountIncreased: {
      pass: componentSet.children.length === beforeVariantCount + variants.length,
      before: beforeVariantCount,
      after: componentSet.children.length,
      added: variants.length
    },
    sourceNodesPreserved: {
      pass: preservedSourceNodeIds.length === selectionRecords.length,
      sourceNodeIds: selectionRecords.map((record) => record.id)
    },
    nineSlicePreservedInVariants: {
      pass: variantNineSliceReports.every((item) => item.pass),
      reports: variantNineSliceReports
    },
    screenshotExported: { pass: !!screenshot || !includeScreenshot }
  };
  const blockingErrors = buildHierarchyApplyBlockingErrors(checks);

  figma.currentPage.selection = [componentSet];
  figma.viewport.scrollAndZoomIntoView([componentSet]);

  return {
    status: blockingErrors.length === 0 ? "completed" : "blocked",
    allPass: blockingErrors.length === 0,
    rootNodeId: componentSet.id,
    rootName: componentSet.name || "",
    nodeType: componentSet.type,
    rootBounds: boundsToManifest(getNodeBounds(componentSet)),
    beforeChildren: selectionRecords,
    afterChildren: collectHierarchyDirectChildren(componentSet, getNodeBounds(componentSet), true),
    screenshot,
    blockingErrors,
    warnings: [],
    summary: {
      source: "selection",
      componentSetId: componentSet.id,
      componentSetName: componentSet.name,
      variantProperty,
      beforeVariantCount,
      addedVariantCount: addedComponents.length,
      variantCount: componentSet.children.length,
      selectedNodeCount: selectionRecords.length,
      replacedInstanceCount: 0
    },
    checks,
    artifacts: {
      before: {
        selectedNodeIds: selectionRecords.map((record) => record.id),
        selectedNodeNames: selectionRecords.map((record) => record.name),
        variantCount: beforeVariantCount
      },
      after: {
        componentSetId: componentSet.id,
        variantCount: componentSet.children.length,
        addedComponentIds: addedComponents.map((child) => child.id)
      },
      plan,
      componentSetId: componentSet.id
    },
    errors: []
  };
}

/** 推断 ComponentSet 的主要变体属性名。 */
function inferComponentSetPrimaryVariantProperty(componentSet) {
  if (!componentSet || componentSet.type !== "COMPONENT_SET") {
    return "";
  }
  for (const child of componentSet.children || []) {
    const props = child.variantProperties || {};
    const keys = Object.keys(props);
    if (keys.length > 0) {
      return keys[0];
    }
  }
  return "";
}

/** 校验追加变体计划，避免重复属性组合或选择不合法。 */
function validateAddComponentSetVariantPlan(componentSet, selection, variants, variantProperty) {
  const errors = validateSelectionComponentSetVariantPlan(selection, variants, variantProperty);
  const existingValues = [];
  for (const child of componentSet.children || []) {
    const key = buildVariantKeyFromComponent(child, variantProperty);
    if (key) {
      existingValues.push(key);
    }
  }
  const newValues = variants.map((item) => buildVariantPropertySignature(item, variantProperty));
  const duplicatedExisting = uniqueStrings(newValues.filter((value) => existingValues.indexOf(value) >= 0));
  if (duplicatedExisting.length > 0) {
    errors.push({ code: "variantValuesAlreadyExist", message: "已有 ComponentSet 中已存在相同变体属性组合。", details: { values: duplicatedExisting } });
  }
  return errors;
}

/** 创建追加变体的阻塞结果，不产生任何 Figma 写入。 */
function buildAddComponentSetVariantsBlockedResult(componentSet, selection, validationErrors) {
  return {
    status: "blocked",
    allPass: false,
    rootNodeId: componentSet ? componentSet.id : "",
    rootName: componentSet ? componentSet.name || "" : "",
    nodeType: componentSet ? componentSet.type : "",
    directChildren: collectSelectionComponentSetRecords(selection || []),
    blockingErrors: validationErrors,
    warnings: [],
    summary: {
      source: "selection",
      selectedNodeCount: selection ? selection.length : 0,
      addedVariantCount: 0,
      variantCount: componentSet && componentSet.children ? componentSet.children.length : 0
    },
    checks: {
      planValid: { pass: false }
    },
    artifacts: {},
    errors: validationErrors.map((item) => item.message)
  };
}

/** 将选择节点 clone 后转 Component，并追加进已有 ComponentSet。 */
async function appendVariantComponentsToComponentSet(componentSet, variants, sourceNodeData, variantProperty) {
  const components = [];
  const gap = 40;
  const currentCount = componentSet.children.length;
  const componentBounds = getNodeBounds(componentSet);
  for (let index = 0; index < variants.length; index++) {
    const variant = variants[index];
    const source = sourceNodeData[variant.nodeId];
    if (!source || !source.node) {
      continue;
    }
    const clone = cloneComponentSourceAsFrame(source, buildVariantComponentName(variant, variantProperty));
    const page = findContainingPage(componentSet) || figma.currentPage;
    page.appendChild(clone);
    clone.x = numericOr(componentSet.x, componentBounds.x) + (currentCount + index) * (source.width + gap);
    clone.y = numericOr(componentSet.y, componentBounds.y);
    safeResizeNode(clone, source.width, source.height);
    const component = figma.createComponentFromNode(clone);
    component.name = buildVariantComponentName(variant, variantProperty);
    componentSet.appendChild(component);
    component.x = (currentCount + index) * (source.width + gap);
    component.y = 0;
    safeResizeNode(component, source.width, source.height);
    writePluginData(component, {
      generatedBy: "componentSetVariant",
      sourceNodeId: variant.nodeId,
      variantProperty,
      variantValue: buildVariantPropertySignature(variant, variantProperty)
    });
    components.push(component);
  }
  return components;
}

/** 创建隐藏备份容器，保存被替换前的原始任务项节点，便于人工回退。 */
function createComponentSetBackupFrame(root, componentSetName, rootBounds, libraryFrame) {
  const page = findContainingPage(root) || figma.currentPage;
  const frame = figma.createFrame();
  frame.name = makeUniqueDirectChildName(page, `[ComponentSourceBackup_${componentSetName}]`);
  frame.x = numericOr(libraryFrame.x, rootBounds.x + rootBounds.width + 160);
  frame.y = numericOr(libraryFrame.y, rootBounds.y) + numericOr(libraryFrame.height, rootBounds.height) + 80;
  frame.resize(Math.max(rootBounds.width, 1), Math.max(rootBounds.height, 1));
  frame.fills = [];
  frame.strokes = [];
  frame.clipsContent = false;
  frame.visible = false;
  if ("layoutMode" in frame) {
    frame.layoutMode = "NONE";
  }
  page.appendChild(frame);
  return frame;
}

/** 克隆每个源任务项并转为 Component，之后交给 combineAsVariants 合并。 */
async function createVariantComponentsInLibrary(libraryFrame, variants, beforeNodeData, variantProperty) {
  const components = [];
  const gap = 40;
  for (let index = 0; index < variants.length; index++) {
    const variant = variants[index];
    const source = beforeNodeData[variant.nodeId];
    if (!source || !source.node) {
      continue;
    }
    const clone = cloneComponentSourceAsFrame(source, buildVariantComponentName(variant, variantProperty));
    libraryFrame.appendChild(clone);
    clone.x = 0;
    clone.y = index * (source.height + gap);
    safeResizeNode(clone, source.width, source.height);
    const component = figma.createComponentFromNode(clone);
    component.name = buildVariantComponentName(variant, variantProperty);
    component.x = 0;
    component.y = index * (source.height + gap);
    safeResizeNode(component, source.width, source.height);
    writePluginData(component, {
      generatedBy: "componentSetVariant",
      sourceNodeId: variant.nodeId,
      variantProperty,
      variantValue: buildVariantPropertySignature(variant, variantProperty)
    });
    components.push(component);
  }
  return components;
}

/** 克隆源节点为可转 Component 的 Frame，兼容 TEXT、RECTANGLE 等叶子节点。 */
function cloneComponentSourceAsFrame(source, frameName) {
  const node = source.node;
  if (node && (
    node.type === "FRAME" ||
    node.type === "GROUP" ||
    node.type === "COMPONENT" ||
    node.type === "COMPONENT_SET"
  )) {
    return node.clone();
  }

  const frame = figma.createFrame();
  frame.name = `[VariantSource_${frameName}]`;
  frame.resize(Math.max(source.width, 1), Math.max(source.height, 1));
  frame.fills = [];
  frame.strokes = [];
  frame.clipsContent = false;
  if ("layoutMode" in frame) {
    frame.layoutMode = "NONE";
  }
  const clone = node.clone();
  frame.appendChild(clone);
  clone.x = 0;
  clone.y = 0;
  if ("constraints" in clone) {
    clone.constraints = { horizontal: "MIN", vertical: "MIN" };
  }
  return frame;
}

/** 从 ComponentSet 子组件中按变体属性建立 value 到 Component 的映射。 */
function collectVariantComponentsByValue(componentSet, variantProperty) {
  const output = {};
  for (const child of componentSet.children || []) {
    if (child.type !== "COMPONENT") {
      continue;
    }
    const key = buildVariantKeyFromComponent(child, variantProperty);
    if (key) {
      output[key] = child;
    }
  }
  return output;
}

/** 生成 Figma 可识别的变体组件名，支持单属性和多属性。 */
function buildVariantComponentName(variant, variantProperty) {
  const properties = variant && variant.properties ? variant.properties : {};
  const keys = Object.keys(properties);
  if (keys.length > 0) {
    return keys.map((key) => `${key}=${properties[key]}`).join(", ");
  }
  return `${variantProperty}=${variant.value}`;
}

/** 为变体计划生成稳定签名，单属性与多属性都可用作查表 key。 */
function buildVariantPropertySignature(variant, variantProperty) {
  const properties = variant && variant.properties ? variant.properties : {};
  const keys = Object.keys(properties).sort();
  if (keys.length > 0) {
    return keys.map((key) => `${key}=${properties[key]}`).join("|");
  }
  const value = String(variant && variant.value || "").trim();
  return value ? `${variantProperty}=${value}` : "";
}

/** 从 Component 读取 Figma 变体属性并生成查表 key。 */
function buildVariantKeyFromComponent(component, variantProperty) {
  const props = component.variantProperties || {};
  const keys = Object.keys(props).sort();
  if (keys.length > 0) {
    return keys.map((key) => `${key}=${props[key]}`).join("|");
  }
  const fallbackValue = parseVariantValueFromName(component.name, variantProperty);
  return fallbackValue ? `${variantProperty}=${fallbackValue}` : "";
}

/** 从组件名中解析变体值，作为 variantProperties 不可读时的兜底。 */
function parseVariantValueFromName(name, variantProperty) {
  const prefix = `${variantProperty}=`;
  const parts = String(name || "").split(",");
  for (const part of parts) {
    const text = part.trim();
    if (text.indexOf(prefix) === 0) {
      return text.slice(prefix.length);
    }
  }
  return "";
}

/** 用对应变体实例替换 Content 直接子节点，并把源节点移动到隐藏备份容器。 */
async function replaceComponentSetSourcesWithInstances(root, beforeChildren, variants, beforeNodeData, variantComponentByValue, backupFrame, variantProperty) {
  const variantByNodeId = {};
  for (const variant of variants) {
    variantByNodeId[variant.nodeId] = variant;
  }
  const instances = [];
  for (const record of beforeChildren) {
    const variant = variantByNodeId[record.id];
    const source = beforeNodeData[record.id];
    const variantKey = variant ? buildVariantPropertySignature(variant, variantProperty) : "";
    const variantComponent = variant ? variantComponentByValue[variantKey] : null;
    if (!variant || !source || !variantComponent) {
      continue;
    }
    const instance = variantComponent.createInstance();
    root.appendChild(instance);
    instance.name = source.name;
    safeResizeNode(instance, source.width, source.height);
    instance.x = source.x;
    instance.y = source.y;
    if (source.constraints && "constraints" in instance) {
      instance.constraints = cloneObject(source.constraints);
    }
    instances.push({
      sourceNodeId: record.id,
      sourceName: source.name,
      instanceId: instance.id,
      instanceName: instance.name,
      variantValue: variantKey,
      beforeBounds: source.bounds,
      afterBounds: boundsToManifest(getNodeBounds(instance))
    });
  }

  const movedSourceNodeIds = [];
  for (let index = 0; index < beforeChildren.length; index++) {
    const record = beforeChildren[index];
    const source = beforeNodeData[record.id];
    if (!source || !source.node) {
      continue;
    }
    if (backupFrame) {
      backupFrame.appendChild(source.node);
      source.node.x = 0;
      source.node.y = index * (source.height + 12);
    } else {
      source.node.remove();
    }
    movedSourceNodeIds.push(record.id);
  }
  return { instances, movedSourceNodeIds };
}

/** 检查替换后的实例绝对 bounds 是否和源任务项一致。 */
function collectComponentSetInstanceBoundsDrift(instances, beforeNodeData, tolerance) {
  const driftNodes = [];
  for (const item of instances || []) {
    const source = beforeNodeData[item.sourceNodeId];
    if (!source) {
      continue;
    }
    const before = source.bounds;
    const after = item.afterBounds;
    const delta = Math.max(
      Math.abs(numericOr(before.x, 0) - numericOr(after.x, 0)),
      Math.abs(numericOr(before.y, 0) - numericOr(after.y, 0)),
      Math.abs(numericOr(before.width, 0) - numericOr(after.width, 0)),
      Math.abs(numericOr(before.height, 0) - numericOr(after.height, 0))
    );
    if (delta > tolerance) {
      driftNodes.push({
        sourceNodeId: item.sourceNodeId,
        instanceId: item.instanceId,
        name: item.sourceName,
        variantValue: item.variantValue,
        delta: roundNumber(delta),
        before,
        after
      });
    }
  }
  return driftNodes;
}

/** 校验每个变体组件仍保留源任务项中的九宫相关节点数量。 */
function buildVariantNineSliceReports(variants, beforeNodeData, variantComponentByValue, variantProperty) {
  const reports = [];
  for (const variant of variants) {
    const variantKey = buildVariantPropertySignature(variant, variantProperty);
    const source = beforeNodeData[variant.nodeId];
    const component = variantComponentByValue[variantKey];
    const beforeCount = source ? source.nineSliceCount : 0;
    const afterCount = component ? countHierarchyNineSliceLikeNodes(component) : 0;
    reports.push({
      sourceNodeId: variant.nodeId,
      variantValue: variantKey,
      beforeCount,
      afterCount,
      pass: afterCount >= beforeCount
    });
  }
  return reports;
}

/** 统计节点树中疑似九宫或切片节点数量，防止抽组件时误 flatten。 */
function countHierarchyNineSliceLikeNodes(node) {
  let count = isHierarchyNineSliceLike(node) ? 1 : 0;
  if ("children" in node) {
    for (const child of node.children) {
      count += countHierarchyNineSliceLikeNodes(child);
    }
  }
  return count;
}

/** 安全调整节点尺寸，统一保护最小尺寸并兼容不可 resize 的节点。 */
function safeResizeNode(node, width, height) {
  if (node && "resize" in node) {
    node.resize(Math.max(positiveOr(width, 1), 0.01), Math.max(positiveOr(height, 1), 0.01));
  }
}

/** 在同一父节点下生成唯一名称，避免重复尝试时覆盖旧组件库。 */
function makeUniqueDirectChildName(parent, baseName) {
  const names = {};
  if (parent && "children" in parent) {
    for (const child of parent.children) {
      names[child.name || ""] = true;
    }
  }
  if (!names[baseName]) {
    return baseName;
  }
  for (let index = 2; index < 1000; index++) {
    const candidate = `${baseName}_${index}`;
    if (!names[candidate]) {
      return candidate;
    }
  }
  return `${baseName}_${Date.now()}`;
}

/** 收集根节点直接子节点的轻量信息。 */
function collectHierarchyDirectChildren(root, rootBounds, includeHidden) {
  const output = [];
  if (!root || !("children" in root)) {
    return output;
  }
  for (let index = 0; index < root.children.length; index++) {
    const child = root.children[index];
    if (!includeHidden && child.visible === false) {
      continue;
    }
    output.push(buildHierarchyNodeRecord(child, root, rootBounds, "", index));
  }
  return output;
}

function collectHierarchyPlanChildIds(plan) {
  const plannedIds = [];
  for (const group of plan.groups || []) {
    for (const childId of group.childNodeIds || []) {
      plannedIds.push(String(childId));
    }
  }
  return plannedIds;
}

function normalizeHierarchyBeforeChildIds(beforeChildrenOrIds) {
  const output = [];
  for (const item of beforeChildrenOrIds || []) {
    if (typeof item === "string") {
      output.push(item);
    } else if (item && typeof item === "object" && item.id) {
      output.push(String(item.id));
    }
  }
  return output;
}

/** 递归收集节点信息，供计划脚本做语义分组。 */
function collectHierarchyCleanupNodes(node, root, rootBounds, output, includeHidden, maxDepth, depth, parentId) {
  if (!node || (!includeHidden && node.visible === false) || depth > maxDepth) {
    return;
  }
  const index = node.parent && "children" in node.parent ? node.parent.children.indexOf(node) : 0;
  output.push(buildHierarchyNodeRecord(node, root, rootBounds, parentId || "", index));
  if ("children" in node && depth < maxDepth) {
    for (const child of node.children) {
      collectHierarchyCleanupNodes(child, root, rootBounds, output, includeHidden, maxDepth, depth + 1, node.id);
    }
  }
}

/** 构建层级整理节点记录。 */
function buildHierarchyNodeRecord(node, root, rootBounds, parentId, index) {
  const bounds = getNodeBounds(node);
  const record = {
    id: node.id,
    parentId: parentId || (node.parent ? node.parent.id : ""),
    index,
    name: node.name || "",
    type: node.type,
    path: buildNodePath(node, root),
    visible: node.visible !== false,
    opacity: typeof node.opacity === "number" ? node.opacity : 1,
    bounds: boundsToManifest(bounds),
    relativeBounds: boundsToRelativeManifest(bounds, rootBounds),
    childCount: "children" in node && Array.isArray(node.children) ? node.children.length : 0,
    isNineSliceLike: isHierarchyNineSliceLike(node)
  };
  if (node.type === "TEXT") {
    record.characters = String(node.characters || "");
    record.fontSize = readFigmaFontSize(node);
  }
  return record;
}

/** 判断节点是否疑似九宫切片相关，计划和应用阶段都不应拆散。 */
function isHierarchyNineSliceLike(node) {
  const name = String((node && node.name) || "").toLowerCase();
  return name.indexOf("__slice") >= 0 || name.indexOf("jiugong") >= 0 || name.indexOf("nine-slice") >= 0 || name.indexOf("9slice") >= 0;
}

/** 判断节点是否启用了 Auto Layout；此类节点自动打组容易改变视觉布局。 */
function isHierarchyAutoLayoutNode(node) {
  return !!node && "layoutMode" in node && node.layoutMode && node.layoutMode !== "NONE";
}

/** 收集当前顶层分组信息。 */
function collectHierarchyTopLevelGroups(root) {
  const output = [];
  if (!root || !("children" in root)) {
    return output;
  }
  for (let index = 0; index < root.children.length; index++) {
    const child = root.children[index];
    output.push({
      id: child.id,
      name: child.name || "",
      type: child.type,
      index,
      childCount: "children" in child && Array.isArray(child.children) ? child.children.length : 0,
      bounds: boundsToManifest(getNodeBounds(child))
    });
  }
  return output;
}

/** 校验整理计划节点集合必须和根直接子节点完全一致。 */
function validateHierarchyCleanupPlan(plan, beforeChildrenOrIds, context) {
  const errors = [];
  const beforeChildIds = normalizeHierarchyBeforeChildIds(beforeChildrenOrIds);
  const planTarget = plan && plan.target ? plan.target : {};
  const planTargetNodeId = String(planTarget.nodeId || "");
  const rootNodeId = context && context.rootNodeId ? String(context.rootNodeId) : "";
  const jobTargetNodeId = context && context.targetNodeId ? String(context.targetNodeId) : "";
  if (!planTargetNodeId) {
    errors.push({
      code: "missingPlanTargetNodeId",
      message: "Hierarchy cleanup plan is missing target.nodeId.",
      details: {}
    });
  }
  if (planTargetNodeId && rootNodeId && planTargetNodeId !== rootNodeId) {
    errors.push({
      code: "planTargetRootMismatch",
      message: "Hierarchy cleanup plan target.nodeId must match the current root node.",
      details: { planTargetNodeId, rootNodeId }
    });
  }
  if (planTargetNodeId && jobTargetNodeId && planTargetNodeId !== jobTargetNodeId) {
    errors.push({
      code: "planTargetJobTargetMismatch",
      message: "Hierarchy cleanup plan target.nodeId must match the submitted job target.",
      details: { planTargetNodeId, jobTargetNodeId }
    });
  }
  for (const group of plan.groups || []) {
    const groupName = String(group.name || "");
    if (!/^\[[^\]]+\]$/.test(groupName)) {
      errors.push({
        code: "invalidGroupName",
        message: "新增分组名称必须使用方括号。",
        details: { groupName }
      });
    }
    if (!Array.isArray(group.childNodeIds) || group.childNodeIds.length === 0) {
      errors.push({
        code: "emptyChildNodeIds",
        message: "Each hierarchy cleanup group must contain at least one childNodeIds entry.",
        details: { groupName }
      });
    }
  }
  const plannedIds = collectHierarchyPlanChildIds(plan);
  const duplicateIds = plannedIds.filter((id, index) => plannedIds.indexOf(id) !== index);
  const uniqueDuplicateIds = uniqueStrings(duplicateIds);
  if (uniqueDuplicateIds.length > 0) {
    errors.push({
      code: "duplicateNodeIds",
      message: "计划中存在重复节点 id。",
      details: { nodeIds: uniqueDuplicateIds }
    });
  }

  const beforeSet = uniqueStrings(beforeChildIds);
  const plannedSet = uniqueStrings(plannedIds);
  const missing = beforeSet.filter((id) => plannedSet.indexOf(id) < 0);
  const extra = plannedSet.filter((id) => beforeSet.indexOf(id) < 0);
  if (missing.length > 0 || extra.length > 0) {
    errors.push({
      code: "planNodeSetMismatch",
      message: "计划节点集合必须与整理前根直接子节点完全一致。",
      details: { missing, extra }
    });
  }
  return errors;
}

/** Resolve planned cleanup nodes and require each node to be a direct child of root. */
async function resolveHierarchyCleanupPlanChildNodes(root, plan, beforeChildrenOrIds) {
  const errors = [];
  const nodesById = {};
  const beforeChildIds = normalizeHierarchyBeforeChildIds(beforeChildrenOrIds);
  const beforeChildIdSet = {};
  for (const id of beforeChildIds) {
    beforeChildIdSet[id] = true;
  }
  const plannedIds = uniqueStrings(collectHierarchyPlanChildIds(plan));
  for (const childId of plannedIds) {
    const node = await figma.getNodeByIdAsync(String(childId)).catch(() => null);
    if (!node) {
      errors.push({
        code: "plannedChildMissing",
        message: "Hierarchy cleanup plan references a node that no longer exists.",
        details: { nodeId: childId }
      });
      continue;
    }
    const parent = node.parent || null;
    if (parent !== root || beforeChildIdSet[childId] !== true) {
      errors.push({
        code: "childNotDirectChild",
        message: "Every hierarchy cleanup childNodeId must be a current direct child of target.nodeId.",
        details: {
          nodeId: childId,
          nodeName: node.name || "",
          expectedParentId: root.id,
          actualParentId: parent ? parent.id : "",
          actualParentName: parent ? (parent.name || "") : ""
        }
      });
      continue;
    }
    nodesById[childId] = node;
  }
  return { nodesById, errors };
}

/** 校验重排计划必须完整覆盖当前直接子节点且不能重复。 */
function validateHierarchyReorderPlan(requestedIds, beforeChildIds) {
  const errors = [];
  const duplicateIds = requestedIds.filter((id, index) => requestedIds.indexOf(id) !== index);
  const uniqueDuplicateIds = uniqueStrings(duplicateIds);
  if (uniqueDuplicateIds.length > 0) {
    errors.push({
      code: "duplicateNodeIds",
      message: "重排计划中存在重复节点 id。",
      details: { nodeIds: uniqueDuplicateIds }
    });
  }

  const beforeSet = uniqueStrings(beforeChildIds);
  const requestedSet = uniqueStrings(requestedIds);
  const missing = beforeSet.filter((id) => requestedSet.indexOf(id) < 0);
  const extra = requestedSet.filter((id) => beforeSet.indexOf(id) < 0);
  if (missing.length > 0 || extra.length > 0 || requestedIds.length !== beforeChildIds.length) {
    errors.push({
      code: "reorderNodeSetMismatch",
      message: "重排计划节点集合必须与当前根直接子节点完全一致。",
      details: { missing, extra, expectedCount: beforeChildIds.length, actualCount: requestedIds.length }
    });
  }
  return errors;
}

/** 计划阻塞时返回稳定结构，禁止部分应用。 */
function buildHierarchyCleanupBlockedResult(root, beforeChildren, validationErrors) {
  return {
    status: "blocked",
    allPass: false,
    rootNodeId: root.id,
    rootName: root.name || "",
    directChildren: beforeChildren,
    blockingErrors: validationErrors,
    warnings: [],
    summary: {
      beforeDirectChildCount: beforeChildren.length,
      createdGroups: 0,
      movedOriginalNodes: 0
    },
    checks: {
      planValid: { pass: false }
    },
    artifacts: {},
    errors: validationErrors.map((item) => item.message)
  };
}

/** 重排计划阻塞时返回稳定结构，禁止部分应用。 */
function buildHierarchyReorderBlockedResult(root, beforeChildren, validationErrors) {
  return {
    status: "blocked",
    allPass: false,
    rootNodeId: root.id,
    rootName: root.name || "",
    directChildren: beforeChildren,
    blockingErrors: validationErrors,
    warnings: [],
    summary: {
      beforeDirectChildCount: beforeChildren.length,
      reorderedChildren: 0
    },
    checks: {
      planValid: { pass: false }
    },
    artifacts: {},
    errors: validationErrors.map((item) => item.message)
  };
}

/** 创建一个覆盖子节点视觉范围的整理分组 Frame。 */
function createHierarchyCleanupGroup(root, groupPlan, beforeChildren) {
  const childIds = groupPlan.childNodeIds || [];
  const childRecords = beforeChildren.filter((child) => childIds.indexOf(child.id) >= 0);
  const union = unionHierarchyBounds(childRecords.map((child) => child.bounds));
  const rootBounds = getNodeBounds(root);
  const frame = figma.createFrame();
  frame.name = String(groupPlan.name || "[Group]");
  frame.x = union.x - rootBounds.x;
  frame.y = union.y - rootBounds.y;
  frame.resize(Math.max(union.width, 0.01), Math.max(union.height, 0.01));
  frame.fills = [];
  frame.strokes = [];
  frame.clipsContent = false;
  if ("layoutMode" in frame) {
    frame.layoutMode = "NONE";
  }
  root.appendChild(frame);
  return frame;
}

/** 判断节点是否为备份帧（名称以 [Backup]、[ComponentSourceBackup_ 或 [ComponentLibrary_ 开头）。 */
function isBackupFrame(node) {
  if (!node || typeof node.name !== "string") return false;
  const name = String(node.name);
  return name.startsWith("[Backup]") || name.startsWith("[ComponentSourceBackup_") || name.startsWith("[ComponentLibrary_");
}

/** 把原始节点移动到新分组后，恢复它相对新分组的局部坐标，避免视觉漂移。 */
function preserveHierarchyChildAbsoluteBounds(child, groupNode, beforeBounds) {
  if (!child || typeof child.x !== "number" || typeof child.y !== "number") {
    return;
  }
  const groupBounds = getNodeBounds(groupNode);
  const newX = numericOr(beforeBounds.x, 0) - numericOr(groupBounds.x, 0);
  const newY = numericOr(beforeBounds.y, 0) - numericOr(groupBounds.y, 0);
  child.x = newX;
  child.y = newY;
  // 坐标合理性检查：超过 ±5000 大概率是坐标系污染，记录日志
  if (Math.abs(newX) > 5000 || Math.abs(newY) > 5000) {
    pluginLogger.warn("层级 preserve 坐标异常", {
      childName: child.name || "?",
      newX: newX,
      newY: newY,
      beforeX: numericOr(beforeBounds.x, 0),
      beforeY: numericOr(beforeBounds.y, 0),
      groupX: numericOr(groupBounds.x, 0),
      groupY: numericOr(groupBounds.y, 0)
    });
  }
}

/** 合并多个绝对边界。 */
function unionHierarchyBounds(boundsList) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const bounds of boundsList) {
    const x = numericOr(bounds.x, 0);
    const y = numericOr(bounds.y, 0);
    const width = numericOr(bounds.width, 0);
    const height = numericOr(bounds.height, 0);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(maxX - minX, 0.01),
    height: Math.max(maxY - minY, 0.01)
  };
}

/** 收集整理后原始节点信息，用于验证节点守恒和视觉不漂移。 */
async function collectHierarchyOriginalNodesAfter(plan, beforeBoundsById) {
  const output = [];
  const rootBounds = { x: 0, y: 0, width: 0, height: 0 };
  for (const group of plan.groups || []) {
    for (const childId of group.childNodeIds || []) {
      const node = await figma.getNodeByIdAsync(String(childId)).catch(() => null);
      if (!node) {
        continue;
      }
      output.push(buildHierarchyNodeRecord(node, node, rootBounds, node.parent ? node.parent.id : "", 0));
      output[output.length - 1].beforeBounds = beforeBoundsById[String(childId)] || null;
    }
  }
  return output;
}

/** 检查整理后原始节点的绝对边界是否漂移。 */
function collectHierarchyBoundsDrift(originalNodesAfter, beforeBoundsById, tolerance) {
  const driftNodes = [];
  for (const node of originalNodesAfter) {
    const before = beforeBoundsById[node.id];
    if (!before) {
      continue;
    }
    const after = node.bounds;
    const delta = Math.max(
      Math.abs(numericOr(before.x, 0) - numericOr(after.x, 0)),
      Math.abs(numericOr(before.y, 0) - numericOr(after.y, 0)),
      Math.abs(numericOr(before.width, 0) - numericOr(after.width, 0)),
      Math.abs(numericOr(before.height, 0) - numericOr(after.height, 0))
    );
    if (delta > tolerance) {
      driftNodes.push({
        nodeId: node.id,
        name: node.name,
        delta: roundNumber(delta),
        before,
        after
      });
    }
  }
  return driftNodes;
}

/** 检查重排后直接子节点绝对边界是否漂移。 */
function collectHierarchyReorderBoundsDrift(afterChildren, beforeBoundsById, tolerance) {
  const driftNodes = [];
  for (const node of afterChildren || []) {
    const before = beforeBoundsById[node.id];
    if (!before) {
      continue;
    }
    const after = node.bounds;
    const delta = Math.max(
      Math.abs(numericOr(before.x, 0) - numericOr(after.x, 0)),
      Math.abs(numericOr(before.y, 0) - numericOr(after.y, 0)),
      Math.abs(numericOr(before.width, 0) - numericOr(after.width, 0)),
      Math.abs(numericOr(before.height, 0) - numericOr(after.height, 0))
    );
    if (delta > tolerance) {
      driftNodes.push({
        nodeId: node.id,
        name: node.name,
        delta: roundNumber(delta),
        before,
        after
      });
    }
  }
  return driftNodes;
}

/** 根据 apply 阶段检查项生成阻塞错误。 */
function buildHierarchyApplyBlockingErrors(checks) {
  const errors = [];
  for (const key of Object.keys(checks)) {
    const check = checks[key];
    if (check && check.pass === false) {
      errors.push({
        code: key,
        message: `Figma 层级整理检查失败：${key}`,
        details: check
      });
    }
  }
  return errors;
}

/** 字符串数组去重并保持首次出现顺序。 */
function uniqueStrings(values) {
  const seen = {};
  const output = [];
  for (const value of values || []) {
    const text = String(value || "");
    if (!text || seen[text]) {
      continue;
    }
    seen[text] = true;
    output.push(text);
  }
  return output;
}

function serializePaints(paints) {
  if (!Array.isArray(paints)) {
    return [];
  }
  return paints.map((paint) => {
    const result = {
      type: String(paint.type || ""),
      visible: paint.visible !== false,
      opacity: typeof paint.opacity === "number" ? paint.opacity : 1
    };
    if (paint.color) {
      result.color = {
        r: roundNumber(paint.color.r || 0),
        g: roundNumber(paint.color.g || 0),
        b: roundNumber(paint.color.b || 0)
      };
    }
    if (paint.imageHash) {
      result.imageHash = String(paint.imageHash);
      result.scaleMode = String(paint.scaleMode || "");
    }
    return result;
  });
}

/** 序列化文本投影效果，Unity 侧会近似映射到 TMP Underlay。 */
function serializeEffects(effects) {
  if (!Array.isArray(effects)) {
    return [];
  }
  return effects.map((effect) => {
    const result = {
      type: String(effect.type || ""),
      visible: effect.visible !== false,
      radius: typeof effect.radius === "number" ? roundNumber(effect.radius) : 0,
      spread: typeof effect.spread === "number" ? roundNumber(effect.spread) : 0,
      blendMode: effect.blendMode ? String(effect.blendMode) : ""
    };
    if (effect.offset) {
      result.offset = {
        x: roundNumber(effect.offset.x || 0),
        y: roundNumber(effect.offset.y || 0)
      };
    }
    if (effect.color) {
      result.color = {
        r: roundNumber(effect.color.r || 0),
        g: roundNumber(effect.color.g || 0),
        b: roundNumber(effect.color.b || 0),
        a: typeof effect.color.a === "number" ? roundNumber(effect.color.a) : 1
      };
    }
    return result;
  });
}

function findFirstImageHash(node, includeHiddenImageFill) {
  const fills = Array.isArray(node && node.fills) ? node.fills : [];
  for (const paint of fills) {
    if (paint && (includeHiddenImageFill || paint.visible !== false) && paint.type === "IMAGE" && paint.imageHash) {
      return String(paint.imageHash);
    }
  }
  return "";
}

/** 九宫容器回溯源图：遍历 __slice_ 子节点获取 imageHash。 */
function findNineSliceSourceHash(node) {
  if (!node || !("children" in node) || !Array.isArray(node.children)) return "";
  for (const child of node.children) {
    if (String(child && child.name || "").startsWith("__slice_")) {
      const hash = findFirstImageHash(child, true);
      if (hash) return hash;
    }
  }
  return "";
}

// 读取 Figma 九宫切片信息，计算 Unity Sliced Sprite 所需边框。
function buildFigmaPrefabNineSliceInfo(node) {
  if (!node || !("children" in node) || !Array.isArray(node.children)) {
    return null;
  }

  const slices = {};
  for (const child of node.children) {
    const name = String(child && child.name || "");
    if (!name.startsWith("__slice_")) {
      continue;
    }
    slices[name] = getNodeBounds(child);
  }

  const sliceNames = Object.keys(slices);
  if (sliceNames.length !== 9 && sliceNames.length !== 3) {
    return null;
  }

  const bounds = getNodeBounds(node);
  const left = readSliceWidth(slices, "__slice_top_left", "__slice_left", "__slice_bottom_left");
  const right = readSliceWidth(slices, "__slice_top_right", "__slice_right", "__slice_bottom_right");
  const top = readSliceHeight(slices, "__slice_top_left", "__slice_top", "__slice_top_right");
  const bottom = readSliceHeight(slices, "__slice_bottom_left", "__slice_bottom", "__slice_bottom_right");

  if (left <= 0 && right <= 0 && top <= 0 && bottom <= 0) {
    return null;
  }

  const border = {
    left: roundNumber(left),
    bottom: roundNumber(bottom),
    right: roundNumber(right),
    top: roundNumber(top)
  };
  const sliceKind = inferFigmaPrefabSliceKind(slices, sliceNames, border);
  const sourceVisibleSize = {
    width: Math.max(1, Math.round(bounds.width || 1)),
    height: Math.max(1, Math.round(bounds.height || 1))
  };
  return {
    border,
    sliceKind,
    sliceCount: sliceNames.length,
    minSize: buildFigmaPrefabNineSliceExportSize(border, sliceKind, sourceVisibleSize),
    sourceVisibleSize
  };
}

function inferFigmaPrefabSliceKind(slices, sliceNames, border) {
  const names = new Set(sliceNames || []);
  const hasH3Names = names.has("__slice_left") || names.has("__slice_center") || names.has("__slice_right");
  const hasV3Names = names.has("__slice_top") || names.has("__slice_middle") || names.has("__slice_bottom");
  if (names.size === 3 && hasH3Names && !hasV3Names) {
    return "h3slice";
  }
  if (names.size === 3 && hasV3Names && !hasH3Names) {
    return "v3slice";
  }
  const hasHorizontalBorder = border.left > 0 && border.right > 0;
  const hasVerticalBorder = border.top > 0 && border.bottom > 0;
  if (hasHorizontalBorder && !hasVerticalBorder) {
    return "h3slice";
  }
  if (!hasHorizontalBorder && hasVerticalBorder) {
    return "v3slice";
  }
  return "9slice";
}

function buildFigmaPrefabNineSliceExportSize(border, sliceKind, sourceVisibleSize) {
  const minWidth = Math.max(1, Math.round(border.left + border.right + 2));
  const minHeight = Math.max(1, Math.round(border.top + border.bottom + 2));
  if (sliceKind === "h3slice") {
    return {
      width: minWidth,
      height: Math.max(1, Math.round(sourceVisibleSize.height || minHeight))
    };
  }
  if (sliceKind === "v3slice") {
    return {
      width: Math.max(1, Math.round(sourceVisibleSize.width || minWidth)),
      height: minHeight
    };
  }
  return {
    width: minWidth,
    height: minHeight
  };
}

function readSliceWidth(slices, a, b, c) {
  const item = slices[a] || slices[b] || slices[c];
  return item ? positiveOr(item.width, 0) : 0;
}

function readSliceHeight(slices, a, b, c) {
  const item = slices[a] || slices[b] || slices[c];
  return item ? positiveOr(item.height, 0) : 0;
}

function hasRenderablePaint(paints) {
  if (!Array.isArray(paints)) {
    return false;
  }
  return paints.some((paint) => paint && paint.visible !== false && paint.type !== "NONE");
}

function hasPositiveBounds(node) {
  const bounds = getNodeBounds(node);
  return bounds.width > 0 && bounds.height > 0;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

function safeFileName(value) {
  return String(value || "asset").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
}

// 查找节点所属页面，避免跨页面 selection 或 append 触发 Figma 限制。
function findContainingPage(node) {
  let current = node;
  while (current && current.type !== "PAGE") {
    current = current.parent;
  }
  return current && current.type === "PAGE" ? current : null;
}

// 切换到节点所在页面，确保后续导出和 selection 操作在同一页面内执行。
async function setCurrentPageForNode(node) {
  const page = findContainingPage(node);
  if (page && figma.currentPage !== page) {
    await figma.setCurrentPageAsync(page);
  }
}

function roundNumber(value) {
  return Math.round((Number(value) || 0) * 1000000) / 1000000;
}

/** 根据检测到的网格布局创建可复用组件。 */
async function handleCreateGridComponent(message) {
  try {
    const result = await createGridComponentFromManifest(message.job || {});
    figma.ui.postMessage({
      type: "CREATE_GRID_COMPONENT_RESULT",
      requestId: message.requestId,
      result: Object.assign({ status: "completed" }, result)
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "CREATE_GRID_COMPONENT_RESULT",
      requestId: message.requestId,
      result: {
        status: "error",
        errors: [error instanceof Error ? error.message : String(error)]
      }
    });
  }
}

/** 根据预分析数据创建网格组件。 */
async function createGridComponentFromManifest(job) {
  const root = await figma.getNodeByIdAsync(String(job.rootNodeId));
  if (!root || !("children" in root)) {
    throw new Error("Root node not found: " + job.rootNodeId);
  }

  const componentName = String(job.componentName || "C_GridSlot");
  const slots = Array.isArray(job.slots) ? job.slots : [];
  if (slots.length < 2) {
    throw new Error("At least 2 slots are required to create grid component");
  }

  const refSlotIndex = numericOr(job.referenceSlotIndex, 0);
  const refSlot = slots[refSlotIndex];
  if (!refSlot) throw new Error("Reference slot " + refSlotIndex + " not found");

  // 收集参考 slot 节点并计算边界。
  const refNodes = [];
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  for (const item of (refSlot.nodes || [])) {
    const node = await figma.getNodeByIdAsync(String(item.id));
    if (!node || node.parent !== root) continue;
    refNodes.push({ node, key: item.key || "" });
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }
  if (refNodes.length === 0) throw new Error("Reference slot " + refSlotIndex + " has no nodes");

  // 创建临时 Frame，并移入参考节点。
  const tempFrame = figma.createFrame();
  tempFrame.name = "_TMP_" + componentName;
  tempFrame.x = minX;
  tempFrame.y = minY;
  tempFrame.resize(Math.max(maxX - minX, 1), Math.max(maxY - minY, 1));
  tempFrame.fills = [];
  tempFrame.strokes = [];
  for (const { node } of refNodes) {
    tempFrame.appendChild(node);
    node.x -= minX;
    node.y -= minY;
  }
  root.appendChild(tempFrame);

  // 转换为 Component。
  const component = figma.createComponentFromNode(tempFrame);
  component.name = componentName;
  component.clipsContent = false;

  // 添加 Component Properties。
  const propKeys = {};
  const charNodeIds = new Set((job.textNodeIds || []).map(String));
  const boolNodeIdsSet = new Set((job.booleanNodeIds || []).map(String));
  const propDefs = {
    dayNumber: { type: "TEXT", defaultValue: "1" },
    isLocked: { type: "BOOLEAN", defaultValue: false },
    isToday: { type: "BOOLEAN", defaultValue: false },
    hasReward: { type: "BOOLEAN", defaultValue: false },
    rewardCount: { type: "TEXT", defaultValue: "0" },
  };
  for (const [propName, def] of Object.entries(propDefs)) {
    propKeys[propName] = component.addComponentProperty(propName, def.type, def.defaultValue);
  }

  // 将属性绑定到子节点。
  for (const child of component.children) {
    const nodeId = child.id;
    const childName = String(child.name || "").toLowerCase();
    if (charNodeIds.has(nodeId)) {
      if (childName.includes("1__text") || childName.match(/\d+__text$/)) {
        // DayNumber: any child that is a number text
        child.componentPropertyReferences = { characters: propKeys.dayNumber };
      } else if (childName.includes("9__text") || childName.includes("reward")) {
        child.componentPropertyReferences = { characters: propKeys.rewardCount };
      }
    }
    if (boolNodeIdsSet.has(nodeId)) {
      if (childName.includes("lock") || childName.includes("common")) {
        child.componentPropertyReferences = { visible: propKeys.isLocked };
      } else if (childName.includes("icon_hd") || childName.includes("reward")) {
        child.componentPropertyReferences = { visible: propKeys.hasReward };
      }
    }
    if (job.variantNodeId && nodeId === String(job.variantNodeId)) {
      // 根据 isToday 属性切换背景可见性。
      child.componentPropertyReferences = { visible: propKeys.isToday };
    }
  }

  // 将 Component 放回参考 slot 位置。
  component.x = (refSlot.bounds && refSlot.bounds.x) || minX;
  component.y = (refSlot.bounds && refSlot.bounds.y) || minY;

  // 为每个非参考 slot 创建 Instance。
  const createdInstances = [];
  for (let si = 0; si < slots.length; si++) {
    const slot = slots[si];
    if (si === refSlotIndex) {
      createdInstances.push({ slotIndex: si, instanceId: component.id, x: component.x, y: component.y, properties: slot.properties || {} });
      continue;
    }
    // 删除 slot 的原节点。
    for (const item of (slot.nodes || [])) {
      const node = await figma.getNodeByIdAsync(String(item.id));
      if (node && node.parent === root) node.remove();
    }
    const instance = component.createInstance();
    root.appendChild(instance);
    instance.x = (slot.bounds && slot.bounds.x) || (si * 133);
    instance.y = (slot.bounds && slot.bounds.y) || minY;

    const props = {};
    if (slot.properties) {
      if (slot.properties.dayNumber) props[propKeys.dayNumber] = String(slot.properties.dayNumber);
      props[propKeys.isLocked] = !!slot.properties.isLocked;
      props[propKeys.isToday] = !!slot.properties.isToday;
      props[propKeys.hasReward] = !!slot.properties.hasReward;
      if (slot.properties.rewardCount) props[propKeys.rewardCount] = String(slot.properties.rewardCount);
    }
    instance.setProperties(props);
    createdInstances.push({ slotIndex: si, instanceId: instance.id, x: instance.x, y: instance.y, properties: slot.properties || {} });
  }

  return {
    componentId: component.id,
    componentName: component.name,
    instanceCount: createdInstances.length,
    instances: createdInstances,
    properties: Object.keys(propDefs)
  };
}

/** 查询当前 Figma 页面选中的节点，返回节点、页面与文件信息。 */
async function handleQuerySelection(message) {
  try {
    const sel = figma.currentPage.selection;
    const nodes = sel.map(function(n) {
      return {
        id: n.id,
        name: n.name,
        type: n.type,
        width: Math.round(n.width || 0),
        height: Math.round(n.height || 0)
      };
    });
    const fileKey = figma.fileKey || "";
    const pageName = figma.currentPage.name;
    // 尝试从 figma.root 获取文档名。
    const docName = figma.root && figma.root.name ? figma.root.name : "";
    figma.ui.postMessage({
      type: "QUERY_SELECTION_RESULT",
      requestId: message.requestId,
      result: {
        status: "completed",
        fileKey: fileKey,
        docName: docName,
        pageName: pageName,
        nodes: nodes,
        count: nodes.length
      }
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "QUERY_SELECTION_RESULT",
      requestId: message.requestId,
      result: {
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

/** Switch the active page and current selection for MCP-driven workflows. */
async function handleSetContext(message) {
  try {
    const job = message.job || {};
    const pageId = String(job.pageId || "").trim();
    const pageName = String(job.pageName || "").trim();
    const rawSelectionNodeIds = Array.isArray(job.selectionNodeIds) ? job.selectionNodeIds : null;
    const clearSelection = job.clearSelection !== false && !rawSelectionNodeIds;

    let page = null;
    if (pageId) {
      page = await findNodeAcrossPages(pageId);
      if (!page || page.type !== "PAGE") {
        throw new Error("pageId not found or is not PAGE: " + pageId);
      }
    } else if (pageName) {
      try { await figma.loadAllPagesAsync(); } catch (e) { /* dynamic-page mode may reject this; fall back to loaded pages */ }
      const matches = (figma.root.children || []).filter(function(candidate) {
        return candidate && candidate.type === "PAGE" && candidate.name === pageName;
      });
      if (matches.length === 0) {
        throw new Error("pageName not found: " + pageName);
      }
      if (matches.length > 1) {
        throw new Error("pageName is ambiguous: " + pageName);
      }
      page = matches[0];
    } else {
      page = figma.currentPage;
    }

    if (page && figma.currentPage !== page) {
      await figma.setCurrentPageAsync(page);
    }

    const selectionNodes = [];
    if (rawSelectionNodeIds) {
      for (const rawId of rawSelectionNodeIds) {
        const nodeId = String(rawId || "").trim();
        if (!nodeId) {
          continue;
        }
        const node = await findNodeAcrossPages(nodeId);
        if (!node) {
          throw new Error("selection node not found: " + nodeId);
        }
        if (node.type === "PAGE" || node.type === "DOCUMENT") {
          throw new Error("selection node cannot be " + node.type + ": " + nodeId);
        }
        const nodePage = findContainingPage(node);
        if (!nodePage || nodePage.id !== figma.currentPage.id) {
          throw new Error("selection node is not on target page: " + nodeId);
        }
        selectionNodes.push(node);
      }
      figma.currentPage.selection = selectionNodes;
    } else if (clearSelection) {
      figma.currentPage.selection = [];
    }

    figma.viewport.scrollAndZoomIntoView(
      figma.currentPage.selection && figma.currentPage.selection.length > 0
        ? figma.currentPage.selection
        : [figma.currentPage]
    );

    const nodes = (figma.currentPage.selection || []).map(function(n) {
      return {
        id: n.id,
        name: n.name,
        type: n.type,
        width: Math.round(n.width || 0),
        height: Math.round(n.height || 0)
      };
    });
    figma.ui.postMessage({
      type: "SET_CONTEXT_RESULT",
      requestId: message.requestId,
      result: {
        status: "completed",
        fileKey: figma.fileKey || "",
        docName: figma.root && figma.root.name ? figma.root.name : "",
        pageId: figma.currentPage && figma.currentPage.id ? figma.currentPage.id : "",
        pageName: figma.currentPage && figma.currentPage.name ? figma.currentPage.name : "",
        nodes: nodes,
        count: nodes.length
      }
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "SET_CONTEXT_RESULT",
      requestId: message.requestId,
      result: {
        status: "error",
        errors: [error instanceof Error ? error.message : String(error)]
      }
    });
  }
}

async function handleQueryNodeChildren(message) {
  try {
    const nodeId = String((message.job && message.job.nodeId) || "");
    if (!nodeId) {
      figma.ui.postMessage({
        type: "QUERY_NODE_CHILDREN_RESULT",
        requestId: message.requestId,
        result: { status: "error", errors: ["missing nodeId"] }
      });
      return;
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      figma.ui.postMessage({
        type: "QUERY_NODE_CHILDREN_RESULT",
        requestId: message.requestId,
        result: { status: "error", errors: ["node not found: " + nodeId] }
      });
      return;
    }
    if (!("children" in node)) {
      figma.ui.postMessage({
        type: "QUERY_NODE_CHILDREN_RESULT",
        requestId: message.requestId,
        result: { status: "error", errors: ["node has no children: " + node.type] }
      });
      return;
    }
    const children = [];
    for (const child of node.children) {
      const info = {
        id: child.id,
        name: child.name,
        type: child.type,
        x: Math.round(child.x),
        y: Math.round(child.y),
        width: Math.round(child.width),
        height: Math.round(child.height),
        visible: child.visible,
        opacity: child.opacity,
      };
      if ("children" in child) {
        info.childCount = child.children.length;
      }
      if (child.type === "TEXT") {
        info.characters = child.characters;
      }
      children.push(info);
    }
    figma.ui.postMessage({
      type: "QUERY_NODE_CHILDREN_RESULT",
      requestId: message.requestId,
      result: {
        status: "completed",
        nodeId: nodeId,
        nodeName: node.name,
        nodeType: node.type,
        childCount: children.length,
        children: children,
      }
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "QUERY_NODE_CHILDREN_RESULT",
      requestId: message.requestId,
      result: {
        status: "error",
        errors: [error instanceof Error ? error.message : String(error)]
      }
    });
  }
}

/** 递归收集节点子树内的 Component 和 ComponentSet。 */
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

/** 规范化组件名：去前缀、转小写、移除分隔符。 */
function normalizeComponentName(name) {
  let n = String(name || "");
  for (const prefix of ["Common_", "Common-", "common_", "common-"]) {
    if (n.startsWith(prefix)) { n = n.slice(prefix.length); break; }
  }
  return n.toLowerCase().replace(/[\s\-_\[\]().]/g, "");
}

/** 收集指定节点列表中的所有组件，返回带规范化索引的结构。 */
async function collectComponents(job) {
  const libraryNodeIds = job.libraryNodeIds || ["62:115", "2896:32"];
  const results = {};

  for (const nodeId of libraryNodeIds) {
    const node = await figma.getNodeByIdAsync(nodeId).catch(() => null);
    if (!node) {
      results[nodeId] = { error: `节点 ${nodeId} 不存在，请确认当前文件是资源库` };
      continue;
    }
    const raw = [];
    collectReusableComponents(node, raw);
    const components = raw.map(function(c) {
      return {
        id: c.id,
        name: c.name,
        type: c.type,
        width: Math.round(c.width || 0),
        height: Math.round(c.height || 0)
      };
    });
    const normalized = {};
    for (const comp of components) {
      const key = normalizeComponentName(comp.name);
      if (normalized[key]) {
        const existing = normalized[key];
        if (Array.isArray(existing)) {
          existing.push(comp);
        } else {
          normalized[key] = [existing, comp];
        }
      } else {
        normalized[key] = comp;
      }
    }
    results[nodeId] = { count: components.length, components: components, normalized: normalized };
  }
  return { libraries: results };
}

/** 批量设置节点坐标。接受 plan.positions[{nodeId, x, y}] */
async function setHierarchyNodePositionsJob(job) {
  const plan = job && job.plan ? job.plan : {};
  const options = job && job.options ? job.options : {};
  const positions = plan.positions || [];

  if (!Array.isArray(positions) || positions.length === 0) {
    throw new Error("FIGMA_HIERARCHY_SET_NODE_POSITIONS missing plan.positions");
  }

  const updated = [];
  const errors = [];
  const beforeBounds = {};

  for (const pos of positions) {
    const nodeId = String(pos.nodeId || "");
    if (!nodeId) { errors.push("position entry missing nodeId"); continue; }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) { errors.push("Node not found: " + nodeId); continue; }
    beforeBounds[nodeId] = { x: node.x, y: node.y, width: node.width, height: node.height };
    if (typeof pos.x === "number") node.x = pos.x;
    if (typeof pos.y === "number") node.y = pos.y;
    updated.push({ nodeId, x: node.x, y: node.y, width: node.width, height: node.height });
  }

  return {
    status: errors.length === 0 ? "completed" : "partial",
    allPass: errors.length === 0,
    updatedCount: updated.length,
    plannedCount: positions.length,
    updated,
    errors,
    warnings: [],
    checks: {
      allUpdated: { pass: updated.length === positions.length, updated: updated.length, planned: positions.length }
    },
    summary: { updatedCount: updated.length, errorCount: errors.length },
    artifacts: { plan, beforeBounds, updated },
    screenshot: options.includeScreenshot ? await exportNodePngScreenshot(updated[0] ? await figma.getNodeByIdAsync(updated[0].nodeId) : null) : null
  };
}

/** 处理 FIGMA_HIERARCHY_SET_NODE_POSITIONS 请求 */
async function handleFigmaHierarchySetNodePositions(message) {
  try {
    const job = message && message.job ? message.job : (message.plan || message);
    const result = await setHierarchyNodePositionsJob(job);
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_SET_NODE_POSITIONS_RESULT",
      requestId: message.requestId,
      result
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_SET_NODE_POSITIONS_RESULT",
      requestId: message.requestId,
      result: {
        status: "error",
        allPass: false,
        errors: [error instanceof Error ? error.message : String(error)],
        warnings: [],
        blockingErrors: [error instanceof Error ? { code: "setPositionException", message: error.message } : { code: "setPositionException", message: String(error) }]
      }
    });
  }
}

/** 跨组移动节点，保留被移动节点的绝对位置并返回可验收的检查结果。 */
async function moveHierarchyChildrenJob(job) {
  const plan = job && job.plan ? job.plan : {};
  const options = job && job.options ? job.options : {};
  const sourceNodeId = String(plan.sourceNodeId || (job && job.target && job.target.nodeId) || "");
  if (!sourceNodeId) throw new Error("FIGMA_HIERARCHY_MOVE_NODES missing sourceNodeId");
  if (!Array.isArray(plan.moves) || plan.moves.length === 0) throw new Error("FIGMA_HIERARCHY_MOVE_NODES missing plan.moves");

  const source = await figma.getNodeByIdAsync(sourceNodeId).catch(() => null);
  if (!source) throw new Error("Source node not found: " + sourceNodeId);
  if (!("children" in source)) throw new Error("Source node has no children: " + source.type);

  await setCurrentPageForNode(source);
  const removeEmptySource = plan.removeEmptySource !== false;
  const plannedMoves = normalizeHierarchyMovePlan(plan.moves);
  const allPlannedIds = plannedMoves.map((item) => item.childId);
  const duplicateIds = allPlannedIds.filter((id, index) => allPlannedIds.indexOf(id) !== index);
  const movedNodes = [];
  const errors = [];
  const warnings = [];
  const beforeParents = {};
  const beforeBounds = {};
  const afterRecords = [];
  const targetByChildId = {};
  const moveRecords = [];

  for (const duplicateId of uniqueStrings(duplicateIds)) {
    errors.push("Duplicate childId in move plan: " + duplicateId);
  }

  for (const item of plannedMoves) {
    if (!item.targetParentId) { errors.push("move missing targetParentId"); continue; }
    if (!item.childId) { errors.push("move missing childId"); continue; }
    const target = await figma.getNodeByIdAsync(item.targetParentId).catch(() => null);
    if (!target || typeof target.appendChild !== "function") {
      errors.push("Target node not found or not a container: " + item.targetParentId);
      continue;
    }
    const child = await figma.getNodeByIdAsync(item.childId).catch(() => null);
    if (!child) { errors.push("Child not found: " + item.childId); continue; }
    if (!isHierarchyDescendantOf(child, source)) {
      errors.push("Child is not inside source: " + item.childId);
      continue;
    }
    if (child === target || isHierarchyDescendantOf(target, child)) {
      errors.push("Cannot move node into itself or its descendant: " + item.childId + " -> " + item.targetParentId);
      continue;
    }
    moveRecords.push({ child, target, childId: item.childId, targetParentId: item.targetParentId });
  }

  for (const record of moveRecords) {
    const child = record.child;
    const target = record.target;
    beforeParents[child.id] = child.parent ? child.parent.id : null;
    beforeBounds[child.id] = boundsToManifest(getNodeBounds(child));
    // 检测从备份帧移出节点 → 坐标污染警告
    const parent = child.parent;
    if (parent && isBackupFrame(parent)) {
      warnings.push({
        code: "moveFromBackupFrame",
        message: `节点 "${child.name}" 从备份帧 "${parent.name}" 移出，坐标可能已偏移。建议用 clone-node 从原始位置克隆。`,
        details: { childId: child.id, childName: child.name, parentId: parent.id, parentName: parent.name }
      });
    }
    // 检测移入备份帧 → 不影响视觉但告知
    if (target && isBackupFrame(target)) {
      warnings.push({
        code: "moveIntoBackupFrame",
        message: `节点 "${child.name}" 移入备份帧 "${target.name}"，坐标会被重排。后续从此帧移回会有坐标污染。`,
        details: { childId: child.id, childName: child.name, targetId: target.id, targetName: target.name }
      });
    }
  }

  if (errors.length === 0) {
    for (const record of moveRecords) {
      const child = record.child;
      const target = record.target;
      try {
        target.appendChild(child);
        preserveHierarchyChildAbsoluteBounds(child, target, beforeBounds[child.id]);
        movedNodes.push(child.id);
        targetByChildId[child.id] = target.id;
        afterRecords.push(buildHierarchyMoveAfterRecord(child, target));
      } catch (error) {
        errors.push(`Move failed for ${record.childId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  let sourceRemoved = false;
  if (removeEmptySource && "children" in source && source.children.length === 0) {
    source.remove();
    sourceRemoved = true;
  } else if (removeEmptySource && "children" in source && source.children.length > 0) {
    warnings.push("Source node was not removed because it still has children.");
  }

  const finalRecords = await collectHierarchyMovedNodeRecords(allPlannedIds, targetByChildId, beforeBounds);
  const driftNodes = collectHierarchyMoveBoundsDrift(finalRecords, beforeBounds, 0.01);
  const finalParentMismatches = finalRecords.filter((item) => item.expectedParentId && item.parentId !== item.expectedParentId);
  const missingAfter = allPlannedIds.filter((id) => !finalRecords.some((item) => item.id === id));
  const checks = {
    noRuntimeErrors: { pass: errors.length === 0, errors },
    childSetPreserved: {
      pass: movedNodes.length === allPlannedIds.length && uniqueStrings(movedNodes).length === uniqueStrings(allPlannedIds).length && missingAfter.length === 0,
      moved: movedNodes.length,
      planned: allPlannedIds.length,
      missingAfter,
      duplicateIds: uniqueStrings(duplicateIds)
    },
    finalParentsMatchPlan: {
      pass: finalParentMismatches.length === 0,
      mismatches: finalParentMismatches
    },
    boundsPreserved: {
      pass: driftNodes.length === 0,
      driftCount: driftNodes.length,
      driftNodes
    },
    sourceHandled: {
      pass: removeEmptySource ? sourceRemoved || ("children" in source && source.children.length > 0) : true,
      removeEmptySource,
      sourceRemoved,
      remainingChildren: !sourceRemoved && "children" in source ? source.children.length : 0
    }
  };
  const blockingErrors = buildHierarchyMoveBlockingErrors(checks);
  const screenshotTarget = await resolveHierarchyMoveScreenshotTarget(source, sourceRemoved, finalRecords);
  const screenshot = options.includeScreenshot ? await exportNodePngScreenshot(screenshotTarget) : null;

  return {
    status: blockingErrors.length === 0 ? "completed" : "blocked",
    allPass: blockingErrors.length === 0,
    sourceNodeId,
    sourceRemoved,
    movedNodeCount: movedNodes.length,
    plannedCount: allPlannedIds.length,
    movedNodes,
    errors,
    warnings,
    blockingErrors,
    checks,
    summary: { movedCount: movedNodes.length, sourceRemoved, errorCount: errors.length, blockingErrorCount: blockingErrors.length },
    artifacts: { plan, beforeParents, beforeBounds, movedNodes, targetByChildId, afterRecords, finalRecords },
    screenshot
  };
}

/** 将移动计划展平为 childId -> targetParentId 记录，方便后续 O(n) 校验。 */
function normalizeHierarchyMovePlan(moves) {
  const output = [];
  for (const move of moves || []) {
    const targetParentId = String(move && move.targetParentId || "");
    for (const childId of (move && move.childIds) || []) {
      output.push({ targetParentId, childId: String(childId || "") });
    }
  }
  return output;
}

/** 判断 node 是否位于 ancestor 子树内。 */
function isHierarchyDescendantOf(node, ancestor) {
  let current = node;
  while (current) {
    if (current === ancestor) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/** 生成移动后的节点记录，供结果报告和漂移校验使用。 */
function buildHierarchyMoveAfterRecord(child, target) {
  return {
    id: child.id,
    name: child.name || "",
    type: child.type,
    parentId: child.parent ? child.parent.id : "",
    expectedParentId: target ? target.id : "",
    bounds: boundsToManifest(getNodeBounds(child))
  };
}

/** 收集计划节点最终状态，包含未移动成功的节点，用于阻塞错误判断。 */
async function collectHierarchyMovedNodeRecords(plannedIds, targetByChildId, beforeBounds) {
  const output = [];
  for (const childId of uniqueStrings(plannedIds)) {
    const node = await figma.getNodeByIdAsync(childId).catch(() => null);
    if (!node) {
      continue;
    }
    output.push({
      id: node.id,
      name: node.name || "",
      type: node.type,
      parentId: node.parent ? node.parent.id : "",
      expectedParentId: targetByChildId[node.id] || "",
      beforeBounds: beforeBounds[node.id] || null,
      bounds: boundsToManifest(getNodeBounds(node))
    });
  }
  return output;
}

/** 检查跨父节点移动后 absolute bounds 是否保持不变。 */
function collectHierarchyMoveBoundsDrift(finalRecords, beforeBoundsById, tolerance) {
  const driftNodes = [];
  for (const record of finalRecords || []) {
    const before = beforeBoundsById[record.id];
    if (!before) {
      continue;
    }
    const after = record.bounds;
    const delta = Math.max(
      Math.abs(numericOr(before.x, 0) - numericOr(after.x, 0)),
      Math.abs(numericOr(before.y, 0) - numericOr(after.y, 0)),
      Math.abs(numericOr(before.width, 0) - numericOr(after.width, 0)),
      Math.abs(numericOr(before.height, 0) - numericOr(after.height, 0))
    );
    if (delta > tolerance) {
      driftNodes.push({ nodeId: record.id, name: record.name, delta: roundNumber(delta), before, after });
    }
  }
  return driftNodes;
}

/** 根据 move 检查项生成阻塞错误，避免部分移动被误判成功。 */
function buildHierarchyMoveBlockingErrors(checks) {
  const errors = [];
  for (const key of Object.keys(checks)) {
    const check = checks[key];
    if (check && check.pass === false) {
      errors.push({
        code: key,
        message: `Figma 跨组移动检查失败：${key}`,
        details: check
      });
    }
  }
  return errors;
}

/** 选择移动任务截图目标，避免对已经删除的 source 节点导出截图。 */
async function resolveHierarchyMoveScreenshotTarget(source, sourceRemoved, finalRecords) {
  if (!sourceRemoved && source && "exportAsync" in source) {
    return source;
  }
  const firstRecord = finalRecords && finalRecords[0];
  if (firstRecord && firstRecord.parentId) {
    return await figma.getNodeByIdAsync(firstRecord.parentId).catch(() => null);
  }
  return null;
}

/** 处理 FIGMA_HIERARCHY_MOVE_NODES 请求 */
async function handleFigmaHierarchyMoveNodes(message) {
  try {
    const job = message && message.job ? message.job : (message.plan || message);
    const result = await moveHierarchyChildrenJob(job);
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_MOVE_NODES_RESULT",
      requestId: message.requestId,
      result
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_MOVE_NODES_RESULT",
      requestId: message.requestId,
      result: {
        status: "error",
        allPass: false,
        errors: [error instanceof Error ? error.message : String(error)],
        warnings: [],
        blockingErrors: [error instanceof Error ? { code: "moveException", message: error.message } : { code: "moveException", message: String(error) }]
      }
    });
  }
}

/** 处理 FIGMA_CLONE_NODE：复制指定节点为同级隐藏备份 */
async function handleFigmaCloneNode(message) {
  try {
    const job = message && message.job ? message.job : {};
    const target = job.target || {};
    const plan = job.plan || {};
    const nodeId = String(target.nodeId || plan.nodeId || "");
    if (!nodeId) {
      throw new Error("FIGMA_CLONE_NODE 缺少 nodeId");
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      throw new Error("节点未找到：" + nodeId);
    }
    const page = findContainingPage(node) || figma.currentPage;
    const clone = node.clone();
    page.appendChild(clone);
    // 默认放在原节点右侧 100px 处
    const offsetX = plan.offsetX !== undefined ? plan.offsetX : node.width + 100;
    const offsetY = plan.offsetY !== undefined ? plan.offsetY : 0;
    clone.x = node.x + offsetX;
    clone.y = node.y + offsetY;
    // 默认隐藏
    const hideClone = plan.hideClone !== false;
    if (hideClone) clone.visible = false;
    // 默认添加 [Backup] 前缀
    const backupPrefix = plan.backupPrefix !== false;
    if (backupPrefix) {
      clone.name = `[Backup]${node.name || ""}`;
    }
    figma.ui.postMessage({
      type: "FIGMA_CLONE_NODE_RESULT",
      requestId: message.requestId,
      result: {
        status: "completed",
        allPass: true,
        cloneId: clone.id,
        cloneName: clone.name,
        originalBounds: { x: node.x, y: node.y, width: node.width, height: node.height },
        cloneBounds: { x: clone.x, y: clone.y, width: clone.width, height: clone.height },
        visible: clone.visible,
        summary: { cloned: true, backupName: clone.name }
      }
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "FIGMA_CLONE_NODE_RESULT",
      requestId: message.requestId,
      result: {
        status: "error",
        allPass: false,
        errors: [error instanceof Error ? error.message : String(error)],
        warnings: [],
        blockingErrors: [{ code: "cloneException", message: error instanceof Error ? error.message : String(error) }]
      }
    });
  }
}
// 执行一次 PSD manifest_summary 导入，入口只消费 JSON 数据和 PNG 字节，不手动转录坐标。
async function importPsdJob(job, assets) {
  const startTime = Date.now();
  const manifest = normalizeManifest(job && job.manifest);
  const assetBytes = buildAssetBytesMap(assets);
  const context = {
    job,
    manifest,
    assetBytes,
    componentIndexes: await buildComponentIndexes(job),
    commonReports: [],
    sliceReports: [],
    textReports: [],
    imageHashes: new Map(),
    nodeByLayerIdx: new Map(),
    warnings: [],
    errors: [],
    stats: {
      image: 0,
      text: 0,
      commonInstance: 0,
      commonFallbackImage: 0,
      nineSlice: 0,
      slice: 0
    }
  };

  const root = await createRootFrame(job, manifest);
  const orderedLayers = manifest.layers.slice().sort((a, b) => numericOr(a.idx, 0) - numericOr(b.idx, 0));
  for (const layer of orderedLayers) {
    try {
      const node = await createLayerNode(root, layer, context);
      if (node) {
        context.nodeByLayerIdx.set(String(layer.idx), node.id);
      }
    } catch (error) {
      context.errors.push(`${layer.idx}:${layer.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await ensurePsdIndexOrder(root, orderedLayers, context);
  const validation = await validateImportedRoot(root, orderedLayers, context);
  const screenshot = await exportRootScreenshot(root, context);
  validation.screenshotExported = !!screenshot;
  figma.currentPage.selection = [root];
  figma.viewport.scrollAndZoomIntoView([root]);

  return {
    status: buildFinalStatus(context, validation),
    rootNodeId: root.id,
    rootName: root.name,
    createdCount: countDescendants(root),
    screenshot,
    summary: {
      layerCount: orderedLayers.length,
      stats: context.stats,
      validation,
      reports: {
        common: context.commonReports,
        slices: context.sliceReports,
        text: context.textReports
      },
      durationMs: Date.now() - startTime
    },
    warnings: context.warnings,
    errors: context.errors
  };
}

// 只读计算 PSD 增量差异；此阶段不得修改 Figma 文档。
async function previewPsdIncrementalUpdate(job, assets) {
  const prepared = await preparePsdIncrementalUpdate(job, assets);
  return buildPsdIncrementalResult(prepared, prepared.diff.status);
}

// Adopt the current manifest as legacy source truth without changing canvas fields.
async function adoptPsdIncrementalBaseline(job, assets) {
  const prepared = await preparePsdIncrementalUpdate(job, assets);
  const matched = prepared.diff.baselineRequired;
  if (prepared.diff.conflicts.length > 0 || matched.length === 0) {
    return buildPsdIncrementalResult(prepared, "baseline-adopt-blocked");
  }
  const protectedBefore = capturePsdProtectedSnapshot(prepared.target);
  const nodeMetadataBefore = matched.map((pair) => ({
    node: pair.target.node,
    metadata: capturePsdLayerMetadata(pair.target.node)
  }));
  const rootMetadataBefore = capturePsdRootMetadata(prepared.target);
  try {
    for (const pair of matched) {
      writeLayerMetadata(pair.target.node, pair.source, {});
    }
    writePsdRootMetadata(prepared.target, job, prepared.manifest);
    const errors = verifyPsdProtectedSnapshot(protectedBefore);
    if (errors.length > 0) {
      throw new Error(errors.join("; "));
    }
    if (typeof figma.commitUndo === "function") {
      figma.commitUndo();
    }
    return {
      status: "baseline-adopted",
      targetNodeId: prepared.target.id,
      adoptedCount: matched.length,
      warnings: prepared.context.warnings,
      errors: []
    };
  } catch (error) {
    for (const record of nodeMetadataBefore) {
      writePluginData(record.node, record.metadata);
    }
    writePluginData(prepared.target, rootMetadataBefore);
    throw error;
  }
}

// 重新校验预览指纹后，仅替换 PSD 拥有的像素或文字内容。
async function applyPsdIncrementalUpdate(job, assets) {
  const prepared = await preparePsdIncrementalUpdate(job, assets);
  const expectedFingerprint = String(job && job.baselineFingerprint || "");
  if (prepared.diff.status !== "preview-ready") {
    return buildPsdIncrementalResult(prepared, "apply-blocked");
  }
  if (!expectedFingerprint || expectedFingerprint !== prepared.baselineFingerprint) {
    prepared.diff.conflicts.push({
      kind: "stale-preview",
      message: "Figma 节点或 PSD 内容在确认前发生了变化，请重新预览。"
    });
    refreshPsdIncrementalDiffStatus(prepared.diff);
    return buildPsdIncrementalResult(prepared, "apply-blocked");
  }

  await preloadPsdMutationAssets(prepared);
  const structureBefore = capturePsdStructuralSnapshot(prepared.target);
  const rollbackRecords = prepared.plans.map((plan) => capturePsdMutationRollback(plan.target.node));
  const addedTransaction = preparePsdAddedLayerTransaction();
  prepared.rootMetadataBefore = capturePsdRootMetadata(prepared.target);
  try {
    await applyPsdAddedLayers(prepared, addedTransaction);
    await applyPsdMutationPlans(prepared);
    const verificationErrors = verifyPsdStructuralSnapshot(structureBefore, addedTransaction.createdNodeIds)
      .concat(verifyPsdAppliedFields(prepared.plans))
      .concat(verifyPsdAddedNodes(
        addedTransaction.createdNodes,
        prepared.diff.added,
        addedTransaction.stagingFrame,
        prepared.context
      ));
    if (verificationErrors.length > 0) {
      throw new Error(`PSD incremental verification failed: ${verificationErrors.slice(0, 8).join("; ")}`);
    }
    for (const plan of prepared.plans) {
      writeLayerMetadata(
        plan.target.node,
        plan.source,
        buildPsdIncrementalMetadataExtra(plan, prepared)
      );
    }
    writePsdRootMetadata(prepared.target, job, prepared.manifest);
    if (typeof figma.commitUndo === "function") {
      figma.commitUndo();
    }
  } catch (error) {
    const rollbackErrors = await rollbackPsdIncrementalMutation(rollbackRecords, addedTransaction, prepared);
    rollbackErrors.push(...verifyPsdStructuralSnapshot(structureBefore, new Set()));
    rollbackErrors.push(...verifyPsdRollbackRecords(rollbackRecords));
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(rollbackErrors.length > 0 ? `${message}; rollback drift: ${rollbackErrors.join("; ")}` : message);
  }

  const result = buildPsdIncrementalResult(prepared, "applied");
  result.updatedCount = prepared.plans.length;
  result.addedCount = prepared.diff.added.length;
  result.retainedMissingCount = prepared.diff.missing.length;
  result.stagingFrameId = addedTransaction.stagingFrame ? addedTransaction.stagingFrame.id : "";
  return result;
}

async function preparePsdIncrementalUpdate(job, assets) {
  const manifest = normalizeManifest(job && job.manifest);
  const target = await resolvePsdIncrementalTarget(job);
  const context = {
    job,
    manifest,
    assetBytes: buildAssetBytesMap(assets),
    componentIndexes: await buildComponentIndexes(job),
    commonReports: [],
    sliceReports: [],
    textReports: [],
    imageHashes: new Map(),
    nodeByLayerIdx: new Map(),
    warnings: [],
    errors: [],
    stats: { image: 0, text: 0, commonInstance: 0, commonFallbackImage: 0, nineSlice: 0, slice: 0 }
  };
  const currentNodes = collectPsdBoundNodes(target);
  await enrichPsdLiveContentStates(currentNodes, manifest.layers, context.assetBytes);
  const diff = buildPsdIncrementalDiff(currentNodes, manifest.layers);
  appendPsdIncrementalRuntimeConflicts(diff, target, currentNodes, job, manifest);
  appendPsdIncrementalAssetConflicts(diff, context);
  const plans = diff.changed.map(buildPsdLayerMutationPlan);
  appendPsdMutationPreflightConflicts(diff, plans, target);
  if (diff.identityWarning) {
    context.warnings.push(diff.identityWarning);
  }
  return {
    target,
    manifest,
    context,
    diff,
    plans,
    baselineFingerprint: buildPsdIncrementalFingerprint(target, currentNodes, manifest.layers)
  };
}

function appendPsdMutationPreflightConflicts(diff, plans, target) {
  for (const plan of plans) {
    const node = plan.target.node;
    const requiresGeometry = plan.categories.some((category) => (
      category === "position" || category === "size" || category === "rotation"
    ));
    if (!node || node.removed) {
      diff.conflicts.push({ kind: "missing-target-node", layerId: plan.layerId, nodeId: plan.nodeId });
      continue;
    }
    if (node.type === "INSTANCE" || node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
      diff.conflicts.push({ kind: "unsafe-component-boundary-write", layerId: plan.layerId, nodeId: plan.nodeId });
      continue;
    }
    if (requiresGeometry) {
      const parent = node.parent;
      if (!parent || !target.absoluteTransform || !parent.absoluteTransform) {
        diff.conflicts.push({ kind: "missing-transform-context", layerId: plan.layerId, nodeId: plan.nodeId });
        continue;
      }
      if (parent.layoutMode && parent.layoutMode !== "NONE" && node.layoutPositioning !== "ABSOLUTE") {
        diff.conflicts.push({ kind: "unsafe-auto-layout-geometry", layerId: plan.layerId, nodeId: plan.nodeId });
        continue;
      }
      if (!("x" in node) || !("y" in node) || typeof node.resize !== "function") {
        diff.conflicts.push({ kind: "unsupported-geometry-target", layerId: plan.layerId, nodeId: plan.nodeId });
        continue;
      }
      try {
        plan.expectedGeometry = computePsdGeometryTarget({
          baseline: plan.baseline.geometry,
          incoming: plan.incoming.geometry,
          currentAbsolute: getHierarchyNodeAbsolutePosition(node),
          currentSize: { width: node.width, height: node.height },
          currentRotation: numericOr(node.rotation, 0),
          rootAbsoluteTransform: target.absoluteTransform,
          parentAbsoluteTransform: parent.absoluteTransform
        });
        if (!(plan.expectedGeometry.size.width > 0) || !(plan.expectedGeometry.size.height > 0)) {
          throw new Error("invalid-target-size");
        }
      } catch (error) {
        diff.conflicts.push({
          kind: error instanceof Error ? error.message : "invalid-geometry-plan",
          layerId: plan.layerId,
          nodeId: plan.nodeId
        });
      }
    }
    if (plan.categories.includes("display")) {
      for (const path of plan.changedPaths.filter((value) => value.startsWith("display."))) {
        const property = path.slice("display.".length);
        if (!(property in node)) {
          diff.conflicts.push({ kind: `unsupported-display-${property}`, layerId: plan.layerId, nodeId: plan.nodeId });
        }
      }
    }
    if ((plan.categories.includes("textContent") || plan.categories.includes("textStyle")) && node.type !== "TEXT") {
      diff.conflicts.push({ kind: "unsupported-text-target", layerId: plan.layerId, nodeId: plan.nodeId });
    }
    if (plan.categories.includes("content") && plan.incoming.mode === "image" && node.type !== "RECTANGLE") {
      diff.conflicts.push({ kind: "unsupported-image-target", layerId: plan.layerId, nodeId: plan.nodeId });
    }
    if (plan.categories.includes("nineSlice") && (node.type !== "FRAME" || !("children" in node))) {
      diff.conflicts.push({ kind: "unsupported-nine-slice-target", layerId: plan.layerId, nodeId: plan.nodeId });
    }
  }
  refreshPsdIncrementalDiffStatus(diff);
}

async function resolvePsdIncrementalTarget(job) {
  const nodeId = String(job && job.targetNodeId || "");
  if (!nodeId) {
    throw new Error("增量更新缺少 targetNodeId。");
  }
  const node = await figma.getNodeByIdAsync(nodeId).catch(() => null);
  if (!node) {
    throw new Error(`找不到增量更新目标：${nodeId}`);
  }
  if (node.type !== "FRAME" && node.type !== "COMPONENT") {
    throw new Error(`增量更新只支持 FRAME 或 COMPONENT，当前为 ${node.type}。`);
  }
  return node;
}

function collectPsdBoundNodes(root) {
  const found = [];
  const visit = (node) => {
    if (isCleanupRecoveryNode(node)) return;
    const layerId = normalizePsdLayerId(readSharedPluginData(node, "psdLayerId"));
    if (layerId) {
      const storedSourceState = readStoredPsdSourceState(node);
      found.push({
        layerId,
        nodeId: node.id,
        node,
        name: String(node.name || ""),
        nodeType: node.type,
        contentHash: readSharedPluginData(node, "psdContentHash"),
        ownership: readSharedPluginData(node, "psdOwnership"),
        sourceState: storedSourceState.state,
        liveState: buildPsdLiveSourceState(node, root, storedSourceState.state),
        sourceStateHash: readSharedPluginData(node, "psdSourceStateHash"),
        sourceStateError: storedSourceState.error,
        parentId: node.parent ? node.parent.id : "",
        siblingIndex: node.parent && "children" in node.parent ? node.parent.children.indexOf(node) : -1,
        liveContentSignature: buildPsdLiveContentSignature(node, readSharedPluginData(node, "psdOwnership")),
        liveWritableFieldSignature: buildPsdLiveWritableFieldSignature(node),
        transformSignature: hashPsdSourceState({
          absoluteTransform: node.absoluteTransform || null,
          parentAbsoluteTransform: node.parent && node.parent.absoluteTransform || null
        })
      });
    }
    if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  };
  visit(root);
  return found;
}

function buildPsdLiveSourceState(node, root, storedSourceState) {
  if (!storedSourceState || !node || !root || !node.absoluteTransform || !root.absoluteTransform) return null;
  const liveState = clonePsdValue(storedSourceState);
  const liveGeometry = mapPsdLiveGeometryToSource({
    nodeAbsoluteTransform: node.absoluteTransform,
    nodeSize: { width: numericOr(node.width, 0), height: numericOr(node.height, 0) },
    nodeRotation: numericOr(node.rotation, 0),
    rootAbsoluteTransform: root.absoluteTransform
  });
  if (liveState.geometry && liveState.geometry.rotation == null) liveGeometry.rotation = null;
  liveState.geometry = liveGeometry;
  liveState.display = {
    visible: node.visible !== false,
    opacity: numericOr(node.opacity, 1),
    blendMode: "blendMode" in node ? node.blendMode : null,
    constraints: "constraints" in node && node.constraints ? clonePsdValue(node.constraints) : {}
  };
  if (node.type === "TEXT" && liveState.text) {
    const fontName = node.fontName && typeof node.fontName === "object" ? node.fontName : {};
    const lineHeight = node.lineHeight && typeof node.lineHeight === "object" ? node.lineHeight : {};
    const liveFontFamily = String(fontName.family || "");
    liveState.text.characters = String(node.characters || "");
    if (!isPsdFontFamilyAllowed(liveState.text, liveFontFamily)) {
      liveState.text.fontFamily = liveFontFamily;
    }
    liveState.text.effectiveFontSize = numericOr(node.fontSize, liveState.text.effectiveFontSize);
    liveState.text.leading = lineHeight.unit === "PIXELS" ? numericOr(lineHeight.value, 0) : 0;
    liveState.text.lineHeightMode = lineHeight.unit === "PIXELS" ? "PIXELS" : "AUTO";
    liveState.text.textAlignHorizontal = String(node.textAlignHorizontal || liveState.text.textAlignHorizontal || "LEFT");
    liveState.text.fillColor = buildPsdLiveTextFillColor(node, liveState.text.fillColor);
    liveState.text.stroke = buildPsdLiveTextStroke(node, liveState.text.stroke);
    liveState.text.dropShadow = buildPsdLiveTextShadow(node, liveState.text.dropShadow);
  }
  return normalizePsdSourceState({ sourceState: liveState });
}

function firstPsdSolidPaint(paints) {
  if (!Array.isArray(paints)) return null;
  return paints.find((paint) => paint && paint.visible !== false && paint.type === "SOLID") || null;
}

function buildPsdLiveTextFillColor(node, storedFillColor) {
  const paint = firstPsdSolidPaint(node && node.fills);
  if (!paint) return { figmaDrift: "missing-solid-fill" };
  return {
    ...(storedFillColor && typeof storedFillColor === "object" ? clonePsdValue(storedFillColor) : {}),
    r: numericOr(paint.color && paint.color.r, 0),
    g: numericOr(paint.color && paint.color.g, 0),
    b: numericOr(paint.color && paint.color.b, 0),
    a: numericOr(paint.opacity, 1)
  };
}

function buildPsdLiveTextStroke(node, storedStroke) {
  const strokes = Array.isArray(node && node.strokes) ? node.strokes : [];
  const paint = firstPsdSolidPaint(strokes);
  if (!paint) {
    return storedStroke && storedStroke.enabled === false
      ? clonePsdValue(storedStroke)
      : null;
  }
  const storedColor = storedStroke && storedStroke.color && typeof storedStroke.color === "object"
    ? storedStroke.color
    : {};
  return {
    ...(storedStroke && typeof storedStroke === "object" ? clonePsdValue(storedStroke) : {}),
    enabled: true,
    present: true,
    position: String(node.strokeAlign || "OUTSIDE"),
    opacity: numericOr(paint.opacity, 1),
    size: numericOr(node.strokeWeight, 1),
    color: {
      ...clonePsdValue(storedColor),
      r: numericOr(paint.color && paint.color.r, 0),
      g: numericOr(paint.color && paint.color.g, 0),
      b: numericOr(paint.color && paint.color.b, 0)
    }
  };
}

function buildPsdLiveTextShadow(node, storedShadow) {
  const shadows = Array.isArray(node && node.effects)
    ? node.effects.filter((effect) => effect && effect.visible !== false && effect.type === "DROP_SHADOW")
    : [];
  if (shadows.length === 0) {
    return storedShadow && storedShadow.enabled === false
      ? clonePsdValue(storedShadow)
      : null;
  }
  if (shadows.length !== 1) return { figmaDrift: "multiple-drop-shadows" };
  const effect = shadows[0];
  const offsetX = numericOr(effect.offset && effect.offset.x, 0);
  const offsetY = numericOr(effect.offset && effect.offset.y, 0);
  const storedColor = storedShadow && storedShadow.color && typeof storedShadow.color === "object"
    ? storedShadow.color
    : {};
  return {
    ...(storedShadow && typeof storedShadow === "object" ? clonePsdValue(storedShadow) : {}),
    enabled: true,
    present: true,
    opacity: numericOr(effect.color && effect.color.a, 1),
    angle: (Math.atan2(-offsetY, offsetX) * 180 / Math.PI + 360) % 360,
    distance: Math.sqrt(offsetX * offsetX + offsetY * offsetY),
    spread: Math.max(0, numericOr(effect.spread, 0)),
    blur: Math.max(0, numericOr(effect.radius, 0)),
    color: {
      ...clonePsdValue(storedColor),
      r: numericOr(effect.color && effect.color.r, 0),
      g: numericOr(effect.color && effect.color.g, 0),
      b: numericOr(effect.color && effect.color.b, 0)
    }
  };
}

async function enrichPsdLiveContentStates(currentNodes, incomingLayers, assetBytes) {
  const incomingById = new Map((incomingLayers || []).map((layer) => [
    normalizePsdLayerId(layer && layer.layerId),
    layer
  ]));
  await Promise.all((currentNodes || []).map(async (current) => {
    const source = incomingById.get(current.layerId);
    const incomingState = source ? normalizePsdSourceState(source) : null;
    if (!current.liveState || !incomingState || !incomingState.content) return;
    if (incomingState.mode !== "image" && incomingState.mode !== "nine-slice") return;

    const currentImageHash = incomingState.mode === "nine-slice"
      ? (findFirstImageHash(current.node, true) || findNineSliceSourceHash(current.node))
      : findFirstImageHash(current.node, true);
    let currentBytes = null;
    if (currentImageHash) {
      try {
        const currentImage = figma.getImageByHash(currentImageHash);
        if (currentImage) currentBytes = await currentImage.getBytesAsync();
      } catch (error) {
        currentBytes = null;
      }
    }
    const incomingBytes = assetBytes.get(String(source.assetId || source.idx || ""));
    current.liveState.content = {
      ...current.liveState.content,
      contentHash: resolvePsdLiveContentHash({
        currentBytes,
        incomingBytes,
        currentImageHash,
        incomingContentHash: incomingState.content.contentHash
      })
    };
  }));
}

function readStoredPsdSourceState(node) {
  const raw = readSharedPluginData(node, "psdSourceState");
  if (!raw) return { state: null, error: "" };
  try {
    const parsed = JSON.parse(raw);
    const state = normalizePsdSourceState({ sourceState: parsed });
    return state && state.layerId
      ? { state, error: "" }
      : { state: null, error: "invalid-stored-source-state" };
  } catch (error) {
    return { state: null, error: "invalid-stored-source-state" };
  }
}

function appendPsdIncrementalRuntimeConflicts(diff, target, currentNodes, job, manifest) {
  const schemaVersion = readSharedPluginData(target, "psdImportSchemaVersion") || readSharedPluginData(target, "psdSchemaVersion");
  if (schemaVersion !== "2" && schemaVersion !== "3") {
    diff.conflicts.push({ kind: "missing-target-metadata", message: "目标不是带增量元数据的 PSD 导入结果。" });
  }
  for (const current of currentNodes) {
    if (current.sourceStateError) {
      diff.conflicts.push({
        kind: current.sourceStateError,
        layerId: current.layerId,
        nodeId: current.nodeId
      });
    }
  }
  const storedWidth = numericOr(readSharedPluginData(target, "psdCanvasWidth"), 0);
  const storedHeight = numericOr(readSharedPluginData(target, "psdCanvasHeight"), 0);
  if (storedWidth !== manifest.canvas.width || storedHeight !== manifest.canvas.height) {
    diff.conflicts.push({ kind: "source-canvas-mismatch", expected: `${storedWidth}x${storedHeight}`, actual: `${manifest.canvas.width}x${manifest.canvas.height}` });
  }
  const identity = measurePsdLayerIdentity(currentNodes, manifest.layers);
  const storedFileName = readSharedPluginData(target, "psdSourceFileName");
  const incomingFileName = normalizedPsdSourceFileName(job);
  const fileNameChanged = !!(storedFileName && incomingFileName && storedFileName !== incomingFileName);
  if (identity.currentCount === 0 && identity.incomingCount > 0) {
    diff.conflicts.push({ kind: "no-bound-target-layers", message: "目标中没有可匹配的 PSD Layer ID。" });
  } else if (!fileNameChanged && identity.currentCount > 0 && identity.currentCoverage < 0.5 && identity.incomingCoverage < 0.5) {
    diff.conflicts.push({ kind: "source-layer-identity-mismatch", message: `PSD Layer ID 重合率仅 ${Math.round(identity.overlap * 100)}%。` });
  }
  if (fileNameChanged) {
    if (identity.overlap >= 0.8) {
      diff.identityWarning = {
        kind: "source-file-renamed",
        expected: storedFileName,
        actual: incomingFileName,
        overlap: identity.overlap
      };
    } else {
      diff.conflicts.push({ kind: "source-file-and-identity-mismatch", expected: storedFileName, actual: incomingFileName });
    }
  }
  for (const pair of diff.changed) {
    const node = pair.target.node;
    const conflictKind = validatePsdOwnedTarget(
      pair.target.ownership,
      pair.source.mode,
      node && node.type,
      node && node.type === "TEXT" ? node.textAutoResize : ""
    );
    const fontName = node && node.type === "TEXT" ? node.fontName : null;
    const imagePaintCount = node && node.type === "RECTANGLE" && Array.isArray(node.fills)
      ? node.fills.filter((paint) => paint && paint.type === "IMAGE").length
      : 0;
    const paintConflict = pair.source.mode === "image" && imagePaintCount !== 1 ? "unsafe-image-fill-structure" : "";
    const nineSlicePaintCount = node && node.type === "FRAME" && Array.isArray(node.fills)
      ? node.fills.filter((paint) => paint && paint.type === "IMAGE").length
      : 0;
    const nineSlicePaintConflict = pair.source.mode === "nine-slice" && nineSlicePaintCount !== 1
      ? "unsafe-nine-slice-fill-structure"
      : "";
    if (conflictKind || paintConflict || nineSlicePaintConflict || (pair.source.mode === "text" && (!fontName || typeof fontName !== "object"))) {
      diff.conflicts.push({
        kind: conflictKind || paintConflict || nineSlicePaintConflict || "unsupported-text-font",
        layerId: pair.source.layerId,
        nodeId: pair.target.nodeId
      });
    }
  }
  refreshPsdIncrementalDiffStatus(diff);
}

function appendPsdIncrementalAssetConflicts(diff, context) {
  const sources = diff.changed
    .map((item) => item.source)
    .filter((layer) => psdOwnershipForMode(layer.mode) !== "protected")
    .concat(diff.added.map((item) => item.source))
    .filter((layer) => layer.mode !== "text");
  for (const layer of sources) {
    const bytes = context.assetBytes.get(String(layer.assetId));
    if (!bytes || bytes.length < 8) {
      diff.conflicts.push({ kind: "missing-raster-bytes", layerId: layer.layerId, name: layer.name });
      continue;
    }
    const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (!pngSignature.every((value, index) => bytes[index] === value)) {
      diff.conflicts.push({ kind: "invalid-raster-bytes", layerId: layer.layerId, name: layer.name });
    }
  }
  refreshPsdIncrementalDiffStatus(diff);
}

function refreshPsdIncrementalDiffStatus(diff) {
  diff.summary.conflicts = diff.conflicts.length;
  diff.status = diff.conflicts.length > 0
    ? "preview-blocked"
    : diff.baselineRequired.length > 0
      ? "preview-baseline-required"
      : diff.changed.length === 0 && diff.added.length === 0
        ? "preview-no-changes"
        : "preview-ready";
  diff.canApply = diff.status === "preview-ready";
}

function buildPsdIncrementalFingerprint(target, currentNodes, incomingLayers) {
  const current = currentNodes
    .map((item) => [
      item.layerId,
      item.nodeId,
      item.parentId,
      item.siblingIndex,
      item.nodeType,
      item.ownership,
      item.sourceStateHash,
      item.liveContentSignature,
      item.liveWritableFieldSignature,
      item.transformSignature
    ].join(":"))
    .sort()
    .join("|");
  const incoming = incomingLayers
    .map((item) => `${normalizePsdLayerId(item.layerId)}:${hashPsdSourceState(normalizePsdSourceState(item))}`)
    .sort()
    .join("|");
  const currentIds = new Set(currentNodes.map((item) => item.layerId));
  const incomingIds = new Set(incomingLayers.map((item) => normalizePsdLayerId(item.layerId)).filter(Boolean));
  const added = Array.from(incomingIds).filter((layerId) => !currentIds.has(layerId)).sort().join(",");
  const missing = Array.from(currentIds).filter((layerId) => !incomingIds.has(layerId)).sort().join(",");
  const targetTransform = hashPsdSourceState(target.absoluteTransform || null);
  return `${target.id}:${targetTransform}::${current}::${incoming}::added=${added}::missing=${missing}`;
}

function buildPsdLiveContentSignature(node, ownership) {
  if (ownership === "text-content" && node.type === "TEXT") {
    return `text:${hashPsdString(node.characters)}`;
  }
  if (ownership === "image-content" && node.type === "RECTANGLE" && Array.isArray(node.fills)) {
    const imageHashes = node.fills
      .filter((paint) => paint && paint.type === "IMAGE")
      .map((paint) => String(paint.imageHash || ""));
    return `image:${imageHashes.join(",")}`;
  }
  return "protected";
}

function buildPsdLiveWritableFieldSignature(node) {
  const liveState = {
    geometry: {
      x: numericOr(node && node.x, 0),
      y: numericOr(node && node.y, 0),
      width: numericOr(node && node.width, 0),
      height: numericOr(node && node.height, 0),
      rotation: numericOr(node && node.rotation, 0)
    },
    display: {
      visible: !node || node.visible !== false,
      opacity: numericOr(node && node.opacity, 1),
      blendMode: String(node && node.blendMode || ""),
      constraints: node && node.constraints ? node.constraints : {}
    },
    text: node && node.type === "TEXT" ? {
      characters: String(node.characters || ""),
      fontName: node.fontName,
      fontSize: node.fontSize,
      lineHeight: node.lineHeight,
      textAlignHorizontal: node.textAlignHorizontal
    } : null
  };
  return hashPsdSourceState(liveState);
}

function buildPsdIncrementalResult(prepared, status) {
  const serializePair = (item) => ({
    layerId: normalizePsdLayerId(item.source && item.source.layerId || item.target && item.target.layerId),
    sourceName: String(item.source && item.source.name || ""),
    targetName: String(item.target && item.target.name || ""),
    targetNodeId: String(item.target && item.target.nodeId || ""),
    changes: Array.isArray(item.changes) ? item.changes.map((change) => ({
      path: String(change.path || ""),
      category: String(change.category || ""),
      before: change.before,
      after: change.after,
      delta: change.delta
    })) : []
  });
  return {
    status,
    canApply: prepared.diff.canApply,
    targetNodeId: prepared.target.id,
    targetName: prepared.target.name,
    baselineFingerprint: prepared.baselineFingerprint,
    summary: prepared.diff.summary,
    groups: {
      changed: prepared.diff.changed.map(serializePair),
      unchanged: prepared.diff.unchanged.map(serializePair),
      added: prepared.diff.added.map(serializePair),
      missing: prepared.diff.missing.map(serializePair),
      baselineRequired: prepared.diff.baselineRequired.map(serializePair),
      conflicts: prepared.diff.conflicts.map((item) => ({
        kind: String(item.kind || "unknown"),
        layerId: normalizePsdLayerId(item.layerId),
        nodeId: String(item.nodeId || item.duplicate && item.duplicate.nodeId || ""),
        name: String(item.name || ""),
        message: String(item.message || ""),
        expected: String(item.expected || ""),
        actual: String(item.actual || "")
      }))
    },
    warnings: prepared.context.warnings,
    errors: prepared.context.errors
  };
}

function findPsdIncrementalStagingFrame(target) {
  if (!("children" in target)) return null;
  return target.children.find((child) => child.type === "FRAME" && child.name === "__PSD新增待整理") || null;
}

function createPsdIncrementalStagingFrame(target) {
  const frame = figma.createFrame();
  frame.name = "__PSD新增待整理";
  frame.resize(positiveOr(target.width, 1), positiveOr(target.height, 1));
  frame.fills = [];
  frame.strokes = [];
  frame.clipsContent = false;
  if ("layoutMode" in frame) frame.layoutMode = "NONE";
  target.appendChild(frame);
  if (target.layoutMode && target.layoutMode !== "NONE" && "layoutPositioning" in frame) {
    frame.layoutPositioning = "ABSOLUTE";
  }
  frame.x = 0;
  frame.y = 0;
  return frame;
}

function isPsdOwnedSliceChild(node) {
  if (!node) return false;
  if (readSharedPluginData(node, "psdSliceRole") === "slice") return true;
  return !!readSharedPluginData(node, "parentLayerIndex")
    && String(node.name || "").startsWith("__slice");
}

function buildPsdComponentIdentity(node) {
  let mainComponentId = "";
  try {
    mainComponentId = "mainComponent" in node && node.mainComponent
      ? String(node.mainComponent.id || "")
      : "";
  } catch (error) {
    mainComponentId = "";
  }
  return [String(node.type || ""), String(node.id || ""), mainComponentId].join(":");
}

function capturePsdStructuralSnapshot(root) {
  const snapshots = [];
  const visit = (node) => {
    if (isPsdOwnedSliceChild(node)) return;
    snapshots.push({
      node,
      id: node.id,
      name: String(node.name || ""),
      parentId: node.parent ? node.parent.id : "",
      siblingIndex: node.parent && "children" in node.parent ? node.parent.children.indexOf(node) : -1,
      type: String(node.type || ""),
      componentIdentity: buildPsdComponentIdentity(node),
      nonPsdChildIds: "children" in node
        ? node.children.filter((child) => !isPsdOwnedSliceChild(child)).map((child) => child.id)
        : []
    });
    if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  };
  visit(root);
  return snapshots;
}

function verifyPsdStructuralSnapshot(snapshots, allowedAddedNodeIds) {
  const allowed = allowedAddedNodeIds || new Set();
  const errors = [];
  for (const item of snapshots) {
    const node = item.node;
    if (!node || node.removed) {
      errors.push(`${item.id}:removed`);
      continue;
    }
    const parentId = node.parent ? node.parent.id : "";
    const siblingIndex = node.parent && "children" in node.parent ? node.parent.children.indexOf(node) : -1;
    const childIds = "children" in node
      ? node.children
        .filter((child) => !isPsdOwnedSliceChild(child) && !allowed.has(child.id))
        .map((child) => child.id)
      : [];
    if (node.id !== item.id
      || String(node.name || "") !== item.name
      || parentId !== item.parentId
      || siblingIndex !== item.siblingIndex
      || String(node.type || "") !== item.type
      || buildPsdComponentIdentity(node) !== item.componentIdentity
      || childIds.join("|") !== item.nonPsdChildIds.join("|")) {
      errors.push(`${item.id}:structural-drift`);
    }
  }
  return errors;
}

function capturePsdProtectedSnapshot(root) {
  const snapshots = [];
  const visit = (node) => {
    snapshots.push({
      node,
      id: node.id,
      name: String(node.name || ""),
      parentId: node.parent ? node.parent.id : "",
      index: node.parent && "children" in node.parent ? node.parent.children.indexOf(node) : -1,
      x: numericOr(node.x, 0),
      y: numericOr(node.y, 0),
      width: numericOr(node.width, 0),
      height: numericOr(node.height, 0),
      rotation: numericOr(node.rotation, 0),
      layoutPositioning: "layoutPositioning" in node ? String(node.layoutPositioning || "") : ""
    });
    if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  };
  visit(root);
  return snapshots;
}

function verifyPsdProtectedSnapshot(snapshots) {
  const errors = [];
  for (const item of snapshots) {
    const node = item.node;
    if (!node || node.removed) {
      errors.push(`${item.id} 已被删除`);
      continue;
    }
    const parentId = node.parent ? node.parent.id : "";
    const index = node.parent && "children" in node.parent ? node.parent.children.indexOf(node) : -1;
    const changed = node.name !== item.name
      || parentId !== item.parentId
      || index !== item.index
      || Math.abs(numericOr(node.x, 0) - item.x) > 0.01
      || Math.abs(numericOr(node.y, 0) - item.y) > 0.01
      || Math.abs(numericOr(node.width, 0) - item.width) > 0.01
      || Math.abs(numericOr(node.height, 0) - item.height) > 0.01
      || Math.abs(numericOr(node.rotation, 0) - item.rotation) > 0.01
      || ("layoutPositioning" in node && String(node.layoutPositioning || "") !== item.layoutPositioning);
    if (changed) errors.push(`${item.id}:${item.name}`);
  }
  return errors;
}

function applyPsdGeometryPlan(plan, node) {
  const target = plan.expectedGeometry;
  if (!target) throw new Error("missing-expected-geometry");
  if (plan.changedPaths.includes("geometry.width") || plan.changedPaths.includes("geometry.height")) {
    node.resize(target.size.width, target.size.height);
  }
  if (plan.changedPaths.includes("geometry.x") || plan.changedPaths.includes("geometry.y")) {
    node.x = target.localPosition.x;
    node.y = target.localPosition.y;
  }
  if (plan.changedPaths.includes("geometry.rotation")) node.rotation = target.rotation;
}

function applyPsdDisplayPlan(plan, node) {
  const display = plan.incoming.display;
  if (plan.changedPaths.includes("display.visible")) node.visible = display.visible;
  if (plan.changedPaths.includes("display.opacity")) node.opacity = display.opacity;
  if (plan.changedPaths.includes("display.blendMode")) node.blendMode = display.blendMode;
  if (plan.changedPaths.includes("display.constraints")) node.constraints = clonePsdValue(display.constraints);
}

function applyPsdTextStroke(node, stroke) {
  if (!stroke || stroke.enabled !== true) {
    node.strokes = [];
    return;
  }
  const color = stroke.color || stroke;
  node.strokes = [solidPaintFromManifest(color, 1)];
  node.strokeWeight = numericOr(stroke.size, 1);
  node.strokeAlign = "OUTSIDE";
}

function applyPsdTextShadow(node, shadow) {
  const retained = Array.isArray(node.effects)
    ? node.effects.filter((effect) => !effect || effect.type !== "DROP_SHADOW")
    : [];
  if (!shadow || shadow.enabled !== true) {
    node.effects = retained;
    return;
  }
  const color = shadow.color || {};
  const angleRadians = numericOr(shadow.angle, 0) * Math.PI / 180;
  const distance = numericOr(shadow.distance, 0);
  retained.push({
    type: "DROP_SHADOW",
    color: {
      r: numericOr(color.r, 0),
      g: numericOr(color.g, 0),
      b: numericOr(color.b, 0),
      a: numericOr(shadow.opacity, numericOr(color.a, 1))
    },
    offset: {
      x: Math.cos(angleRadians) * distance,
      y: -Math.sin(angleRadians) * distance
    },
    radius: Math.max(0, numericOr(shadow.blur, 0)),
    spread: Math.max(0, numericOr(shadow.spread, 0)),
    visible: true,
    blendMode: "NORMAL"
  });
  node.effects = retained;
}

async function applyPsdTextPlan(plan, pair, prepared) {
  const node = pair.target.node;
  const text = plan.incoming.text || {};
  if (plan.changedPaths.includes("text.fontFamily") || plan.changedPaths.includes("text.fontFallback")) {
    const resolvedFont = prepared.resolvedFonts.get(plan.layerId);
    if (!resolvedFont) throw new Error("missing-resolved-font");
    node.fontName = resolvedFont;
  }
  if (plan.changedPaths.includes("text.characters")) node.characters = String(text.characters || "");
  if (plan.changedPaths.includes("text.fontSize") || plan.changedPaths.includes("text.effectiveFontSize")) {
    node.fontSize = positiveOr(text.effectiveFontSize, positiveOr(text.fontSize, node.fontSize));
  }
  if (plan.changedPaths.includes("text.leading") || plan.changedPaths.includes("text.lineHeightMode")) {
    node.lineHeight = text.lineHeightMode === "PIXELS" && Number(text.leading) > 0
      ? { unit: "PIXELS", value: Number(text.leading) }
      : { unit: "AUTO" };
  }
  if (plan.changedPaths.includes("text.textAlignHorizontal")) {
    node.textAlignHorizontal = text.textAlignHorizontal;
  }
  if (plan.changedPaths.includes("text.fillColor")) {
    node.fills = [solidPaintFromManifest(text.fillColor || {}, 1)];
  }
  if (plan.changedPaths.includes("text.stroke")) applyPsdTextStroke(node, text.stroke);
  if (plan.changedPaths.includes("text.dropShadow")) applyPsdTextShadow(node, text.dropShadow);
  node.textAutoResize = "NONE";
}

async function applyPsdNineSlicePlan(plan, pair, prepared) {
  const node = pair.target.node;
  if (!("children" in node)) throw new Error("unsupported-nine-slice-target");
  const imagePaint = prepared.imagePaints.get(plan.layerId);
  if (!imagePaint || !imagePaint.imageHash) throw new Error("missing-nine-slice-image");
  node.fills = replacePsdOwnedImageHash(node.fills, imagePaint);
  for (const child of node.children.slice().reverse()) {
    if (isPsdOwnedSliceChild(child)) child.remove();
  }
  const nineSlice = plan.incoming.nineSlice || {};
  const slices = Array.isArray(nineSlice.slices)
    ? nineSlice.slices
    : (Array.isArray(pair.source.slices) ? pair.source.slices : []);
  for (const slice of slices) {
    const sliceNode = figma.createRectangle();
    sliceNode.name = String(slice.name || "__slice");
    node.appendChild(sliceNode);
    const target = normalizeRectArray(slice.target);
    sliceNode.x = target[0];
    sliceNode.y = target[1];
    sliceNode.resize(positiveOr(target[2], 1), positiveOr(target[3], 1));
    sliceNode.fills = [createImagePaintFromHash(
      imagePaint.imageHash,
      "CROP",
      buildCropTransform(slice, pair.source),
      1
    )];
    sliceNode.strokes = [];
    sliceNode.constraints = inferSliceConstraints(sliceNode, node);
    writePluginData(sliceNode, {
      sourceRect: JSON.stringify(normalizeRectArray(slice.source)),
      parentLayerIndex: String(pair.source.idx),
      psdParentLayerId: plan.layerId,
      psdSliceRole: "slice"
    });
  }
}

async function applyPsdMutationPlans(prepared) {
  for (const plan of prepared.plans) {
    const pair = { source: plan.source, target: plan.target };
    const node = plan.target.node;
    if (plan.categories.includes("content") && plan.incoming.mode === "image") {
      node.fills = replacePsdOwnedImageHash(node.fills, prepared.imagePaints.get(plan.layerId));
    }
    if (plan.categories.includes("textContent") || plan.categories.includes("textStyle")) {
      await applyPsdTextPlan(plan, pair, prepared);
    }
    if (plan.categories.some((category) => (
      category === "position" || category === "size" || category === "rotation"
    ))) {
      applyPsdGeometryPlan(plan, node);
    }
    if (plan.categories.includes("display")) applyPsdDisplayPlan(plan, node);
    if (plan.categories.includes("nineSlice")) await applyPsdNineSlicePlan(plan, pair, prepared);
  }
}

async function preloadPsdMutationAssets(prepared) {
  prepared.imagePaints = new Map();
  prepared.resolvedFonts = new Map();
  for (const plan of prepared.plans) {
    if (plan.target.node.type === "TEXT" && plan.target.node.fontName && typeof plan.target.node.fontName === "object") {
      await figma.loadFontAsync(plan.target.node.fontName);
    }
    if (plan.categories.includes("textContent") || plan.categories.includes("textStyle")) {
      plan.expectedFontName = await loadBestFont(plan.source, prepared.context);
      prepared.resolvedFonts.set(plan.layerId, plan.expectedFontName);
    }
    if ((plan.incoming.mode === "image" && plan.categories.includes("content"))
      || plan.categories.includes("nineSlice")) {
      plan.expectedImagePaint = await createImagePaint(plan.source, prepared.context, "FILL", null);
      prepared.imagePaints.set(plan.layerId, plan.expectedImagePaint);
    }
  }
  for (const item of prepared.diff.added) {
    if (item.source.mode === "text") {
      await loadBestFont(item.source, prepared.context);
    } else {
      await createImagePaint(item.source, prepared.context, "FILL", null);
    }
  }
}

function preparePsdAddedLayerTransaction() {
  return {
    stagingFrame: null,
    createdStagingFrame: false,
    existingChildIds: new Set(),
    createdNodes: [],
    createdNodeIds: new Set()
  };
}

async function applyPsdAddedLayers(prepared, transaction) {
  if (prepared.diff.added.length === 0) return;
  transaction.stagingFrame = findPsdIncrementalStagingFrame(prepared.target);
  if (!transaction.stagingFrame) {
    transaction.stagingFrame = createPsdIncrementalStagingFrame(prepared.target);
    transaction.createdStagingFrame = true;
  } else {
    transaction.existingChildIds = new Set(transaction.stagingFrame.children.map((child) => child.id));
  }
  if (transaction.createdStagingFrame) transaction.createdNodeIds.add(transaction.stagingFrame.id);
  for (const item of prepared.diff.added) {
    const node = await createLayerNode(transaction.stagingFrame, item.source, prepared.context);
    if (!node) continue;
    transaction.createdNodes.push(node);
    transaction.createdNodeIds.add(node.id);
    prepared.context.nodeByLayerIdx.set(String(item.source.idx), node.id);
  }
}

function psdNumberMatches(actual, expected) {
  return Number.isFinite(Number(actual))
    && Number.isFinite(Number(expected))
    && Math.abs(Number(actual) - Number(expected)) <= 0.01;
}

function psdSolidPaintMatches(actual, expectedColor) {
  return !!actual && actual.type === "SOLID"
    && psdNumberMatches(actual.color && actual.color.r, expectedColor && expectedColor.r)
    && psdNumberMatches(actual.color && actual.color.g, expectedColor && expectedColor.g)
    && psdNumberMatches(actual.color && actual.color.b, expectedColor && expectedColor.b);
}

function verifyPsdTextStroke(node, stroke) {
  const strokes = Array.isArray(node.strokes) ? node.strokes : [];
  if (!stroke || stroke.enabled !== true) return strokes.length === 0;
  const color = stroke.color || stroke;
  return strokes.length === 1
    && psdSolidPaintMatches(strokes[0], color)
    && psdNumberMatches(node.strokeWeight, numericOr(stroke.size, 1))
    && node.strokeAlign === "OUTSIDE";
}

function verifyPsdTextShadow(node, shadow) {
  const effects = Array.isArray(node.effects)
    ? node.effects.filter((effect) => effect && effect.type === "DROP_SHADOW")
    : [];
  if (!shadow || shadow.enabled !== true) return effects.length === 0;
  if (effects.length !== 1) return false;
  const effect = effects[0];
  const color = shadow.color || {};
  const angleRadians = numericOr(shadow.angle, 0) * Math.PI / 180;
  const distance = numericOr(shadow.distance, 0);
  return psdNumberMatches(effect.color && effect.color.r, numericOr(color.r, 0))
    && psdNumberMatches(effect.color && effect.color.g, numericOr(color.g, 0))
    && psdNumberMatches(effect.color && effect.color.b, numericOr(color.b, 0))
    && psdNumberMatches(effect.color && effect.color.a, numericOr(shadow.opacity, numericOr(color.a, 1)))
    && psdNumberMatches(effect.offset && effect.offset.x, Math.cos(angleRadians) * distance)
    && psdNumberMatches(effect.offset && effect.offset.y, -Math.sin(angleRadians) * distance)
    && psdNumberMatches(effect.radius, Math.max(0, numericOr(shadow.blur, 0)))
    && psdNumberMatches(effect.spread, Math.max(0, numericOr(shadow.spread, 0)));
}

function verifyPsdAppliedFields(plans) {
  const errors = [];
  for (const plan of plans) {
    const node = plan.target.node;
    const geometry = plan.expectedGeometry;
    const display = plan.incoming.display || {};
    const text = plan.incoming.text || {};
    for (const path of plan.changedPaths) {
      let valid = true;
      if (path === "geometry.x") valid = geometry && psdNumberMatches(node.x, geometry.localPosition.x);
      else if (path === "geometry.y") valid = geometry && psdNumberMatches(node.y, geometry.localPosition.y);
      else if (path === "geometry.width") valid = geometry && psdNumberMatches(node.width, geometry.size.width);
      else if (path === "geometry.height") valid = geometry && psdNumberMatches(node.height, geometry.size.height);
      else if (path === "geometry.rotation") valid = geometry && psdNumberMatches(node.rotation, geometry.rotation);
      else if (path === "display.visible") valid = node.visible === display.visible;
      else if (path === "display.opacity") valid = psdNumberMatches(node.opacity, display.opacity);
      else if (path === "display.blendMode") valid = node.blendMode === display.blendMode;
      else if (path === "display.constraints") {
        valid = stablePsdSourceStateJson(node.constraints) === stablePsdSourceStateJson(display.constraints);
      } else if (path === "content.contentHash" && plan.incoming.mode === "image") {
        const imagePaint = plan.expectedImagePaint;
        const imageFills = Array.isArray(node.fills)
          ? node.fills.filter((paint) => paint && paint.type === "IMAGE")
          : [];
        valid = !!imagePaint && imageFills.length === 1 && imageFills[0].imageHash === imagePaint.imageHash;
      } else if (path === "text.characters") valid = node.characters === String(text.characters || "");
      else if (path === "text.fontFamily" || path === "text.fontFallback") {
        valid = stablePsdSourceStateJson(node.fontName) === stablePsdSourceStateJson(plan.expectedFontName);
      } else if (path === "text.fontSize" || path === "text.effectiveFontSize") {
        valid = psdNumberMatches(node.fontSize, positiveOr(text.effectiveFontSize, text.fontSize));
      } else if (path === "text.leading" || path === "text.lineHeightMode") {
        const expectedLineHeight = text.lineHeightMode === "PIXELS" && Number(text.leading) > 0
          ? { unit: "PIXELS", value: Number(text.leading) }
          : { unit: "AUTO" };
        valid = stablePsdSourceStateJson(node.lineHeight) === stablePsdSourceStateJson(expectedLineHeight);
      } else if (path === "text.textAlignHorizontal") valid = node.textAlignHorizontal === text.textAlignHorizontal;
      else if (path === "text.fillColor") {
        valid = Array.isArray(node.fills) && node.fills.length === 1 && psdSolidPaintMatches(node.fills[0], text.fillColor || {});
      } else if (path === "text.stroke") valid = verifyPsdTextStroke(node, text.stroke);
      else if (path === "text.dropShadow") valid = verifyPsdTextShadow(node, text.dropShadow);
      else if (path === "nineSlice") {
        const slices = "children" in node ? node.children.filter(isPsdOwnedSliceChild) : [];
        const expectedSlices = plan.incoming.nineSlice && Array.isArray(plan.incoming.nineSlice.slices)
          ? plan.incoming.nineSlice.slices
          : [];
        valid = slices.length === expectedSlices.length
          && !!plan.expectedImagePaint
          && hasExpectedNineSliceImageHash(node, plan.expectedImagePaint.imageHash);
      }
      if (!valid) errors.push(`${plan.layerId}:${path}`);
    }
  }
  return errors;
}

function buildPsdIncrementalMetadataExtra(plan, prepared) {
  if (plan.incoming.mode === "nine-slice") {
    const nineSlice = plan.incoming.nineSlice || {};
    return {
      border: JSON.stringify(nineSlice.border || {}),
      sliceCount: String(Array.isArray(nineSlice.slices) ? nineSlice.slices.length : 0),
      sourceImageFillIndex: "0",
      nodeRole: "nineSliceParent"
    };
  }
  if (plan.incoming.mode === "text") {
    const fontName = prepared.resolvedFonts.get(plan.layerId) || {};
    const text = plan.incoming.text || {};
    return {
      fontFamily: String(fontName.family || ""),
      fontStyle: String(fontName.style || ""),
      effectiveFontSize: String(firstDefined(text.effectiveFontSize, text.fontSize)),
      originalFontSize: String(firstDefined(text.fontSize, ""))
    };
  }
  return {};
}

function replacePsdOwnedImageHash(fills, decodedPaint) {
  let replaced = 0;
  const updated = fills.map((paint) => {
    if (!paint || paint.type !== "IMAGE") return paint;
    replaced += 1;
    return Object.assign({}, paint, { imageHash: decodedPaint.imageHash });
  });
  if (replaced !== 1) {
    throw new Error(`图片节点需要且只能包含一个 IMAGE fill，当前为 ${replaced}`);
  }
  return updated;
}

function verifyPsdAddedNodes(createdNodes, addedItems, stagingFrame, context) {
  const errors = [];
  if (createdNodes.length !== addedItems.length) {
    errors.push(`新增节点数量不一致：${createdNodes.length}/${addedItems.length}`);
  }
  for (const item of addedItems) {
    const layerId = normalizePsdLayerId(item.source.layerId);
    const node = createdNodes.find((candidate) => readSharedPluginData(candidate, "psdLayerId") === layerId);
    if (!node) {
      errors.push(`新增 Layer ID ${layerId} 未创建`);
      continue;
    }
    if (node.parent !== stagingFrame) errors.push(`新增 Layer ID ${layerId} 不在待整理容器`);
    if (readSharedPluginData(node, "psdContentHash") !== String(item.source.contentHash || "")) {
      errors.push(`新增 Layer ID ${layerId} 内容哈希不一致`);
    }
    const expectedSourceState = normalizePsdSourceState(item.source);
    const expectedSourceStateHash = hashPsdSourceState(expectedSourceState);
    if (readSharedPluginData(node, "psdSourceStateHash") !== expectedSourceStateHash) {
      errors.push(`Added Layer ID ${layerId} has invalid PSD source-state hash`);
    }
    const storedSourceState = readStoredPsdSourceState(node);
    if (storedSourceState.error
      || stablePsdSourceStateJson(storedSourceState.state) !== stablePsdSourceStateJson(expectedSourceState)) {
      errors.push(`Added Layer ID ${layerId} has invalid PSD source state`);
    }
    const expectedOwnership = psdOwnershipForMode(item.source.mode);
    if (readSharedPluginData(node, "psdOwnership") !== expectedOwnership) {
      errors.push(`Added Layer ID ${layerId} has invalid PSD ownership`);
    }
    if (item.source.mode === "image") {
      const imagePaints = node.type === "RECTANGLE" && Array.isArray(node.fills)
        ? node.fills.filter((paint) => paint && paint.type === "IMAGE")
        : [];
      const expectedImageHash = context && context.imageHashes
        ? context.imageHashes.get(String(item.source.assetId))
        : "";
      if (imagePaints.length !== 1 || !expectedImageHash || imagePaints[0].imageHash !== expectedImageHash) {
        errors.push(`Added Layer ID ${layerId} has invalid image content`);
      }
    }
    if (item.source.mode === "nine-slice") {
      const expectedImageHash = context && context.imageHashes
        ? context.imageHashes.get(String(item.source.assetId))
        : "";
      if (node.type !== "FRAME" || validateSliceFrame(node) !== 0 || !hasExpectedNineSliceImageHash(node, expectedImageHash)) {
        errors.push(`Added Layer ID ${layerId} has invalid slice structure`);
      }
    }
    if (item.source.mode === "text" && node.type === "TEXT" && node.characters !== String(item.source.chars || "")) {
      errors.push(`新增 Layer ID ${layerId} 文本内容不一致`);
    }
  }
  return errors;
}

function clonePsdValue(value) {
  if (Array.isArray(value)) return value.map(clonePsdValue);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value)) result[key] = clonePsdValue(value[key]);
  return result;
}

function capturePsdSliceChildren(node) {
  if (!("children" in node)) return [];
  return node.children.filter(isPsdOwnedSliceChild).map((child) => ({
    index: node.children.indexOf(child),
    name: String(child.name || ""),
    x: numericOr(child.x, 0),
    y: numericOr(child.y, 0),
    width: positiveOr(child.width, 1),
    height: positiveOr(child.height, 1),
    rotation: numericOr(child.rotation, 0),
    visible: child.visible !== false,
    opacity: numericOr(child.opacity, 1),
    fills: "fills" in child ? clonePsdValue(child.fills) : [],
    strokes: "strokes" in child ? clonePsdValue(child.strokes) : [],
    effects: "effects" in child ? clonePsdValue(child.effects) : [],
    constraints: "constraints" in child ? clonePsdValue(child.constraints) : null,
    metadata: {
      sourceRect: readSharedPluginData(child, "sourceRect"),
      parentLayerIndex: readSharedPluginData(child, "parentLayerIndex"),
      psdParentLayerId: readSharedPluginData(child, "psdParentLayerId"),
      psdSliceRole: readSharedPluginData(child, "psdSliceRole")
    }
  }));
}

function capturePsdMutationRollback(node) {
  return {
    node,
    x: "x" in node ? node.x : null,
    y: "y" in node ? node.y : null,
    width: "width" in node ? node.width : null,
    height: "height" in node ? node.height : null,
    rotation: "rotation" in node ? node.rotation : null,
    visible: "visible" in node ? node.visible : null,
    opacity: "opacity" in node ? node.opacity : null,
    blendMode: "blendMode" in node ? node.blendMode : null,
    constraints: "constraints" in node ? clonePsdValue(node.constraints) : null,
    characters: "characters" in node ? node.characters : null,
    fontName: "fontName" in node ? clonePsdValue(node.fontName) : null,
    fontSize: "fontSize" in node ? node.fontSize : null,
    lineHeight: "lineHeight" in node ? clonePsdValue(node.lineHeight) : null,
    textAlignHorizontal: "textAlignHorizontal" in node ? node.textAlignHorizontal : null,
    textAutoResize: "textAutoResize" in node ? node.textAutoResize : null,
    fills: "fills" in node ? clonePsdValue(node.fills) : null,
    strokes: "strokes" in node ? clonePsdValue(node.strokes) : null,
    strokeWeight: "strokeWeight" in node ? node.strokeWeight : null,
    strokeAlign: "strokeAlign" in node ? node.strokeAlign : null,
    effects: "effects" in node ? clonePsdValue(node.effects) : null,
    sliceChildren: capturePsdSliceChildren(node),
    metadata: capturePsdLayerMetadata(node)
  };
}

function restorePsdSliceChildren(node, records) {
  if (!("children" in node)) return;
  for (const child of node.children.slice().reverse()) {
    if (isPsdOwnedSliceChild(child)) child.remove();
  }
  for (const record of records.slice().sort((left, right) => left.index - right.index)) {
    const child = figma.createRectangle();
    child.name = record.name;
    const insertIndex = Math.max(0, Math.min(record.index, node.children.length));
    if (typeof node.insertChild === "function") node.insertChild(insertIndex, child);
    else node.appendChild(child);
    child.resize(record.width, record.height);
    child.x = record.x;
    child.y = record.y;
    child.rotation = record.rotation;
    child.visible = record.visible;
    child.opacity = record.opacity;
    child.fills = clonePsdValue(record.fills);
    child.strokes = clonePsdValue(record.strokes);
    child.effects = clonePsdValue(record.effects);
    if (record.constraints) child.constraints = clonePsdValue(record.constraints);
    writePluginData(child, record.metadata);
  }
}

function restorePsdMutationRollback(record) {
  const node = record.node;
  if (!node || node.removed) throw new Error("rollback-target-removed");
  if (record.width !== null && record.height !== null && typeof node.resize === "function") {
    node.resize(record.width, record.height);
  }
  if (record.x !== null) node.x = record.x;
  if (record.y !== null) node.y = record.y;
  if (record.rotation !== null) node.rotation = record.rotation;
  if (record.visible !== null) node.visible = record.visible;
  if (record.opacity !== null) node.opacity = record.opacity;
  if (record.blendMode !== null) node.blendMode = record.blendMode;
  if (record.constraints !== null) node.constraints = clonePsdValue(record.constraints);
  if (record.fontName !== null) node.fontName = clonePsdValue(record.fontName);
  if (record.fontSize !== null) node.fontSize = record.fontSize;
  if (record.lineHeight !== null) node.lineHeight = clonePsdValue(record.lineHeight);
  if (record.textAlignHorizontal !== null) node.textAlignHorizontal = record.textAlignHorizontal;
  if (record.textAutoResize !== null) node.textAutoResize = record.textAutoResize;
  if (record.characters !== null) node.characters = record.characters;
  if (record.fills !== null) node.fills = clonePsdValue(record.fills);
  if (record.strokes !== null) node.strokes = clonePsdValue(record.strokes);
  if (record.strokeWeight !== null) node.strokeWeight = record.strokeWeight;
  if (record.strokeAlign !== null) node.strokeAlign = record.strokeAlign;
  if (record.effects !== null) node.effects = clonePsdValue(record.effects);
  restorePsdSliceChildren(node, record.sliceChildren);
  writePluginData(node, record.metadata);
}

function verifyPsdRollbackRecords(records) {
  const errors = [];
  const numericFields = ["x", "y", "width", "height", "rotation", "opacity", "fontSize", "strokeWeight"];
  const exactFields = [
    "visible", "blendMode", "characters", "textAlignHorizontal", "textAutoResize", "strokeAlign"
  ];
  const valueFields = [
    "constraints", "fontName", "lineHeight", "fills", "strokes", "effects", "sliceChildren", "metadata"
  ];
  for (const record of records) {
    const current = capturePsdMutationRollback(record.node);
    for (const field of numericFields) {
      if (record[field] !== null && !psdNumberMatches(current[field], record[field])) {
        errors.push(`${record.node.id}:rollback-${field}`);
      }
    }
    for (const field of exactFields) {
      if (current[field] !== record[field]) errors.push(`${record.node.id}:rollback-${field}`);
    }
    for (const field of valueFields) {
      if (stablePsdSourceStateJson(current[field]) !== stablePsdSourceStateJson(record[field])) {
        errors.push(`${record.node.id}:rollback-${field}`);
      }
    }
  }
  return errors;
}

function capturePsdLayerMetadata(node) {
  const keys = [
    "rawPsdLayerName", "normalizedLayerName", "semanticMode", "normalizationWarnings",
    "psdLayerIndex", "psdLayerId", "psdOriginalName", "psdContentHash", "psdOwnership",
    "psdSourceState", "psdSourceStateHash"
  ];
  const values = {};
  for (const key of keys) values[key] = readSharedPluginData(node, key);
  return values;
}

function capturePsdRootMetadata(node) {
  const keys = [
    "importKind", "schemaVersion", "source", "psdSchemaVersion", "psdImportSchemaVersion",
    "psdSourceFileName", "psdSourceKey", "psdLayerSetFingerprint", "psdCanvasWidth", "psdCanvasHeight"
  ];
  const values = {};
  for (const key of keys) values[key] = readSharedPluginData(node, key);
  return values;
}

async function rollbackPsdIncrementalMutation(records, transaction, prepared) {
  const errors = [];
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    try {
      restorePsdMutationRollback(record);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    if (transaction.createdStagingFrame && transaction.stagingFrame && !transaction.stagingFrame.removed) {
      transaction.stagingFrame.remove();
    } else if (transaction.stagingFrame && !transaction.stagingFrame.removed) {
      for (const child of transaction.stagingFrame.children.slice().reverse()) {
        if (!transaction.existingChildIds.has(child.id)) child.remove();
      }
    } else {
      for (let index = transaction.createdNodes.length - 1; index >= 0; index -= 1) {
        const node = transaction.createdNodes[index];
        if (node && !node.removed) node.remove();
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    writePluginData(prepared.target, prepared.rootMetadataBefore);
    if (stablePsdSourceStateJson(capturePsdRootMetadata(prepared.target))
      !== stablePsdSourceStateJson(prepared.rootMetadataBefore)) {
      errors.push("rollback-root-metadata");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

// 规范化 manifest_summary 数据，兼容不同摘要脚本输出格式。
function normalizeManifest(rawManifest) {
  if (!rawManifest || typeof rawManifest !== "object") {
    throw new Error("任务缺少 manifest 数据。");
  }
  const canvas = rawManifest.canvas || {};
  const layers = Array.isArray(rawManifest.layers)
    ? rawManifest.layers
    : []
      .concat(rawManifest.imageLayers || [])
      .concat(rawManifest.textLayers || [])
      .concat(rawManifest.commonLayers || [])
      .concat(rawManifest.nineSliceLayers || []);

  return {
    canvas: {
      width: positiveOr(canvas.width, 100),
      height: positiveOr(canvas.height, 100)
    },
    layers: layers.map(normalizeLayer)
  };
}

// 规范化单个图层，统一 x/y/w/h、opacity、语义字段和资源 id。
function normalizeLayer(layer) {
  const widthSource = firstDefined(layer.w, layer.width);
  const heightSource = firstDefined(layer.h, layer.height);
  const width = positiveOr(widthSource, 1);
  const height = positiveOr(heightSource, 1);
  const opacityRaw = numericOr(layer.opacity, 255);
  const rawAssetId = firstDefined(layer.assetId, firstDefined(layer.idx, firstDefined(layer.index, "")));
  const normalized = cloneObject(layer);
  const mode = String(layer.mode || layer.semanticMode || "image");
  Object.assign(normalized, {
    idx: numericOr(firstDefined(layer.idx, layer.index), 0),
    name: String(layer.name || `Layer_${firstDefined(layer.idx, firstDefined(layer.index, 0))}`),
    mode,
    x: numericOr(layer.x, 0),
    y: numericOr(layer.y, 0),
    w: width,
    h: height,
    opacity: opacityRaw > 1 ? opacityRaw / 255 : opacityRaw,
    visible: layer.visible !== false,
    assetId: String(rawAssetId),
    constraints: layer.constraints || {},
    rawPsdLayerName: String(layer.rawPsdLayerName || layer.name || ""),
    normalizedLayerName: String(layer.normalizedLayerName || layer.name || ""),
    semanticMode: String(layer.semanticMode || layer.mode || "image"),
    layerId: normalizePsdLayerId(layer.layerId),
    contentHash: String(layer.contentHash || ""),
    normalizationWarnings: Array.isArray(layer.normalizationWarnings) ? layer.normalizationWarnings : []
  });
  applyNestedManifestCompatibility(normalized, layer, mode, width, height);
  normalized.sourceState = normalizePsdSourceState({ ...normalized, sourceState: layer.sourceState });
  normalized.sourceStateHash = hashPsdSourceState(normalized.sourceState);
  return normalized;
}

// 兼容导出端把九宫和文字数据放在嵌套对象中的 manifest，统一提升为 Relay 创建节点时读取的顶层字段。
function applyNestedManifestCompatibility(normalized, layer, mode, width, height) {
  if (mode === "nine-slice") {
    const nineSlice = layer.nineSlice && typeof layer.nineSlice === "object" ? layer.nineSlice : {};
    normalized.slices = Array.isArray(layer.slices) ? layer.slices : (Array.isArray(nineSlice.slices) ? nineSlice.slices : []);
    normalized.border = layer.border && typeof layer.border === "object" ? layer.border : (nineSlice.border || {});
    normalized.sliceType = String(firstDefined(layer.sliceType, firstDefined(nineSlice.sliceType, "")));
    normalized.inferredBorder = !!firstDefined(layer.inferredBorder, nineSlice.inferredBorder);
    normalized.inferMethod = String(firstDefined(layer.inferMethod, firstDefined(nineSlice.inferMethod, "")));
    normalized.confidence = String(firstDefined(layer.confidence, firstDefined(nineSlice.confidence, "")));
    normalized.sourceImageWidth = positiveOr(firstDefined(layer.sourceImageWidth, layer.sourceImageW), width);
    normalized.sourceImageHeight = positiveOr(firstDefined(layer.sourceImageHeight, layer.sourceImageH), height);
  }

  if (mode === "text") {
    const text = layer.text && typeof layer.text === "object" ? layer.text : {};
    const effects = text.effects && typeof text.effects === "object" ? text.effects : {};
    normalized.chars = String(firstDefined(layer.chars, firstDefined(text.characters, "")));
    normalized.fontSize = positiveOr(firstDefined(layer.fontSize, text.fontSize), Math.max(12, height));
    normalized.originalFontSize = positiveOr(firstDefined(layer.originalFontSize, firstDefined(text.originalFontSize, text.fontSize)), normalized.fontSize);
    normalized.effectiveFontSize = positiveOr(firstDefined(layer.effectiveFontSize, text.effectiveFontSize), normalized.fontSize);
    normalized.effectiveSizeSource = String(firstDefined(layer.effectiveSizeSource, text.effectiveSizeSource || ""));
    normalized.textTransform = layer.textTransform || text.textTransform || null;
    normalized.leading = firstDefined(layer.leading, text.leading);
    normalized.fillColor = layer.fillColor || text.fillColor || {};
    normalized.textAlign = firstDefined(layer.textAlign, text.textAlignHorizontal);
    normalized.fontFallback = Array.isArray(layer.fontFallback)
      ? layer.fontFallback
      : extractTextFontFallback(text);
    normalized.stroke = normalizeTextStroke(firstDefined(layer.stroke, effects.stroke));
  }
}

// 从文字元数据中提取 Figma 候选字体，避免嵌套 manifest 导入时退回空字体列表。
function extractTextFontFallback(text) {
  const figmaInfo = text.figma && typeof text.figma === "object" ? text.figma : {};
  if (Array.isArray(figmaInfo.fontFallbackCandidates)) {
    return figmaInfo.fontFallbackCandidates;
  }
  return Array.isArray(text.fontFallback) ? text.fontFallback : [];
}

// 兼容嵌套 text.effects.stroke 结构，统一成 createTextLayer 使用的 stroke 字段。
function normalizeTextStroke(value) {
  if (!value || typeof value !== "object") {
    return { enabled: false, size: 0 };
  }
  const color = value.color && typeof value.color === "object" ? value.color : value;
  return {
    enabled: value.enabled === true,
    size: numericOr(value.size, 0),
    r: numericOr(firstDefined(value.r, color.r), 0),
    g: numericOr(firstDefined(value.g, color.g), 0),
    b: numericOr(firstDefined(value.b, color.b), 0),
    hex: String(firstDefined(value.hex, firstDefined(color.hex, "")))
  };
}

// 将 UI 线程传入的资源字节转换为 assetId -> Uint8Array 映射。
function buildAssetBytesMap(assets) {
  const map = new Map();
  for (const asset of assets || []) {
    map.set(String(asset.id), toUint8Array(asset.bytes));
  }
  return map;
}

// 创建本次导入根 Frame，并放到目标容器或当前页面。
async function createRootFrame(job, manifest) {
  const root = figma.createFrame();
  root.name = String(job.name || DefaultRootName);
  root.resize(manifest.canvas.width, manifest.canvas.height);
  root.x = numericOr(job.x, 0);
  root.y = numericOr(job.y, 0);
  root.fills = [];
  root.strokes = [];
  root.clipsContent = false;
  writePsdRootMetadata(root, job, manifest);

  const parent = await resolveTargetParent(job.target);
  parent.appendChild(root);
  return root;
}

function writePsdRootMetadata(root, job, manifest) {
  writePluginData(root, {
    importKind: "psd-layer-to-figma",
    schemaVersion: "3",
    source: String(job.source || ""),
    psdSchemaVersion: "3",
    psdImportSchemaVersion: "3",
    psdSourceFileName: normalizedPsdSourceFileName(job),
    psdSourceKey: buildPsdSourceKey(job, manifest),
    psdLayerSetFingerprint: hashPsdLayerIds(manifest.layers),
    psdCanvasWidth: String(manifest.canvas.width),
    psdCanvasHeight: String(manifest.canvas.height)
  });
}

function buildPsdSourceKey(job, manifest) {
  return `${normalizedPsdSourceFileName(job)}:${manifest.canvas.width}x${manifest.canvas.height}:${hashPsdLayerIds(manifest.layers)}`;
}

function normalizedPsdSourceFileName(job) {
  return String(job && (job.sourceFileName || job.name) || "")
    .split(/[\\/]/)
    .pop()
    .trim()
    .toLowerCase();
}

function hashPsdLayerIds(layers) {
  const text = (layers || [])
    .map((layer) => normalizePsdLayerId(layer.layerId))
    .filter(Boolean)
    .sort()
    .join(",");
  return hashPsdString(text);
}

function hashPsdString(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// 解析目标父节点；目标不是容器时回退到当前页面。
async function resolveTargetParent(target) {
  const nodeId = target && target.nodeId ? String(target.nodeId) : "";
  if (!nodeId) {
    return figma.currentPage;
  }

  const node = await figma.getNodeByIdAsync(nodeId).catch(() => null);
  if (!node) {
    return figma.currentPage;
  }
  if (node.type === "PAGE") {
    await figma.setCurrentPageAsync(node);
    return node;
  }
  if ("appendChild" in node) {
    return node;
  }
  return node.parent && "appendChild" in node.parent ? node.parent : figma.currentPage;
}

// 根据图层模式创建对应 Figma 节点，common 失败时自动降级为图片层。
async function createLayerNode(root, layer, context) {
  if (layer.mode === "common-component") {
    const instance = await tryCreateCommonInstance(root, layer, context);
    if (instance) {
      return instance;
    }
    context.stats.commonFallbackImage += 1;
    context.commonReports.push({
      idx: layer.idx,
      name: layer.name,
      status: "fallback-image",
      candidates: buildCommonCandidateNames(layer),
      reason: "组件库未命中，已降级为图片"
    });
    context.warnings.push(`${layer.idx}:${layer.name}: common 组件未命中，已降级为图片。`);
  }

  if (layer.mode === "text") {
    return await createTextLayer(root, layer, context);
  }

  if (layer.mode === "nine-slice") {
    return await createSliceLayer(root, layer, context);
  }

  return await createImageLayer(root, layer, context);
}

// 尝试按 manifest 离线匹配结果或 Relay 内组件索引创建通用组件实例。
async function tryCreateCommonInstance(root, layer, context) {
  const match = resolveCommonMatch(layer, context);
  if (!match || !match.componentId) {
    return null;
  }

  const component = await figma.getNodeByIdAsync(String(match.componentId)).catch(() => null);
  if (!component || (component.type !== "COMPONENT" && component.type !== "COMPONENT_SET")) {
    context.warnings.push(`${layer.idx}:${layer.name}: 匹配组件 ${match.componentId} 不存在。`);
    return null;
  }

  const instance = component.type === "COMPONENT_SET" && component.defaultVariant
    ? component.defaultVariant.createInstance()
    : component.createInstance();
  root.appendChild(instance);
  if (shouldUsePsdLayerSizeForCommonInstance(match, component, layer)) {
    applyLayerGeometry(instance, layer);
  } else {
    applyInstanceGeometry(instance, layer);
  }
  applyLayerCommonState(instance, layer);
  writeLayerMetadata(instance, layer, {
    matchedComponentName: String(match.matchedComponentName || component.name),
    matchStrategy: String(match.matchStrategy || ""),
    matchConfidence: String(firstDefined(match.matchConfidence, ""))
  });
  context.commonReports.push({
    idx: layer.idx,
    name: layer.name,
    status: "instance",
    matchedComponentId: component.id,
    matchedComponentName: component.name,
    matchStrategy: String(match.matchStrategy || ""),
    matchConfidence: Number(firstDefined(match.matchConfidence, 0))
  });
  context.stats.commonInstance += 1;
  return instance;
}

// 创建普通图片层，使用 figma.createImage 生成 imageHash 后直接设置填充。
async function createImageLayer(root, layer, context) {
  const rect = figma.createRectangle();
  rect.name = buildImageLayerName(layer);
  root.appendChild(rect);
  applyLayerGeometry(rect, layer);
  applyLayerCommonState(rect, layer);
  rect.fills = [await createImagePaint(layer, context, "FILL", null)];
  writeLayerMetadata(rect, layer, {});
  context.stats.image += 1;
  return rect;
}

// 创建可编辑文字层，颜色和描边严格来自 manifest 数据。
async function createTextLayer(root, layer, context) {
  const text = figma.createText();
  text.name = buildTextLayerName(layer);
  root.appendChild(text);

  const fontName = await loadBestFont(layer, context);
  text.fontName = fontName;
  text.characters = String(layer.chars || "");
  const resolvedFontSize = positiveOr(layer.effectiveFontSize, positiveOr(layer.fontSize, Math.max(12, layer.h)));
  text.fontSize = resolvedFontSize;
  const sourceText = layer.sourceState && layer.sourceState.text || {};
  text.lineHeight = sourceText.lineHeightMode === "PIXELS" && Number(sourceText.leading) > 0
    ? { unit: "PIXELS", value: Number(sourceText.leading) }
    : { unit: "AUTO" };
  text.textAutoResize = "WIDTH_AND_HEIGHT";
  text.textAlignHorizontal = normalizeTextAlign(layer.textAlign, layer, context.manifest.canvas);
  text.textAlignVertical = "CENTER";
  text.fills = [solidPaintFromManifest(layer.fillColor, 1)];
  if (layer.stroke && layer.stroke.enabled === true) {
    text.strokes = [solidPaintFromManifest({
      r: layer.stroke.r,
      g: layer.stroke.g,
      b: layer.stroke.b
    }, 1)];
    text.strokeWeight = numericOr(layer.stroke.size, 1);
    text.strokeAlign = "OUTSIDE";
  } else {
    text.strokes = [];
  }
  applyPsdTextShadow(text, sourceText.dropShadow);

  centerNodeOnLayer(text, layer);
  const sourceGeometry = layer.sourceState && layer.sourceState.geometry || {};
  if (Number.isFinite(sourceGeometry.rotation)) text.rotation = sourceGeometry.rotation;
  if ("constraints" in text && layer.constraints) {
    text.constraints = {
      horizontal: normalizeConstraint(layer.constraints.horizontal, "MIN"),
      vertical: normalizeConstraint(layer.constraints.vertical, "MIN")
    };
  }
  // 首次导入后冻结当前几何；后续增量只改 characters，不让自动尺寸扰动整理后的布局。
  text.textAutoResize = "NONE";
  applyLayerCommonState(text, layer);
  writeLayerMetadata(text, layer, {
    fontFamily: fontName.family,
    fontStyle: fontName.style,
    fillHex: String(layer.fillColor && layer.fillColor.hex || ""),
    originalFontSize: String(layer.originalFontSize || layer.fontSize || ""),
    effectiveFontSize: String(resolvedFontSize),
    effectiveSizeSource: String(layer.effectiveSizeSource || "")
  });
  context.textReports.push({
    idx: layer.idx,
    name: layer.name,
    characters: String(layer.chars || ""),
    fontSize: resolvedFontSize,
    originalFontSize: numericOr(layer.originalFontSize, numericOr(layer.fontSize, 0)),
    effectiveSizeSource: String(layer.effectiveSizeSource || ""),
    fillHex: String(layer.fillColor && layer.fillColor.hex || ""),
    strokeEnabled: !!(layer.stroke && layer.stroke.enabled === true),
    strokeSize: layer.stroke && layer.stroke.enabled === true ? numericOr(layer.stroke.size, 0) : 0,
    fontFamily: fontName.family,
    fontStyle: fontName.style
  });
  context.stats.text += 1;
  return text;
}

// 创建九宫、横向三切片或纵向三切片父层，按 slices 数据动态生成子切片。
async function createSliceLayer(root, layer, context) {
  const frame = figma.createFrame();
  frame.name = buildSliceLayerName(layer);
  root.appendChild(frame);
  applyLayerGeometry(frame, layer);
  applyLayerCommonState(frame, layer);
  const imageHash = await getImageHash(layer, context);
  frame.fills = [createImagePaintFromHash(imageHash, "FILL", null, 0)];
  frame.strokes = [];
  frame.clipsContent = false;
  writeLayerMetadata(frame, layer, {
    border: JSON.stringify(layer.border || {}),
    sliceCount: String((layer.slices || []).length),
    sourceImageFillIndex: "0",
    nodeRole: "nineSliceParent"
  });

  const slices = Array.isArray(layer.slices) ? layer.slices : [];
  for (const slice of slices) {
    const sliceNode = figma.createRectangle();
    sliceNode.name = String(slice.name || "__slice");
    frame.appendChild(sliceNode);
    const target = normalizeRectArray(slice.target);
    sliceNode.x = target[0];
    sliceNode.y = target[1];
    sliceNode.resize(positiveOr(target[2], 1), positiveOr(target[3], 1));
    sliceNode.fills = [createImagePaintFromHash(imageHash, "CROP", buildCropTransform(slice, layer), 1)];
    sliceNode.strokes = [];
    sliceNode.constraints = inferSliceConstraints(sliceNode, frame);
    writePluginData(sliceNode, {
      sourceRect: JSON.stringify(normalizeRectArray(slice.source)),
      parentLayerIndex: String(layer.idx),
      psdParentLayerId: normalizePsdLayerId(layer.layerId),
      psdSliceRole: "slice"
    });
    context.stats.slice += 1;
  }

  context.sliceReports.push({
    idx: layer.idx,
    name: layer.name,
    childCount: slices.length,
    sliceKind: inferSliceKindFromSlices(slices),
    border: layer.border || {},
    inferredBorder: !!layer.inferredBorder,
    inferMethod: String(layer.inferMethod || ""),
    confidence: String(layer.confidence || "")
  });
  context.stats.nineSlice += 1;
  return frame;
}

// 根据源切片数据计算 Figma CROP imageTransform，禁止取倒数。
function buildCropTransform(slice, layer) {
  const source = normalizeRectArray(slice.source);
  const imageWidth = positiveOr(layer.sourceImageWidth || layer.w, layer.w);
  const imageHeight = positiveOr(layer.sourceImageHeight || layer.h, layer.h);
  const transform = [
    [source[2] / imageWidth, 0, source[0] / imageWidth],
    [0, source[3] / imageHeight, source[1] / imageHeight]
  ];
  assertTransformInRange(transform, `${layer.idx}:${layer.name}:${slice.name}`);
  return transform;
}

// 获取或创建图层图片 hash，同一 assetId 在本次导入内复用。
async function getImageHash(layer, context) {
  const assetId = String(layer.assetId || layer.idx);
  if (context.imageHashes.has(assetId)) {
    return context.imageHashes.get(assetId);
  }

  const bytes = context.assetBytes.get(assetId);
  if (!bytes || bytes.length === 0) {
    throw new Error(`缺少图片资源 assetId=${assetId}`);
  }
  const image = figma.createImage(bytes);
  context.imageHashes.set(assetId, image.hash);
  return image.hash;
}

// 创建 IMAGE paint，支持普通 FILL 和 CROP 切片。
async function createImagePaint(layer, context, scaleMode, imageTransform) {
  return createImagePaintFromHash(await getImageHash(layer, context), scaleMode, imageTransform);
}

// 根据已创建的 imageHash 创建 IMAGE paint，九宫父节点和子切片共用同一张源图。
function createImagePaintFromHash(imageHash, scaleMode, imageTransform, opacity) {
  const paint = {
    type: "IMAGE",
    imageHash,
    scaleMode,
    opacity: typeof opacity === "number" ? opacity : 1
  };
  if (scaleMode === "CROP" && imageTransform) {
    paint.imageTransform = imageTransform;
  }
  return paint;
}

// 缓存本机可用字体列表和替换结果，避免重复调用 listAvailableFontsAsync。
let _availableFontsCache = null;
const _fontSubstituteCache = new Map();

// 获取本机可用字体列表（单次调用后缓存）。
async function getAvailableFonts() {
  if (_availableFontsCache) return _availableFontsCache;
  try {
    _availableFontsCache = await figma.listAvailableFontsAsync();
  } catch (e) {
    _availableFontsCache = [];
  }
  return _availableFontsCache;
}

// 在可用字体列表中模糊匹配最接近的目标字体。
function findBestFontMatch(targetFamily, targetStyle, availableFonts) {
  if (!availableFonts.length) return null;

  // 精确匹配
  const exact = availableFonts.find(function (f) {
    return f.fontName.family === targetFamily && f.fontName.style === targetStyle;
  });
  if (exact) return exact.fontName;

  // family 精确匹配 + 任意 style
  var familyMatches = availableFonts.filter(function (f) {
    return f.fontName.family === targetFamily;
  });
  if (familyMatches.length > 0) {
    var styleMatch = familyMatches.find(function (f) { return f.fontName.style === targetStyle; });
    return styleMatch ? styleMatch.fontName : familyMatches[0].fontName;
  }

  // family 包含关系匹配（忽略大小写）
  var a = targetFamily.toLowerCase();
  var similar = availableFonts.filter(function (f) {
    var b = f.fontName.family.toLowerCase();
    return a.includes(b) || b.includes(a);
  });
  if (similar.length > 0) {
    var s = similar.find(function (f) { return f.fontName.style === targetStyle; });
    return s ? s.fontName : similar[0].fontName;
  }

  return null;
}

// 加载文字字体：PSD 候选字体 → 本机模糊匹配 → Inter 保底。
async function loadBestFont(layer, context) {
  const candidates = normalizeFontCandidates(layer.fontFallback);
  const availableFonts = await getAvailableFonts();

  for (const fontName of candidates) {
    var cacheKey = fontName.family + "|" + fontName.style;
    if (_fontSubstituteCache.has(cacheKey)) {
      var cached = _fontSubstituteCache.get(cacheKey);
      if (cached) return cached;
      continue; // 之前已判定不可用，跳过
    }

    try {
      await figma.loadFontAsync(fontName);
      _fontSubstituteCache.set(cacheKey, fontName);
      return fontName;
    } catch (error) {
      // PSD 字体不可用，尝试本机模糊匹配
      var match = findBestFontMatch(fontName.family, fontName.style, availableFonts);
      if (match) {
        try {
          await figma.loadFontAsync(match);
          _fontSubstituteCache.set(cacheKey, match);
          context.warnings.push(
            layer.idx + ":" + layer.name + ": 字体 " + fontName.family + " " + fontName.style +
            " 不可用，已自动替换为 " + match.family + " " + match.style
          );
          return match;
        } catch (e2) {}
      }
      _fontSubstituteCache.set(cacheKey, null);
      context.warnings.push(
        layer.idx + ":" + layer.name + ": 字体 " + fontName.family + " " + fontName.style + " 加载失败。"
      );
    }
  }

  // 最终保底：Inter
  var fallbacks = [
    { family: "Inter", style: "Bold" },
    { family: "Inter", style: "Regular" }
  ];
  for (var i = 0; i < fallbacks.length; i++) {
    try {
      await figma.loadFontAsync(fallbacks[i]);
      return fallbacks[i];
    } catch (e) {}
  }
  throw new Error("无法加载任何可用字体。");
}

// 规范化字体候选，兼容字符串或 {family, style} 格式。
function normalizeFontCandidates(value) {
  const result = [];
  const list = Array.isArray(value) ? value : [];
  for (const item of list) {
    if (typeof item === "string" && item.trim()) {
      result.push({ family: item.trim(), style: "Regular" });
    } else if (item && typeof item === "object" && item.family) {
      result.push({
        family: String(item.family),
        style: String(item.style || "Regular")
      });
    }
  }
  return result;
}

// 应用图层位置、尺寸和约束。
function applyLayerGeometry(node, layer) {
  node.x = numericOr(layer.x, 0);
  node.y = numericOr(layer.y, 0);
  if ("resize" in node) {
    node.resize(positiveOr(layer.w, 1), positiveOr(layer.h, 1));
  }
  if ("constraints" in node && layer.constraints) {
    node.constraints = {
      horizontal: normalizeConstraint(layer.constraints.horizontal, "MIN"),
      vertical: normalizeConstraint(layer.constraints.vertical, "MIN")
    };
  }
  const sourceGeometry = layer.sourceState && layer.sourceState.geometry || {};
  if ("rotation" in node && Number.isFinite(sourceGeometry.rotation)) {
    node.rotation = sourceGeometry.rotation;
  }
}

// 应用 common 组件 Instance 几何属性：保留模板原生尺寸，居中于 PSD 图层位置。
function applyInstanceGeometry(instance, layer) {
  var cx = numericOr(layer.x, 0) + positiveOr(layer.w, 1) / 2;
  var cy = numericOr(layer.y, 0) + positiveOr(layer.h, 1) / 2;
  instance.x = Math.round(cx - instance.width / 2);
  instance.y = Math.round(cy - instance.height / 2);
  if ("constraints" in instance && layer.constraints) {
    instance.constraints = {
      horizontal: normalizeConstraint(layer.constraints.horizontal, "MIN"),
      vertical: normalizeConstraint(layer.constraints.vertical, "MIN")
    };
  }
}

// 判断 common 实例尺寸策略：Common_Texture 保持 PSD 图层尺寸，Common_Prefab 保持模板原生尺寸，
// 但 Common_Prefab Btn 按钮组件例外，使用 PSD 图层尺寸。
function shouldUsePsdLayerSizeForCommonInstance(match, component, layer) {
  const names = [
    match && match.matchedComponentName,
    component && component.name,
    layer && layer.name,
    layer && layer.rawPsdLayerName,
    layer && layer.normalizedLayerName
  ].map((value) => String(value || ""));
  if (names.some(isCommonTextureName)) {
    return true;
  }
  if (names.some(isCommonPrefabBtnName)) {
    return true;
  }
  if (names.some(isCommonPrefabName)) {
    return false;
  }
  const matchStrategy = String(match && match.matchStrategy || "");
  return matchStrategy.includes("image-library");
}

// 判断名称是否属于通用纹理组件，纹理组件必须按 PSD 图层尺寸缩放。
function isCommonTextureName(value) {
  return normalizeNameForMatch(value).startsWith("commontexture");
}

// 判断名称是否属于通用预制体组件，预制体组件必须保留模板原生尺寸。
function isCommonPrefabName(value) {
  return normalizeNameForMatch(value).startsWith("commonprefab");
}

// 判断名称是否属于通用预制体按钮组件，按钮组件按 PSD 图层尺寸缩放。
function isCommonPrefabBtnName(value) {
  const normalized = normalizeNameForMatch(value);
  return normalized.startsWith("commonprefab") && normalized.includes("btn");
}

// 应用图层显隐和透明度。
function applyLayerCommonState(node, layer) {
  const display = layer.sourceState && layer.sourceState.display || {};
  node.visible = display.visible !== undefined ? display.visible !== false : layer.visible !== false;
  node.opacity = clamp01(display.opacity !== undefined ? display.opacity : layer.opacity);
  if ("blendMode" in node && display.blendMode) node.blendMode = display.blendMode;
}

// 把 Text 按原始 PSD 图层中心点回摆，避免自动尺寸改变后跑位。
function centerNodeOnLayer(node, layer) {
  const centerX = numericOr(layer.x, 0) + positiveOr(layer.w, 1) / 2;
  const centerY = numericOr(layer.y, 0) + positiveOr(layer.h, 1) / 2;
  node.x = centerX - node.width / 2;
  node.y = centerY - node.height / 2;
}

// 写入 PSD 图层元数据，供后续 Unity 导入或排查问题。
function writeLayerMetadata(node, layer, extra) {
  const sourceState = normalizePsdSourceState(layer);
  const metadata = {
    rawPsdLayerName: layer.rawPsdLayerName,
    normalizedLayerName: layer.normalizedLayerName,
    semanticMode: layer.semanticMode,
    normalizationWarnings: JSON.stringify(layer.normalizationWarnings || []),
    psdLayerIndex: String(layer.idx),
    psdLayerId: normalizePsdLayerId(layer.layerId),
    psdOriginalName: String(layer.rawPsdLayerName || layer.name || ""),
    psdContentHash: String(layer.contentHash || ""),
    psdOwnership: psdOwnershipForMode(layer.mode),
    psdSourceState: stablePsdSourceStateJson(sourceState),
    psdSourceStateHash: hashPsdSourceState(sourceState)
  };
  Object.assign(metadata, extra || {});
  writePluginData(node, metadata);
}

// 使用 SharedPluginData 写元数据，避免依赖普通 pluginData 的插件清单隔离。
function writePluginData(node, values) {
  if (!node || typeof node.setSharedPluginData !== "function") {
    return;
  }
  for (const [key, value] of Object.entries(values || {})) {
    node.setSharedPluginData(McpMetadataNamespace, key, String(firstDefined(value, "")));
  }
}

// 按 PSD index 重新 append 直接子节点，避免九宫或大背景遮挡前景。
async function ensurePsdIndexOrder(root, orderedLayers, context) {
  for (const layer of orderedLayers) {
    const nodeId = context.nodeByLayerIdx.get(String(layer.idx));
    if (!nodeId) {
      continue;
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (node && node.parent === root) {
      root.appendChild(node);
    }
  }
}

// 导入后做关键门禁校验，结果会回传给 Relay。
async function validateImportedRoot(root, orderedLayers, context) {
  const validation = {
    directChildCount: root.children.length,
    expectedLayerCount: orderedLayers.length,
    missingNodeCount: 0,
    emptyImageFillCount: 0,
    badTransformCount: 0,
    textClipRiskCount: 0,
    emptyTextCount: 0,
    textColorMismatchCount: 0,
    textStrokeMismatchCount: 0,
    sliceProblemCount: 0,
    emptySliceLayerCount: 0,
    missingSliceSourceFillCount: 0,
    indexOrderBad: 0,
    positionMismatchCount: 0,
    sizeMismatchCount: 0,
    positionMismatches: [],
    sizeMismatches: [],
    screenshotExported: false
  };

  validation.indexOrderBad = countIndexOrderProblems(root);

  for (const layer of orderedLayers) {
    const nodeId = context.nodeByLayerIdx.get(String(layer.idx));
    if (!nodeId) {
      validation.missingNodeCount += 1;
      continue;
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      validation.missingNodeCount += 1;
      continue;
    }
    validation.emptyImageFillCount += countEmptyImageFills(node);
    validation.badTransformCount += countBadTransforms(node);
    if (node.type !== "TEXT") {
      validateLayerGeometry(layer, node, validation);
    }
    if (node.type === "TEXT") {
      if (!String(node.characters || "").length || !String(layer.chars || "").length) {
        validation.emptyTextCount += 1;
      }
      if (node.textAutoResize !== "WIDTH_AND_HEIGHT" || !node.lineHeight || node.lineHeight.unit !== "AUTO") {
        validation.textClipRiskCount += 1;
      }
      const textResult = validateTextAgainstLayer(node, layer);
      validation.textColorMismatchCount += textResult.fillMismatch ? 1 : 0;
      validation.textStrokeMismatchCount += textResult.strokeMismatch ? 1 : 0;
    }
    if (layer.mode === "nine-slice") {
      const expectedSliceCount = Array.isArray(layer.slices) ? layer.slices.length : 0;
      const actualSliceCount = node.type === "FRAME" && "children" in node
        ? node.children.filter((child) => String(child.name).startsWith("__slice_")).length
        : 0;
      if (expectedSliceCount <= 0 || actualSliceCount <= 0) {
        validation.emptySliceLayerCount += 1;
      }
      if (node.type === "FRAME") {
        validation.sliceProblemCount += validateSliceFrame(node);
        validation.missingSliceSourceFillCount += hasNineSliceSourceFill(node) ? 0 : 1;
      } else {
        validation.sliceProblemCount += 1;
        validation.missingSliceSourceFillCount += 1;
      }
    }
  }
  return validation;
}

// 构建最终状态，任何门禁失败都返回 completed_with_errors。
function buildFinalStatus(context, validation) {
  if (context.errors.length > 0) {
    return "completed_with_errors";
  }
  if (!validation || validation.screenshotExported !== true) {
    return "completed_with_errors";
  }
  const gateFields = ["missingNodeCount", "emptyImageFillCount", "badTransformCount", "textClipRiskCount", "emptyTextCount", "textColorMismatchCount", "textStrokeMismatchCount", "sliceProblemCount", "emptySliceLayerCount", "missingSliceSourceFillCount", "indexOrderBad", "positionMismatchCount", "sizeMismatchCount"];
  for (const field of gateFields) {
    if (numericOr(validation[field], 0) > 0) {
      return "completed_with_errors";
    }
  }
  return "completed";
}

function buildLayerMismatchRecord(layer, node, kind, values) {
  return {
    kind: kind,
    layerIndex: numericOr(layer && layer.idx, 0),
    layerName: String(layer && layer.name || ""),
    rawPsdLayerName: String(layer && layer.rawPsdLayerName || ""),
    nodeId: node && node.id ? node.id : "",
    nodeName: node && node.name ? node.name : "",
    nodeType: node && node.type ? node.type : "",
    expected: values.expected,
    actual: values.actual,
    delta: values.delta
  };
}

function validateLayerGeometry(layer, node, validation) {
  if (shouldValidateCommonPrefabByCenter(layer, node)) {
    const expectedCenter = layerCenter(layer);
    const actualCenter = nodeCenter(node);
    if (Math.abs(actualCenter.x - expectedCenter.x) > 1.5 || Math.abs(actualCenter.y - expectedCenter.y) > 1.5) {
      validation.positionMismatchCount += 1;
      validation.positionMismatches.push(buildLayerMismatchRecord(layer, node, "center-position", {
        expected: expectedCenter,
        actual: actualCenter,
        delta: { x: roundDelta(actualCenter.x - expectedCenter.x), y: roundDelta(actualCenter.y - expectedCenter.y) }
      }));
    }
    return;
  }

  const expectedX = numericOr(layer.x, 0);
  const expectedY = numericOr(layer.y, 0);
  const actualX = numericOr(node.x, 0);
  const actualY = numericOr(node.y, 0);
  if (Math.abs(actualX - expectedX) > 1.5 || Math.abs(actualY - expectedY) > 1.5) {
    validation.positionMismatchCount += 1;
    validation.positionMismatches.push(buildLayerMismatchRecord(layer, node, "position", {
      expected: { x: expectedX, y: expectedY },
      actual: { x: actualX, y: actualY },
      delta: { x: roundDelta(actualX - expectedX), y: roundDelta(actualY - expectedY) }
    }));
  }
  const expectedWidth = positiveOr(layer.w, 1);
  const expectedHeight = positiveOr(layer.h, 1);
  const actualWidth = positiveOr(node.width, 1);
  const actualHeight = positiveOr(node.height, 1);
  if (Math.abs(actualWidth - expectedWidth) > 1.5 || Math.abs(actualHeight - expectedHeight) > 1.5) {
    validation.sizeMismatchCount += 1;
    validation.sizeMismatches.push(buildLayerMismatchRecord(layer, node, "size", {
      expected: { width: expectedWidth, height: expectedHeight },
      actual: { width: actualWidth, height: actualHeight },
      delta: { width: roundDelta(actualWidth - expectedWidth), height: roundDelta(actualHeight - expectedHeight) }
    }));
  }
}

function shouldValidateCommonPrefabByCenter(layer, node) {
  const names = [
    node && node.name,
    readSharedPluginData(node, "matchedComponentName"),
    layer && layer.name,
    layer && layer.rawPsdLayerName,
    layer && layer.normalizedLayerName
  ].map((value) => String(value || ""));
  return names.some(isCommonPrefabName) && !names.some(isCommonPrefabBtnName) && !names.some(isCommonTextureName);
}

function layerCenter(layer) {
  return {
    x: numericOr(layer && layer.x, 0) + positiveOr(layer && layer.w, 1) / 2,
    y: numericOr(layer && layer.y, 0) + positiveOr(layer && layer.h, 1) / 2
  };
}

function nodeCenter(node) {
  return {
    x: numericOr(node && node.x, 0) + positiveOr(node && node.width, 1) / 2,
    y: numericOr(node && node.y, 0) + positiveOr(node && node.height, 1) / 2
  };
}

function readSharedPluginData(node, key) {
  if (!node || typeof node.getSharedPluginData !== "function") {
    return "";
  }
  try {
    return node.getSharedPluginData(McpMetadataNamespace, key);
  } catch (error) {
    return "";
  }
}

function roundDelta(value) {
  return Math.round(numericOr(value, 0) * 1000) / 1000;
}

// 在 Relay 内扫描通用组件库和通用图片库，避免标准流程依赖官方/通用 Figma MCP。
async function buildComponentIndexes(job) {
  const config = Object.assign({ commonRootId: "62:115", imageRootId: "2896:32" }, job && job.componentLibrary || {});
  return {
    common: await collectComponentIndex(config.commonRootId),
    image: await collectComponentIndex(config.imageRootId)
  };
}

// 收集某个根节点下的 Component/ComponentSet，用标准化名称建立索引。
async function collectComponentIndex(rootId) {
  const list = [];
  if (!rootId) {
    return { list, byName: {}, byNormalized: {} };
  }
  const root = await findNodeAcrossPages(String(rootId));
  if (!root) {
    return { list, byName: {}, byNormalized: {} };
  }
  const nodes = [];
  if (root.type === "COMPONENT" || root.type === "COMPONENT_SET") {
    nodes.push(root);
  }
  if ("findAll" in root) {
    const foundNodes = root.findAll((node) => node.type === "COMPONENT" || node.type === "COMPONENT_SET");
    for (const foundNode of foundNodes) {
      nodes.push(foundNode);
    }
  }
  const byName = {};
  const byNormalized = {};
  for (const node of nodes) {
    const item = {
      id: node.id,
      name: node.name,
      type: node.type,
      width: node.width || 0,
      height: node.height || 0,
      normalized: normalizeNameForMatch(node.name),
      commonImageName: normalizeNameForMatch(stripCommonImagePrefix(node.name))
    };
    list.push(item);
    byName[item.name] = item;
    for (const key of [item.normalized, item.commonImageName]) {
      byNormalized[key] = byNormalized[key] || [];
      byNormalized[key].push(item);
    }
  }
  return { list, byName, byNormalized };
}

// 跨页面查找节点，并在需要时加载页面内容。
async function findNodeAcrossPages(nodeId) {
  const originalPage = figma.currentPage;
  let foundNode = null;
  for (const page of figma.root.children) {
    await figma.setCurrentPageAsync(page);
    const node = await figma.getNodeByIdAsync(nodeId).catch(() => null);
    if (node) {
      foundNode = node;
      break;
    }
  }
  if (originalPage && figma.currentPage !== originalPage) {
    await figma.setCurrentPageAsync(originalPage);
  }
  return foundNode;
}

// 解析 common 匹配：优先 manifest 离线结果，其次 Relay 内组件库索引。
function resolveCommonMatch(layer, context) {
  const offline = layer.match || {};
  const offlineId = offline.matchedComponentId || layer.matchedComponentId;
  if (offlineId) {
    return {
      componentId: String(offlineId),
      matchedComponentName: String(offline.matchedComponentName || ""),
      matchStrategy: String(offline.matchMethod || offline.matchStrategy || "manifest-offline"),
      matchConfidence: firstDefined(offline.matchConfidence, 1)
    };
  }
  const candidates = buildCommonCandidateNames(layer);
  const commonMatch = findBestComponentMatch(candidates, context.componentIndexes.common, layer, 0.88);
  if (commonMatch) {
    return commonMatch;
  }
  const imageMatch = findBestComponentMatch(candidates, context.componentIndexes.image, layer, 1.0);
  if (imageMatch) {
    imageMatch.matchStrategy = "common-image-name-binding";
    imageMatch.matchConfidence = 1;
    return imageMatch;
  }
  return null;
}

// 生成 common 候选名，兼容 common_ / Common_ / __ImportBounds。
function buildCommonCandidateNames(layer) {
  const raw = String(layer.query || layer.name || "");
  const cleanRaw = stripLayerCopyNoiseForMatch(raw);
  const stripped = stripImportBoundsSuffix(stripCommonImagePrefix(cleanRaw).replace(/^common[\s_-]*/i, ""));
  const names = [];
  for (const name of [
    raw,
    cleanRaw,
    stripped,
    `${stripped}__ImportBounds`,
    `${stripped}_1`,
    `Common_${stripped}`,
    `Common_Prefab_${stripped}`,
    `Common_Texture_${stripped}`
  ]) {
    if (name && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

// 在组件索引中做精确/标准化/轻量模糊匹配。
function findBestComponentMatch(candidates, index, layer, fuzzyThreshold) {
  if (!index || !Array.isArray(index.list)) {
    return null;
  }
  for (const candidate of candidates) {
    if (index.byName[candidate]) {
      return componentMatchResult(index.byName[candidate], "exact-name", 1);
    }
  }
  for (const candidate of candidates) {
    const hits = index.byNormalized[normalizeNameForMatch(candidate)] || [];
    if (hits.length === 1) {
      return componentMatchResult(hits[0], "normalized-name", 1);
    }
  }
  let best = null;
  let secondScore = 0;
  for (const item of index.list) {
    for (const candidate of candidates) {
      const score = scoreComponentCandidate(candidate, item, layer);
      if (!best || score > best.score) {
        secondScore = best ? best.score : secondScore;
        best = { item, score };
      } else if (score > secondScore) {
        secondScore = score;
      }
    }
  }
  if (best && best.score >= fuzzyThreshold && best.score - secondScore >= 0.08) {
    return componentMatchResult(best.item, "fuzzy-name-size", best.score);
  }
  return null;
}

// 组件匹配返回对象。
function componentMatchResult(item, strategy, confidence) {
  return { componentId: item.id, matchedComponentName: item.name, matchStrategy: strategy, matchConfidence: confidence };
}

// 轻量评分：名称相似度为主，尺寸相似度为辅。
function scoreComponentCandidate(candidate, item, layer) {
  const a = normalizeNameForMatch(candidate);
  const b = item.normalized;
  if (!a || !b) {
    return 0;
  }
  let nameScore = similarityScore(a, b);
  if (a.includes(b) || b.includes(a)) {
    nameScore = Math.max(nameScore, 0.86);
  }
  return nameScore * 0.82 + scoreSizeSimilarity(layer, item) * 0.18;
}

// 名称相似度，避免引入高成本算法。
function similarityScore(a, b) {
  if (a === b) {
    return 1;
  }
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  if (!longer) {
    return 0;
  }
  let same = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (longer.includes(shorter[i])) {
      same += 1;
    }
  }
  return same / longer.length;
}

// 尺寸相似度。
function scoreSizeSimilarity(layer, item) {
  const lw = positiveOr(layer.w, 1);
  const lh = positiveOr(layer.h, 1);
  const iw = positiveOr(item.width, 1);
  const ih = positiveOr(item.height, 1);
  return Math.max(0, 1 - Math.abs((lw / lh) - (iw / ih)));
}

// 标准化名称用于组件匹配。
function normalizeNameForMatch(value) {
  return stripLayerCopyNoiseForMatch(value).toLowerCase().replace(/__importbounds$/i, "").replace(/\.(png|jpg|jpeg|webp)$/i, "").replace(/[\s_\-\[\]\(\)]/g, "");
}

// 仅清理 PSD/Figma 自动复制产生的噪声，避免删除有业务含义的中文名称。
function stripLayerCopyNoiseForMatch(value) {
  return String(value || "")
    .trim()
    .replace(/^\d+[\s_.-]+/, "")
    .replace(/[\s_-]*(?:copy|副本|拷贝)(?:[\s_-]*\d+)?$/i, "")
    .trim();
}

// 去掉 Common_ / image_ 等可选前缀。
function stripCommonImagePrefix(value) {
  return String(value || "").replace(/^(common|image|img)[\s_-]*/i, "");
}

function stripImportBoundsSuffix(value) {
  return String(value || "").replace(/__ImportBounds$/i, "");
}

// 导出根节点截图，作为 Relay 标准交付证据。
async function exportRootScreenshot(root, context) {
  try {
    const bytes = await promiseWithTimeout(root.exportAsync({ format: "PNG" }), 45000, "root screenshot export timeout");
    return {
      fileName: `${sanitizeFileName(root.name)}_${root.id.replace(":", "_")}.png`,
      mimeType: "image/png",
      width: root.width,
      height: root.height,
      byteLength: bytes.length,
      base64: bytesToBase64(bytes)
    };
  } catch (error) {
    context.warnings.push(`截图导出失败：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// Uint8Array 转 base64，分块避免参数过长。
function promiseWithTimeout(promise, timeoutMs, message) {
  return new Promise(function (resolve, reject) {
    let settled = false;
    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      reject(new Error(message || "operation timeout"));
    }, timeoutMs);
    promise.then(function (value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }).catch(function (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function uint8ToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
  }
  return btoa(binary);
}

// 文件名清理。
function sanitizeFileName(value) {
  return String(value || "figma_export").replace(/[\\/:*?"<>|]/g, "_");
}

// 检查直接子节点 PSD index 是否升序。
function countIndexOrderProblems(root) {
  let bad = 0;
  let prev = -Infinity;
  for (const child of root.children) {
    const idx = numericOr(child.getSharedPluginData(McpMetadataNamespace, "psdLayerIndex"), parseIndexFromName(child.name));
    if (idx < prev) {
      bad += 1;
    }
    prev = idx;
  }
  return bad;
}

// 从名称前缀解析 index。
function parseIndexFromName(name) {
  const match = String(name || "").match(/^(\d+)/);
  return match ? Number(match[1]) : 0;
}

// Text 创建后与 manifest 的颜色、描边做全量对比。
function validateTextAgainstLayer(node, layer) {
  const result = { fillMismatch: false, strokeMismatch: false };
  const fill = Array.isArray(node.fills) && node.fills[0] && node.fills[0].type === "SOLID" ? node.fills[0] : null;
  const expectedFill = layer.fillColor || {};
  if (!fill || !closeNumber(fill.color.r, expectedFill.r) || !closeNumber(fill.color.g, expectedFill.g) || !closeNumber(fill.color.b, expectedFill.b)) {
    result.fillMismatch = true;
  }
  const strokes = Array.isArray(node.strokes) ? node.strokes : [];
  if (layer.stroke && layer.stroke.enabled === true) {
    const stroke = strokes[0] && strokes[0].type === "SOLID" ? strokes[0] : null;
    if (!stroke || !closeNumber(stroke.color.r, layer.stroke.r) || !closeNumber(stroke.color.g, layer.stroke.g) || !closeNumber(stroke.color.b, layer.stroke.b) || !closeNumber(node.strokeWeight, layer.stroke.size)) {
      result.strokeMismatch = true;
    }
  } else if (strokes.length > 0) {
    result.strokeMismatch = true;
  }
  return result;
}

// 判断数值近似相等。
function closeNumber(a, b) {
  return Math.abs(Number(a || 0) - Number(b || 0)) <= 0.002;
}

// 判断是否有切片子节点。
function hasSliceChildren(node) {
  return "children" in node && node.children.some((child) => String(child.name).startsWith("__slice_"));
}

// 校验 h3/v3/9-slice 子切片结构。
function validateSliceFrame(frame) {
  const children = frame.children.filter((child) => String(child.name).startsWith("__slice_"));
  if (children.length === 9) {
    return children.every(hasValidCropTransform) ? 0 : 1;
  }
  if (children.length === 3) {
    const h3 = children.every((child) => Math.abs(child.y) <= 0.01 && Math.abs(child.height - frame.height) <= 0.01);
    const v3 = children.every((child) => Math.abs(child.x) <= 0.01 && Math.abs(child.width - frame.width) <= 0.01);
    if (h3) {
      return children.every(hasValidH3SliceTransform) ? 0 : 1;
    }
    if (v3) {
      return children.every(hasValidV3SliceTransform) ? 0 : 1;
    }
    return 1;
  }
  return 1;
}

// 校验普通九宫切片 CROP transform 是否存在且未越界。
function hasValidCropTransform(node) {
  const transform = getFirstCropTransform(node);
  return !!transform && isTransformInRange(transform);
}

// 校验横向三切片只切 X，保留完整高度。
function hasValidH3SliceTransform(node) {
  const transform = getFirstCropTransform(node);
  return !!transform &&
    isTransformInRange(transform) &&
    closeNumber(transform[1] && transform[1][0], 0) &&
    closeNumber(transform[1] && transform[1][1], 1) &&
    closeNumber(transform[1] && transform[1][2], 0);
}

// 校验纵向三切片只切 Y，保留完整宽度。
function hasValidV3SliceTransform(node) {
  const transform = getFirstCropTransform(node);
  return !!transform &&
    isTransformInRange(transform) &&
    closeNumber(transform[0] && transform[0][0], 1) &&
    closeNumber(transform[0] && transform[0][1], 0) &&
    closeNumber(transform[0] && transform[0][2], 0);
}

// 读取节点首个 CROP 图片填充矩阵。
function getFirstCropTransform(node) {
  const fills = Array.isArray(node && node.fills) ? node.fills : [];
  for (const fill of fills) {
    if (fill && fill.type === "IMAGE" && fill.scaleMode === "CROP" && fill.imageTransform) {
      return fill.imageTransform;
    }
  }
  return null;
}

// 校验九宫父节点是否保留隐藏源图 fill，供后续 Unity 导出链路直接回溯原图。
function hasNineSliceSourceFill(frame) {
  if (!frame || !Array.isArray(frame.fills)) {
    return false;
  }
  return frame.fills.some((fill) => fill && fill.type === "IMAGE" && !!fill.imageHash);
}

function hasExpectedNineSliceImageHash(frame, expectedImageHash) {
  if (!frame || !expectedImageHash || !Array.isArray(frame.fills) || !("children" in frame)) {
    return false;
  }
  const sourcePaints = frame.fills.filter((paint) => paint && paint.type === "IMAGE");
  if (sourcePaints.length !== 1 || sourcePaints[0].imageHash !== expectedImageHash) {
    return false;
  }
  const slices = frame.children.filter((child) => String(child.name).startsWith("__slice_"));
  return slices.length > 0 && slices.every((slice) => {
    const imagePaints = Array.isArray(slice.fills)
      ? slice.fills.filter((paint) => paint && paint.type === "IMAGE")
      : [];
    return imagePaints.length === 1 && imagePaints[0].imageHash === expectedImageHash;
  });
}

// 根据 slices 数量推断报告用切片类型。
function inferSliceKindFromSlices(slices) {
  if (!Array.isArray(slices)) {
    return "unknown";
  }
  if (slices.length === 9) {
    return "9-slice";
  }
  if (slices.length === 3) {
    return slices.every((slice) => normalizeRectArray(slice.target)[1] === 0) ? "h3-slice" : "v3-slice";
  }
  return `slice-${slices.length}`;
}

// 基于当前单选图片节点推断九宫边框，遇到不适合九宫的小图时只报错不创建。
async function suggestNineSliceFromCurrentSelection() {
  const source = getSingleSelectedImageNodeForNineSlice();
  const suggestion = inferManualNineSliceBorderForSuggestion(source);
  const bounds = suggestion.bounds;
  const border = normalizeManualNineSliceBorder(suggestion.border, bounds.width, bounds.height);
  const sliceKind = decideManualNineSliceKind(bounds.width, bounds.height, border);
  if (sliceKind === "image") {
    throw new Error("当前图片尺寸较小且接近正方形，不适合切九宫。");
  }
  const effectiveBorder = buildEffectiveNineSliceBorder(border, sliceKind);
  let imageBase64 = "";
  try {
    const width = positiveOr(bounds.width, positiveOr(source.width, 1));
    const height = positiveOr(bounds.height, positiveOr(source.height, 1));
    const scale = Math.min(200 / width, 200 / height, 1);
    const bytes = await source.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: scale },
      contentsOnly: true
    });
    imageBase64 = bytesToBase64(bytes);
  } catch (error) {
    imageBase64 = "";
  }
  return {
    status: "completed",
    nodeId: source.id,
    nodeName: source.name,
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
    border: effectiveBorder,
    sliceKind,
    inferMethod: suggestion.inferMethod,
    imageBase64
  };
}

// 自动识别九宫边框：优先复用已有切片和 PSD/Relay 元数据，最后才按尺寸比例兜底。
function inferManualNineSliceBorderForSuggestion(source) {
  const existing = readExistingSliceBorderFromNode(source);
  if (existing) {
    return existing;
  }

  const wrapper = findManualNineSliceWrapperForHiddenSource(source);
  const wrapperExisting = readExistingSliceBorderFromNode(wrapper);
  if (wrapperExisting) {
    return wrapperExisting;
  }

  const shared = readSharedSpriteBorder(source);
  if (shared) {
    return {
      border: shared,
      bounds: getNodeBounds(source),
      inferMethod: "shared-sprite-border"
    };
  }

  const wrapperShared = readSharedSpriteBorder(wrapper);
  if (wrapperShared) {
    return {
      border: wrapperShared,
      bounds: getNodeBounds(wrapper),
      inferMethod: "wrapper-shared-sprite-border"
    };
  }

  const bounds = getNodeBounds(source);
  return {
    border: inferNineSliceBorderFromSize(bounds.width, bounds.height),
    bounds,
    inferMethod: "size-ratio-fallback"
  };
}

// 从已有 __slice_* 子节点反推 Unity spriteBorder，避免覆盖已有九宫时退回 25% 推断。
function readExistingSliceBorderFromNode(node) {
  const info = buildFigmaPrefabNineSliceInfo(node);
  if (!info || !info.border) {
    return null;
  }
  const bounds = getNodeBounds(node);
  const adjusted = adjustManualExistingNineSliceBorder(info.border, bounds, info.sliceKind);
  return {
    border: adjusted.border,
    bounds,
    inferMethod: adjusted.changed
      ? `existing-slices-${info.sliceCount}-large-round-safe`
      : `existing-slices-${info.sliceCount}`
  };
}

// 手动九宫复用已有切片时，拦截大图上异常小的 9-slice border。
// 这只影响“建议值”，不覆盖用户手动输入的明确 border。
function adjustManualExistingNineSliceBorder(border, bounds, sliceKind) {
  const current = {
    left: Math.round(numericOr(border && border.left, 0)),
    bottom: Math.round(numericOr(border && border.bottom, 0)),
    right: Math.round(numericOr(border && border.right, 0)),
    top: Math.round(numericOr(border && border.top, 0))
  };
  if (String(sliceKind || "") !== "9slice") {
    return { border: current, changed: false };
  }
  const width = positiveOr(bounds && bounds.width, 0);
  const height = positiveOr(bounds && bounds.height, 0);
  const shortAxis = Math.min(width, height);
  if (width < 256 || height < 256 || shortAxis <= 0) {
    return { border: current, changed: false };
  }

  const tinyLimit = Math.max(12, Math.round(shortAxis * 0.02));
  const hasTinyHorizontal = current.left <= tinyLimit || current.right <= tinyLimit;
  const hasTinyTop = current.top <= tinyLimit && current.top >= current.bottom;
  const hasTinyBottom = current.bottom <= tinyLimit;
  if (!hasTinyHorizontal && !hasTinyTop && !hasTinyBottom) {
    return { border: current, changed: false };
  }

  const safe = Math.max(24, Math.min(96, Math.round(shortAxis * 0.08)));
  const adjusted = {
    left: hasTinyHorizontal ? Math.max(current.left, safe) : current.left,
    bottom: hasTinyBottom ? Math.max(current.bottom, safe) : current.bottom,
    right: hasTinyHorizontal ? Math.max(current.right, safe) : current.right,
    top: hasTinyTop ? Math.max(current.top, safe) : current.top
  };
  if (adjusted.left + adjusted.right >= width) {
    adjusted.left = current.left;
    adjusted.right = current.right;
  }
  if (adjusted.top + adjusted.bottom >= height) {
    adjusted.top = current.top;
    adjusted.bottom = current.bottom;
  }
  return {
    border: adjusted,
    changed: adjusted.left !== current.left
      || adjusted.right !== current.right
      || adjusted.top !== current.top
      || adjusted.bottom !== current.bottom
  };
}

// 读取 PSD/Relay 写入的 Unity spriteBorder 元数据，格式为 left,bottom,right,top。
function readSharedSpriteBorder(node) {
  if (!node || typeof node.getSharedPluginData !== "function") {
    return null;
  }
  const raw = node.getSharedPluginData(McpMetadataNamespace, "spriteBorder");
  const border = parseSpriteBorderString(raw);
  if (border) {
    return border;
  }
  const rawJson = node.getSharedPluginData(McpMetadataNamespace, "border");
  return parseSpriteBorderJson(rawJson);
}

// 解析 Unity spriteBorder 字符串：left,bottom,right,top。
function parseSpriteBorderString(raw) {
  if (!raw) {
    return null;
  }
  const parts = String(raw).split(",").map((part) => Number(String(part).trim()));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value) || value < 0)) {
    return null;
  }
  return {
    left: parts[0],
    bottom: parts[1],
    right: parts[2],
    top: parts[3]
  };
}

// 兼容旧数据里 JSON 形式保存的 border。
function parseSpriteBorderJson(raw) {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(String(raw));
    if (!value || typeof value !== "object") {
      return null;
    }
    const border = {
      left: Number(value.left),
      bottom: Number(value.bottom),
      right: Number(value.right),
      top: Number(value.top)
    };
    return Object.keys(border).every((key) => Number.isFinite(border[key]) && border[key] >= 0)
      ? border
      : null;
  } catch (error) {
    return null;
  }
}

// 从当前单选图片节点原地生成九宫或三切片；叶子图层会先转换为同名 Frame。
async function createNineSliceFromCurrentSelection(job) {
  const selectedSource = getSingleSelectedImageNodeForNineSlice();
  const sourceHash = findFirstImageHash(selectedSource, true);
  const selectedBounds = getNodeBounds(selectedSource);
  const existingWrapper = findManualNineSliceWrapperForHiddenSource(selectedSource);
  const bounds = existingWrapper ? getNodeBounds(existingWrapper) : selectedBounds;
  const border = normalizeManualNineSliceBorder(job && job.border, bounds.width, bounds.height);
  const sliceKind = decideManualNineSliceKind(bounds.width, bounds.height, border);
  if (sliceKind === "image") {
    throw new Error("当前图片尺寸较小且接近正方形，不适合切九宫。");
  }
  const effectiveBorder = buildEffectiveNineSliceBorder(border, sliceKind);

  const wrapResult = ensureManualNineSliceContainer(selectedSource, sourceHash, bounds, existingWrapper);
  const source = wrapResult.container;
  const sourceWasVisible = source.visible !== false;
  const originalFills = "fills" in source && Array.isArray(source.fills) ? source.fills.slice() : [];
  const removedOldNineSliceCount = removeDirectSliceChildren(source);
  const slices = buildManualNineSlicePlan(bounds.width, bounds.height, effectiveBorder, sliceKind);
  source.fills = [createImagePaintFromHash(sourceHash, "FILL", null, 0)];
  source.clipsContent = false;
  source.visible = sourceWasVisible;

  writePluginData(source, {
    importKind: "manual-nine-slice",
    nodeRole: "nineSliceParent",
    sourceNodeId: source.id,
    sourceNodeName: source.name || "",
    originalSourceNodeId: wrapResult.originalSourceId || source.id,
    originalSourceNodeName: wrapResult.originalSourceName || source.name || "",
    sourceImageFillIndex: "0",
    sliceKind,
    sliceCount: String(slices.length),
    generatedInSourceNode: "true",
    wrappedSourceNode: wrapResult.wrapped ? "true" : "false",
    border: JSON.stringify(effectiveBorder),
    spriteBorder: [effectiveBorder.left, effectiveBorder.bottom, effectiveBorder.right, effectiveBorder.top].join(",")
  });

  for (const slice of slices) {
    const sliceNode = figma.createRectangle();
    sliceNode.name = slice.name;
    source.appendChild(sliceNode);
    const target = normalizeRectArray(slice.target);
    sliceNode.x = target[0];
    sliceNode.y = target[1];
    sliceNode.resize(positiveOr(target[2], 1), positiveOr(target[3], 1));
    sliceNode.fills = [createImagePaintFromHash(sourceHash, "CROP", buildCropTransform(slice, {
      idx: 0,
      name: source.name || "manual-nine-slice",
      w: bounds.width,
      h: bounds.height,
      sourceImageWidth: bounds.width,
      sourceImageHeight: bounds.height
    }), 1)];
    sliceNode.strokes = [];
    sliceNode.constraints = inferSliceConstraints(sliceNode, source);
    writePluginData(sliceNode, {
      nodeRole: "slice",
      sourceRect: JSON.stringify(normalizeRectArray(slice.source)),
      parentSourceNodeId: source.id
    });
  }

  const sliceProblems = validateSliceFrame(source);
  const badTransformCount = countBadTransforms(source);
  if (sliceProblems > 0 || badTransformCount > 0 || !hasNineSliceSourceFill(source)) {
    removeDirectSliceChildren(source);
    source.fills = originalFills;
    throw new Error(`九宫生成校验失败：sliceProblem=${sliceProblems}, badTransform=${badTransformCount}`);
  }

  figma.currentPage.selection = [source];
  figma.viewport.scrollAndZoomIntoView([source]);
  return {
    status: "completed",
    sourceNodeId: source.id,
    createdNodeId: source.id,
    createdNodeName: source.name,
    summary: {
      sliceKind,
      sliceCount: slices.length,
      border: effectiveBorder,
      sourceNodeName: source.name || "",
      sourceNodeId: source.id,
      sourcePreserved: true,
      generatedInSourceNode: true,
      wrappedSourceNode: wrapResult.wrapped,
      oldNineSliceRemovedCount: removedOldNineSliceCount,
      sourceNodeVisible: source.visible !== false,
      validation: {
        sliceProblemCount: sliceProblems,
        badTransformCount,
        missingSliceSourceFillCount: hasNineSliceSourceFill(source) ? 0 : 1
      }
    },
    warnings: [],
    errors: []
  };
}

// 根据最终切片类型输出实际生效的 Unity spriteBorder，三切片会清零未使用轴。
function buildEffectiveNineSliceBorder(border, sliceKind) {
  const value = {
    left: Math.round(numericOr(border && border.left, 0)),
    bottom: Math.round(numericOr(border && border.bottom, 0)),
    right: Math.round(numericOr(border && border.right, 0)),
    top: Math.round(numericOr(border && border.top, 0))
  };
  if (sliceKind === "h3-slice") {
    value.bottom = 0;
    value.top = 0;
  } else if (sliceKind === "v3-slice") {
    value.left = 0;
    value.right = 0;
  }
  return value;
}

// 校验当前选择必须且只能是一个带 IMAGE fill 的节点。
function getSingleSelectedImageNodeForNineSlice() {
  const selection = figma.currentPage.selection || [];
  if (selection.length === 0) {
    throw new Error("请先在 Figma 画布中选择 1 个图片节点。");
  }
  if (selection.length > 1) {
    throw new Error(`只能选择 1 个图片节点，当前选择了 ${selection.length} 个。`);
  }
  const node = selection[0];
  if (!node || node.type === "PAGE" || node.type === "DOCUMENT") {
    throw new Error("当前选择不是可切九宫的图片节点。");
  }
  const bounds = getNodeBounds(node);
  if (positiveOr(bounds.width, 0) <= 1 || positiveOr(bounds.height, 0) <= 1) {
    throw new Error("当前选择尺寸过小，无法切九宫。");
  }
  if (!findFirstImageHash(node, true)) {
    throw new Error("当前选择没有可读取的 IMAGE fill，无法切九宫。");
  }
  return node;
}

// 自动推断默认 border，按 25% 推断并限制在半轴内。
function inferNineSliceBorderFromSize(width, height) {
  const w = positiveOr(width, 1);
  const h = positiveOr(height, 1);
  return {
    left: Math.max(1, Math.floor(Math.min(w * 0.25, (w - 1) / 2))),
    bottom: Math.max(1, Math.floor(Math.min(h * 0.25, (h - 1) / 2))),
    right: Math.max(1, Math.floor(Math.min(w * 0.25, (w - 1) / 2))),
    top: Math.max(1, Math.floor(Math.min(h * 0.25, (h - 1) / 2)))
  };
}

// 校验用户输入的 Unity spriteBorder：left,bottom,right,top。
function normalizeManualNineSliceBorder(value, width, height) {
  const raw = value && typeof value === "object" ? value : {};
  const border = {
    left: numericOr(raw.left, NaN),
    bottom: numericOr(raw.bottom, NaN),
    right: numericOr(raw.right, NaN),
    top: numericOr(raw.top, NaN)
  };
  for (const key of ["left", "bottom", "right", "top"]) {
    if (!Number.isFinite(border[key]) || border[key] < 0) {
      throw new Error(`九宫边框 ${key} 必须是非负数字。`);
    }
    border[key] = Math.round(border[key]);
  }
  const w = positiveOr(width, 1);
  const h = positiveOr(height, 1);
  if (border.left + border.right >= w) {
    throw new Error(`九宫左右边框之和必须小于图片宽度：left+right=${border.left + border.right}, width=${Math.round(w)}`);
  }
  if (border.top + border.bottom >= h) {
    throw new Error(`九宫上下边框之和必须小于图片高度：top+bottom=${border.top + border.bottom}, height=${Math.round(h)}`);
  }
  return border;
}

// 按 PSD 导入规则判断切片类型；小图直接阻止，避免盲目九宫。
function decideManualNineSliceKind(width, height, border) {
  const w = positiveOr(width, 1);
  const h = positiveOr(height, 1);
  const ratio = w / h;
  if (w < 100 && h < 100 && ratio >= 0.5 && ratio <= 2) {
    return "image";
  }
  // 基于 border 值判断三切片类型：支持手动输入 left/right 为 0（v3）或 top/bottom 为 0（h3）
  if (border) {
    const hasH = border.left > 0 && border.right > 0;
    const hasV = border.top > 0 && border.bottom > 0;
    if (hasH && !hasV) return "h3-slice";
    if (!hasH && hasV) return "v3-slice";
    if (hasH && hasV) return "9-slice";
  }
  if (ratio > 3 || (h < 80 && w > h * 3)) {
    return "h3-slice";
  }
  if (ratio < 1 / 3 || (w < 80 && h > w * 3)) {
    return "v3-slice";
  }
  if (!border || border.left <= 0 || border.right <= 0 || border.top <= 0 || border.bottom <= 0) {
    throw new Error("标准九宫需要 left、bottom、right、top 都大于 0。");
  }
  return "9-slice";
}

// 生成 PSD/Relay 兼容的 slices 数据：source 和 target 都使用 [x,y,w,h]。
function buildManualNineSlicePlan(width, height, border, sliceKind) {
  const w = Math.round(positiveOr(width, 1));
  const h = Math.round(positiveOr(height, 1));
  const left = Math.round(border.left);
  const right = Math.round(border.right);
  const top = Math.round(border.top);
  const bottom = Math.round(border.bottom);
  const centerW = Math.max(1, w - left - right);
  const centerH = Math.max(1, h - top - bottom);

  if (sliceKind === "h3-slice") {
    if (left <= 0 || right <= 0) {
      throw new Error("横向三切片需要 left 和 right 大于 0。");
    }
    return [
      { name: "__slice_left", source: [0, 0, left, h], target: [0, 0, left, h] },
      { name: "__slice_center", source: [left, 0, centerW, h], target: [left, 0, centerW, h] },
      { name: "__slice_right", source: [w - right, 0, right, h], target: [w - right, 0, right, h] }
    ];
  }

  if (sliceKind === "v3-slice") {
    if (top <= 0 || bottom <= 0) {
      throw new Error("纵向三切片需要 top 和 bottom 大于 0。");
    }
    return [
      { name: "__slice_top", source: [0, 0, w, top], target: [0, 0, w, top] },
      { name: "__slice_center", source: [0, top, w, centerH], target: [0, top, w, centerH] },
      { name: "__slice_bottom", source: [0, h - bottom, w, bottom], target: [0, h - bottom, w, bottom] }
    ];
  }

  return [
    { name: "__slice_top_left", source: [0, 0, left, top], target: [0, 0, left, top] },
    { name: "__slice_top", source: [left, 0, centerW, top], target: [left, 0, centerW, top] },
    { name: "__slice_top_right", source: [w - right, 0, right, top], target: [w - right, 0, right, top] },
    { name: "__slice_left", source: [0, top, left, centerH], target: [0, top, left, centerH] },
    { name: "__slice_center", source: [left, top, centerW, centerH], target: [left, top, centerW, centerH] },
    { name: "__slice_right", source: [w - right, top, right, centerH], target: [w - right, top, right, centerH] },
    { name: "__slice_bottom_left", source: [0, h - bottom, left, bottom], target: [0, h - bottom, left, bottom] },
    { name: "__slice_bottom", source: [left, h - bottom, centerW, bottom], target: [left, h - bottom, centerW, bottom] },
    { name: "__slice_bottom_right", source: [w - right, h - bottom, right, bottom], target: [w - right, h - bottom, right, bottom] }
  ];
}

// 确保手动九宫有可容纳切片的父节点；叶子图层会原地包装成同名 Frame。
function ensureManualNineSliceContainer(source, sourceHash, bounds, existingWrapper) {
  if (existingWrapper) {
    return {
      container: existingWrapper,
      bounds: getNodeBounds(existingWrapper),
      wrapped: false,
      originalSourceId: source.id,
      originalSourceName: source.name || ""
    };
  }

  if ("children" in source && typeof source.appendChild === "function") {
    return {
      container: source,
      bounds: getNodeBounds(source),
      wrapped: false,
      originalSourceId: source.id,
      originalSourceName: source.name || ""
    };
  }

  const currentWrapper = findManualNineSliceWrapperForHiddenSource(source);
  if (currentWrapper) {
    return {
      container: currentWrapper,
      bounds: getNodeBounds(currentWrapper),
      wrapped: false,
      originalSourceId: source.id,
      originalSourceName: source.name || ""
    };
  }

  const parent = source.parent && "children" in source.parent && typeof source.parent.insertChild === "function"
    ? source.parent
    : null;
  if (!parent) {
    throw new Error("当前图片节点没有可写入的父级，无法原地转换为九宫容器。");
  }

  const index = Math.max(0, parent.children.indexOf(source));
  const wrapper = figma.createFrame();
  wrapper.name = source.name || "NineSlice";
  parent.insertChild(index, wrapper);
  wrapper.x = numericOr(source.x, numericOr(bounds.x, 0));
  wrapper.y = numericOr(source.y, numericOr(bounds.y, 0));
  wrapper.resize(Math.max(1, Math.round(bounds.width)), Math.max(1, Math.round(bounds.height)));
  wrapper.fills = [createImagePaintFromHash(sourceHash, "FILL", null, 0)];
  wrapper.strokes = [];
  wrapper.clipsContent = false;
  wrapper.visible = source.visible !== false;
  wrapper.opacity = typeof source.opacity === "number" ? source.opacity : 1;
  if ("constraints" in wrapper && "constraints" in source) {
    wrapper.constraints = cloneObject(source.constraints);
  }

  wrapper.appendChild(source);
  source.x = 0;
  source.y = 0;
  if ("resize" in source) {
    source.resize(Math.max(1, Math.round(bounds.width)), Math.max(1, Math.round(bounds.height)));
  }
  source.visible = false;
  writePluginData(source, {
    nodeRole: "hiddenOriginalSource",
    wrappedByManualNineSlice: "true",
    wrapperNodeId: wrapper.id
  });

  return {
    container: wrapper,
    bounds: getNodeBounds(wrapper),
    wrapped: true,
    originalSourceId: source.id,
    originalSourceName: source.name || ""
  };
}

// 如果用户误选了已隐藏的原始叶子图层，复用它的九宫父 Frame，避免重复包一层。
function findManualNineSliceWrapperForHiddenSource(source) {
  if (!source || typeof source.getSharedPluginData !== "function") {
    return null;
  }
  if (source.getSharedPluginData(McpMetadataNamespace, "wrappedByManualNineSlice") !== "true") {
    return null;
  }
  const parent = source.parent && "children" in source.parent && typeof source.parent.appendChild === "function"
    ? source.parent
    : null;
  if (!parent) {
    return null;
  }
  const originalSourceNodeId = typeof parent.getSharedPluginData === "function"
    ? parent.getSharedPluginData(McpMetadataNamespace, "originalSourceNodeId")
    : "";
  if (originalSourceNodeId && originalSourceNodeId !== source.id) {
    return null;
  }
  return parent;
}

// 清理原节点下已有的九宫切片，避免重复生成堆叠。
function removeDirectSliceChildren(source) {
  if (!source || !("children" in source)) {
    return 0;
  }
  const sliceChildren = source.children.filter((child) => String(child && child.name || "").startsWith("__slice_"));
  for (const child of sliceChildren) {
    child.remove();
  }
  return sliceChildren.length;
}

// 统计空 IMAGE fill，避免“节点存在但缺图”。
function countEmptyImageFills(node) {
  let count = hasEmptyImageFill(node) ? 1 : 0;
  if ("children" in node) {
    for (const child of node.children) {
      count += countEmptyImageFills(child);
    }
  }
  return count;
}

// 判断节点是否存在空图片填充。
function hasEmptyImageFill(node) {
  if (!("fills" in node) || !Array.isArray(node.fills)) {
    return false;
  }
  return node.fills.some((fill) => fill && fill.type === "IMAGE" && !fill.imageHash);
}

// 统计 CROP 矩阵越界数量。
function countBadTransforms(node) {
  let count = 0;
  if ("fills" in node && Array.isArray(node.fills)) {
    for (const fill of node.fills) {
      if (fill && fill.type === "IMAGE" && fill.scaleMode === "CROP" && fill.imageTransform) {
        if (!isTransformInRange(fill.imageTransform)) {
          count += 1;
        }
      }
    }
  }
  if ("children" in node) {
    for (const child of node.children) {
      count += countBadTransforms(child);
    }
  }
  return count;
}

// 统计节点自身及所有子节点数量。
function countDescendants(node) {
  let count = 1;
  if ("children" in node) {
    for (const child of node.children) {
      count += countDescendants(child);
    }
  }
  return count;
}

// 从 manifest 颜色创建 SOLID paint，颜色值直接使用 0 到 1 通道。
function solidPaintFromManifest(color, opacity) {
  return {
    type: "SOLID",
    color: {
      r: clamp01(color && color.r),
      g: clamp01(color && color.g),
      b: clamp01(color && color.b)
    },
    opacity: clamp01(opacity)
  };
}

// 根据位置推断文本对齐，优先保护视觉居中。
function normalizeTextAlign(value, layer, canvas) {
  const centerX = numericOr(layer.x, 0) + positiveOr(layer.w, 1) / 2;
  const canvasWidth = positiveOr(canvas.width, 1);
  if (centerX >= canvasWidth * 0.4 && centerX <= canvasWidth * 0.6) {
    return "CENTER";
  }
  const text = String(value || "").toUpperCase();
  if (text.includes("RIGHT")) {
    return "RIGHT";
  }
  if (text.includes("CENTER")) {
    return "CENTER";
  }
  return "LEFT";
}

// 根据切片位置设置约束，边缘固定，中间拉伸。
function inferSliceConstraints(sliceNode, parent) {
  const horizontal = sliceNode.x <= 0
    ? "MIN"
    : sliceNode.x + sliceNode.width >= parent.width - 0.01
      ? "MAX"
      : "STRETCH";
  const vertical = sliceNode.y <= 0
    ? "MIN"
    : sliceNode.y + sliceNode.height >= parent.height - 0.01
      ? "MAX"
      : "STRETCH";
  return { horizontal, vertical };
}

// 标准化切片 rect 数组。
function normalizeRectArray(value) {
  const array = Array.isArray(value) ? value : [0, 0, 1, 1];
  return [
    numericOr(array[0], 0),
    numericOr(array[1], 0),
    positiveOr(array[2], 1),
    positiveOr(array[3], 1)
  ];
}

// 检查 CROP 矩阵必须处于 0 到 1，发现错误立即阻止交付。
function assertTransformInRange(transform, label) {
  if (!isTransformInRange(transform)) {
    throw new Error(`切片 imageTransform 越界：${label}`);
  }
}

// 判断 CROP 矩阵所有值是否处于 0 到 1。
function isTransformInRange(transform) {
  for (const row of transform || []) {
    for (const value of row || []) {
      const number = Number(value);
      if (!Number.isFinite(number) || number < -0.0001 || number > 1.0001) {
        return false;
      }
    }
  }
  return true;
}

// 构建图片节点名称，保留 PSD index 方便排查。
function buildImageLayerName(layer) {
  return `${padIndex(layer.idx)}_${resolvePsdDisplayLayerName(layer, "Layer")}`;
}

// 构建文字节点名称，优先使用 PSD 图层名；弱名称时用文字内容兜底。
function buildTextLayerName(layer) {
  return `${padIndex(layer.idx)}_${resolvePsdDisplayLayerName(layer, "Text")}__text`;
}

// 构建切片父节点名称。
function buildSliceLayerName(layer) {
  return `${padIndex(layer.idx)}_${resolvePsdDisplayLayerName(layer, "Slice")}__slice`;
}

// 选择适合显示在 Figma 层级里的 PSD 图层名，避免纯数字、空名和下划线污染层级。
function resolvePsdDisplayLayerName(layer, fallbackKind) {
  const candidates = [
    layer && layer.normalizedLayerName,
    layer && layer.rawPsdLayerName,
    layer && layer.name
  ];
  for (const candidate of candidates) {
    const cleaned = sanitizeFigmaLayerDisplayName(candidate);
    if (!isWeakPsdDisplayName(cleaned)) {
      return cleaned;
    }
  }

  const chars = sanitizeFigmaLayerDisplayName(layer && layer.chars);
  if (fallbackKind === "Text" && chars) {
    return trimFigmaLayerDisplayName(`Text_${chars}`);
  }
  return String(fallbackKind || "Layer");
}

function sanitizeFigmaLayerDisplayName(value) {
  return trimFigmaLayerDisplayName(String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_")
    .replace(/\s+/g, " "));
}

function trimFigmaLayerDisplayName(value) {
  const trimmed = String(value || "").trim().replace(/^_+|_+$/g, "");
  return trimmed.length > 48 ? trimmed.slice(0, 48).trim().replace(/^_+|_+$/g, "") : trimmed;
}

function isWeakPsdDisplayName(value) {
  const text = String(value || "").trim();
  if (!text) return true;
  if (/^[_\-. ]+$/.test(text)) return true;
  if (/^\d+_?$/.test(text)) return true;
  return false;
}

// 将 index 补齐到两位，便于人工检查层级顺序。
function padIndex(index) {
  return String(numericOr(index, 0)).padStart(2, "0");
}

// 约束值白名单化，避免 manifest 中异常字符串导致插件报错。
function normalizeConstraint(value, fallback) {
  const text = String(value || fallback).toUpperCase();
  return ["MIN", "CENTER", "MAX", "STRETCH", "SCALE"].includes(text) ? text : fallback;
}

// 转为 Uint8Array，兼容 ArrayBuffer、数组和 TypedArray。
function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer);
  }
  if (Array.isArray(value)) {
    return new Uint8Array(value);
  }
  return new Uint8Array([]);
}

// 数字转换，非法时返回 fallback。
function numericOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

// 浅拷贝对象，替代 Figma 旧解析器不支持的 object spread。
function cloneObject(value) {
  return Object.assign({}, value || {});
}

// 兼容 Figma 旧 JS 解析器，替代 nullish coalescing。
function firstDefined(value, fallback) {
  return value !== undefined && value !== null ? value : fallback;
}

// 正尺寸转换，非法或非正数时返回 fallback。
function positiveOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

// 把数值限制在 0 到 1。
function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.max(0, Math.min(1, number));
}
// ─────────────────────── Figma 选区图片导出到 Unity ───────────────────────

/**
 * 处理 EXPORT_IMAGES_TO_UNITY 消息。
 * 九宫：父节点 exportAsync + 读 pluginData spriteBorder → UI 发 Relay Python cutter 切图
 * 普通：直接 exportAsync → UI 发 Unity Gateway
 */
async function handleExportImagesToUnity(message) {
  const selection = figma.currentPage.selection || [];
  const diagnostics = [];
  diagnostics.push("导出诊断：selectionCount=" + selection.length);
  for (const node of selection) {
    diagnostics.push("选区节点：" + describeExportNode(node));
  }
  if (selection.length === 0) {
    throw new Error("请先在 Figma 画布中选择节点。");
  }

  const imageNodes = collectExportImageNodes(selection, diagnostics);
  diagnostics.push("收集结果：imageNodeCount=" + imageNodes.length);
  if (imageNodes.length === 0) {
    throw new Error("当前选区中没有可导出的图片节点。\n" + diagnostics.join("\n"));
  }

  const images = [];
  for (const item of imageNodes) {
    // 九宫：读取完整源图 bytes，并附带 border 元数据交给 Relay Python cutter 合成最小 Sprite。
    if (item.nineSlice) {
      // 九宫图必须使用完整源图，不能导出父节点渲染图后再裁剪，否则会把已裁过的切片再次裁成十字形。
      var parentHash = findFirstImageHash(item.node, true);
      var sliceHash = parentHash ? "" : findNineSliceSourceHash(item.node);
      var sourceHash = parentHash || sliceHash;
      diagnostics.push("九宫导出：" + item.path
        + " sourceHash=" + (sourceHash ? "yes" : "no")
        + " source=" + (parentHash ? "parentFill" : (sliceHash ? "sliceFill" : "missing"))
        + " border=" + JSON.stringify(item.nineSlice.border));
      var sourceImage = sourceHash ? figma.getImageByHash(sourceHash) : null;
      if (!sourceImage) {
        throw new Error("九宫图缺少可读取的源 imageHash：" + item.path + "\n" + diagnostics.join("\n"));
      }
      var sourceBytes = await sourceImage.getBytesAsync();
      var spriteBorder = readSpriteBorderFromPlugin(item.node);
      var border = item.nineSlice.border;
      // pluginData 有精确值优先，否则用 buildFigmaPrefabNineSliceInfo 计算值
      var bL = spriteBorder.valid ? spriteBorder.left : border.left;
      var bR = spriteBorder.valid ? spriteBorder.right : border.right;
      var bT = spriteBorder.valid ? spriteBorder.top : border.top;
      var bB = spriteBorder.valid ? spriteBorder.bottom : border.bottom;
      var finalBorder = { left: bL, right: bR, top: bT, bottom: bB };
      images.push({
        nodeId: item.node.id,
        nodeName: item.node.name || "",
        nodePath: item.path,
        fileName: buildUnityImageName(item.node, item.path),
        base64: bytesToBase64(sourceBytes),
        imageType: "Sliced",
        sliceKind: sliceKindFromBorders(finalBorder),
        borderLeft: bL,
        borderRight: bR,
        borderTop: bT,
        borderBottom: bB
      });
      continue;
    }

    // 非九宫：直接导出
    diagnostics.push("普通图片导出：" + item.path + " node=" + describeExportNode(item.node));
    const bytes = await item.node.exportAsync({ format: "PNG" });
    images.push({
      nodeId: item.node.id,
      nodeName: item.node.name || "FigmaImage",
      nodePath: item.path,
      fileName: buildUnityImageName(item.node, item.path),
      base64: bytesToBase64(bytes)
    });
  }

  figma.ui.postMessage({
    type: "EXPORT_IMAGES_TO_UNITY_RESULT",
    requestId: message.requestId,
    result: {
        status: "completed",
        images,
        stats: { selectedCount: selection.length, imageCount: images.length },
        diagnostics,
        errors: [],
        warnings: []
      }
  });
  figma.notify(`已导出 ${images.length} 张图片，等待 Unity 导入。`);
}

/**
 * 从选区中递归收集可导出的图片节点。
 * - 九宫父节点：返回父节点（附 nineSlice 信息）
 * - 普通图节点：导出自带 IMAGE fill 的节点
 */
function collectExportImageNodes(selection, diagnostics) {
  const visited = new Set();
  const result = [];
  for (const root of selection) {
    walkExportImageNodes(root, "", visited, result, diagnostics, 0);
  }
  return result;
}

function walkExportImageNodes(node, parentPath, visited, result, diagnostics, depth) {
  if (!node || !("id" in node) || visited.has(node.id)) return;
  if (node.type === "DOCUMENT" || node.type === "PAGE") return;
  visited.add(node.id);

  const currentPath = parentPath ? `${parentPath}/${node.name}` : node.name;
  if (diagnostics && depth <= 2) {
    diagnostics.push("扫描节点：" + currentPath + " " + describeExportNode(node) + " slices=" + countDirectSliceChildren(node));
  }

  // 检测九宫父节点（有 __slice_* 子节点）
  const nineSlice = buildFigmaPrefabNineSliceInfo(node);
  if (nineSlice) {
    // 收集切片子节点（供 Figma 内裁剪参考）
    var sliceChildren = [];
    if ("children" in node) {
      for (var ci = 0; ci < node.children.length; ci++) {
        var child = node.children[ci];
        if (String(child.name || "").startsWith("__slice_") && "exportAsync" in child && child.width > 0 && child.height > 0) {
          sliceChildren.push(child);
        }
      }
    }
    if (diagnostics) {
      diagnostics.push("识别九宫：" + currentPath
        + " sliceCount=" + nineSlice.sliceCount
        + " directSliceExportable=" + sliceChildren.length
        + " border=" + JSON.stringify(nineSlice.border)
        + " parentImageHash=" + (findFirstImageHash(node, true) ? "yes" : "no")
        + " sliceImageHash=" + (findNineSliceSourceHash(node) ? "yes" : "no"));
    }
    result.push({ node: node, path: currentPath, nineSlice: nineSlice, slices: sliceChildren });
    return;
  }

  // 跳过 __slice_* 内部子节点
  if (String(node.name).startsWith("__slice_")) {
    if (diagnostics) {
      diagnostics.push("跳过切片子节点：" + currentPath);
    }
    return;
  }

  // 普通图片节点
  if (hasImageFill(node) && "exportAsync" in node && node.width > 0 && node.height > 0) {
    if (diagnostics) {
      diagnostics.push("识别普通图片：" + currentPath);
    }
    result.push({ node, path: currentPath, nineSlice: null });
    return;
  }
  if (diagnostics && depth <= 2) {
    diagnostics.push("未直接导出：" + currentPath
      + " hasVisibleImageFill=" + hasImageFill(node)
      + " hasAnyImageFill=" + hasAnyImageFill(node)
      + " exportAsync=" + ("exportAsync" in node)
      + " size=" + Math.round(Number(node.width || 0)) + "x" + Math.round(Number(node.height || 0)));
  }

  // 递归子节点
  if ("children" in node) {
    for (const child of node.children) {
      walkExportImageNodes(child, currentPath, visited, result, diagnostics, depth + 1);
    }
  }
}

/** 判断节点是否有 IMAGE 类型填充。 */
function hasImageFill(node) {
  if (!("fills" in node) || !Array.isArray(node.fills)) return false;
  return node.fills.some(function (f) {
    return f && f.type === "IMAGE" && f.visible !== false;
  });
}

/** 判断节点是否存在任意 IMAGE 填充，包括隐藏填充。 */
function hasAnyImageFill(node) {
  if (!("fills" in node) || !Array.isArray(node.fills)) return false;
  return node.fills.some(function (f) {
    return f && f.type === "IMAGE";
  });
}

/** 统计直接子节点中的九宫切片数量。 */
function countDirectSliceChildren(node) {
  if (!node || !("children" in node) || !Array.isArray(node.children)) return 0;
  var count = 0;
  for (var i = 0; i < node.children.length; i++) {
    if (String(node.children[i] && node.children[i].name || "").startsWith("__slice_")) {
      count += 1;
    }
  }
  return count;
}

/** 输出节点导出相关关键状态。 */
function describeExportNode(node) {
  if (!node) return "<null>";
  return "id=" + (node.id || "")
    + " name=" + (node.name || "")
    + " type=" + (node.type || "")
    + " visible=" + (node.visible !== false)
    + " size=" + Math.round(Number(node.width || 0)) + "x" + Math.round(Number(node.height || 0))
    + " hasVisibleImageFill=" + hasImageFill(node)
    + " hasAnyImageFill=" + hasAnyImageFill(node)
    + " exportAsync=" + ("exportAsync" in node);
}

/**
 * 生成 Unity 友好文件名。
 * 优先用 pluginData 里的原始资源路径名，否则用节点名。
 */
function buildUnityImageName(node, nodePath) {
  var assetPath = "";
  if (typeof node.getPluginData === "function") {
    assetPath = node.getPluginData("spritePath") || node.getPluginData("assetPath") || "";
  }
  if (!assetPath && typeof node.getSharedPluginData === "function") {
    assetPath = node.getSharedPluginData(PrefabToFigmaNamespace, "spritePath")
      || node.getSharedPluginData(PrefabToFigmaNamespace, "assetPath")
      || "";
  }
  var sourceName = assetPath ? assetPath.split("/").pop() : "";
  var baseName = sourceName
    ? sourceName.replace(/\.[a-z0-9]+$/i, "")
    : (node.name || "FigmaImage");
  return sanitizeFileName(baseName) + ".png";
}

function readHierarchyImageAssetInfo(node) {
  var info = {
    spriteGuid: "",
    spritePath: "",
    assetPath: ""
  };
  if (!node) {
    return info;
  }
  if (typeof node.getSharedPluginData === "function") {
    info.spriteGuid = node.getSharedPluginData(PrefabToFigmaNamespace, "spriteGuid")
      || node.getSharedPluginData(PrefabToFigmaNamespace, "imageGuid")
      || "";
    info.spritePath = node.getSharedPluginData(PrefabToFigmaNamespace, "spritePath") || "";
    info.assetPath = node.getSharedPluginData(PrefabToFigmaNamespace, "assetPath") || "";
  }
  if (typeof node.getPluginData === "function") {
    info.spriteGuid = info.spriteGuid
      || node.getPluginData("spriteGuid")
      || node.getPluginData("imageGuid")
      || "";
    info.spritePath = info.spritePath || node.getPluginData("spritePath") || "";
    info.assetPath = info.assetPath || node.getPluginData("assetPath") || "";
  }
  return info;
}

/**
 * 从 Figma 节点的 pluginData 读取 Unity 导出时写入的精确 spriteBorder。
 * 格式: "left,bottom,right,top" (与 Unity TextureImporter.spriteBorder 一致)
 */
function readSpriteBorderFromPlugin(node) {
  if (!node || typeof node.getPluginData !== "function") {
    return { valid: false, left: 0, right: 0, top: 0, bottom: 0 };
  }
  var raw = node.getPluginData("spriteBorder");
  if (!raw) {
    return { valid: false, left: 0, right: 0, top: 0, bottom: 0 };
  }
  var parts = String(raw).split(",");
  if (parts.length !== 4) {
    return { valid: false, left: 0, right: 0, top: 0, bottom: 0 };
  }
  var left = parseInt(parts[0], 10);
  var bottom = parseInt(parts[1], 10);
  var right = parseInt(parts[2], 10);
  var top = parseInt(parts[3], 10);
  if (isNaN(left) || isNaN(bottom) || isNaN(right) || isNaN(top)) {
    return { valid: false, left: 0, right: 0, top: 0, bottom: 0 };
  }
  return { valid: true, left: left, right: right, top: top, bottom: bottom };
}

/** 根据四个边框值判断切片类型。 */
function sliceKindFromBorders(border) {
  if (!border) return "9slice";
  var h = border.left > 0 && border.right > 0;
  var v = border.top > 0 && border.bottom > 0;
  if (h && v) return "9slice";
  if (h) return "h3slice";
  if (v) return "v3slice";
  return "9slice";
}
/**
 * 处理选中文本样式同步到 Unity 的 Figma 侧采集。
 * 只读取一个 TEXT 节点，按 figma-to-prefab 的 TMP 材质规则生成 textMaterial。
 */
async function handleExportSelectedTextStyleToUnity(message) {
  const requestId = message && message.requestId ? String(message.requestId) : "";
  const job = message && message.job ? message.job : {};
  const syncColor = job.syncColor !== false;
  const selection = figma.currentPage.selection || [];
  try {
    if (selection.length !== 1) {
      throw new Error("请在 Figma 中只选择 1 个文本节点，当前选择数量：" + selection.length);
    }

    const node = selection[0];
    if (!node || node.type !== "TEXT") {
      throw new Error("当前节点不是 TEXT 文本节点，不能同步字体样式。");
    }

    const fontSize = readFigmaFontSize(node);
    const fillColor = readFirstVisibleSolidPaintColor(node.fills);
    if (syncColor && !fillColor) {
      throw new Error("当前文本没有可见的 SOLID 填充色，无法同步字体颜色。");
    }

    const strokeColor = readFirstVisibleSolidPaintColor(node.strokes);
    const strokeWeight = readFigmaStrokeWeight(node);
    const effects = serializeEffects(node.effects);
    const style = {
      nodeId: node.id,
      nodeName: node.name || "",
      pageName: figma.currentPage && figma.currentPage.name ? figma.currentPage.name : "",
      fontSize: roundNumber(fontSize),
      fillColor: fillColor || { r: 0, g: 0, b: 0, a: 1 },
      strokeColor,
      strokeWeight,
      effects,
      textMaterial: buildSelectedTextMaterialSpec(strokeColor, strokeWeight, effects, fontSize)
    };

    figma.ui.postMessage({
      type: "EXPORT_SELECTED_TEXT_STYLE_TO_UNITY_RESULT",
      requestId,
      ok: true,
      result: {
        status: "completed",
        style,
        warnings: [],
        errors: []
      }
    });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    figma.ui.postMessage({
      type: "EXPORT_SELECTED_TEXT_STYLE_TO_UNITY_RESULT",
      requestId,
      ok: false,
      error: messageText,
      result: {
        status: "failed",
        errors: [messageText]
      }
    });
    figma.notify("字体同步失败：" + messageText, { error: true });
  }
}

/** 从 Figma paints 中读取第一个可见 SOLID 颜色，保留 alpha。 */
function readFirstVisibleSolidPaintColor(paints) {
  if (!Array.isArray(paints)) {
    return null;
  }
  for (const paint of paints) {
    if (!paint || paint.visible === false || paint.type !== "SOLID" || !paint.color) {
      continue;
    }
    return {
      r: roundDigits(paint.color.r || 0, 3),
      g: roundDigits(paint.color.g || 0, 3),
      b: roundDigits(paint.color.b || 0, 3),
      a: typeof paint.opacity === "number" ? roundDigits(paint.opacity, 3) : 1
    };
  }
  return null;
}

/** 根据 figma-to-prefab 的规则构建 TMP 描边/投影材质需求。 */
function buildSelectedTextMaterialSpec(strokeColor, strokeWeight, effects, fontSize) {
  const safeFontSize = Math.max(Number(fontSize) || 0, 1);
  let outlineColor = strokeColor;
  let outlineWidth = 0;
  const safeStrokeWeight = roundDigits(Number(strokeWeight) || 0, 2);
  if (outlineColor && safeStrokeWeight > 0) {
    outlineWidth = roundDigits(clampNumber(7.0 / 3.0 * safeStrokeWeight / safeFontSize, 0, 1), 2);
  }
  if (outlineWidth <= 0.01) {
    outlineColor = null;
    outlineWidth = 0;
  }

  const shadow = findFirstVisibleDropShadow(effects);
  let underlayColor = null;
  let underlayOffsetX = 0;
  let underlayOffsetY = 0;
  let underlaySoftness = 0;
  let underlayDilate = 0;
  if (shadow) {
    const color = shadow.color || {};
    underlayColor = {
      r: roundDigits(color.r || 0, 3),
      g: roundDigits(color.g || 0, 3),
      b: roundDigits(color.b || 0, 3),
      a: typeof color.a === "number" ? roundDigits(color.a, 3) : 1
    };
    const offset = shadow.offset || {};
    underlayOffsetX = roundDigits(clampNumber((offset.x || 0) / safeFontSize, -1, 1), 2);
    underlayOffsetY = roundDigits(clampNumber(-(offset.y || 0) / safeFontSize, -1, 1), 2);
    underlaySoftness = roundDigits(clampNumber((shadow.radius || 0) / safeFontSize, 0, 1), 2);
    underlayDilate = roundDigits(clampNumber((shadow.spread || 0) / safeFontSize, 0, 1), 2);
    if (underlayColor.a <= 0.01) {
      underlayColor = null;
    }
  }

  const hasOutline = !!outlineColor;
  const hasUnderlay = !!underlayColor;
  if (!hasOutline && !hasUnderlay) {
    return {
      enabled: false,
      signature: "",
      materialName: "",
      outlineColor: { r: 0, g: 0, b: 0, a: 1 },
      outlineWidth: 0,
      underlayColor: { r: 0, g: 0, b: 0, a: 1 },
      underlayOffsetX: 0,
      underlayOffsetY: 0,
      underlaySoftness: 0,
      underlayDilate: 0,
      hasOutline: false,
      hasUnderlay: false,
      sourceStrokeWeight: safeStrokeWeight
    };
  }

  const outlineHex = hasOutline ? colorToMaterialHex(outlineColor) : "none";
  const underlayHex = hasUnderlay ? colorToMaterialHex(underlayColor) : "none";
  const signature = "o_" + outlineHex
    + "_w_" + pad3(Math.round(outlineWidth * 100))
    + "_u_" + underlayHex
    + "_x_" + pad3(Math.round((underlayOffsetX + 1) * 100))
    + "_y_" + pad3(Math.round((underlayOffsetY + 1) * 100))
    + "_s_" + pad3(Math.round(underlaySoftness * 100))
    + "_d_" + pad3(Math.round(underlayDilate * 100));

  return {
    enabled: true,
    signature,
    materialName: "CommonFont_figma_" + signature,
    outlineColor: outlineColor || { r: 0, g: 0, b: 0, a: 1 },
    outlineWidth,
    underlayColor: underlayColor || { r: 0, g: 0, b: 0, a: 1 },
    underlayOffsetX,
    underlayOffsetY,
    underlaySoftness,
    underlayDilate,
    hasOutline,
    hasUnderlay,
    sourceStrokeWeight: safeStrokeWeight
  };
}

/** 获取第一个可见 DropShadow，用于映射 TMP Underlay。 */
function findFirstVisibleDropShadow(effects) {
  if (!Array.isArray(effects)) {
    return null;
  }
  for (const effect of effects) {
    if (effect && effect.visible !== false && effect.type === "DROP_SHADOW") {
      return effect;
    }
  }
  return null;
}

/** 数字限制到指定范围。 */
function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, numeric));
}

/** 按指定位数四舍五入。 */
function roundDigits(value, digits) {
  const factor = Math.pow(10, digits || 0);
  return Math.round((Number(value) || 0) * factor) / factor;
}

/** 颜色转换为材质签名中的 RGBA 十六进制。 */
function colorToMaterialHex(color) {
  const r = Math.round(clampNumber(color && color.r, 0, 1) * 255);
  const g = Math.round(clampNumber(color && color.g, 0, 1) * 255);
  const b = Math.round(clampNumber(color && color.b, 0, 1) * 255);
  const a = Math.round(clampNumber(color && typeof color.a === "number" ? color.a : 1, 0, 1) * 255);
  return toHex2(r) + toHex2(g) + toHex2(b) + toHex2(a);
}

/** 生成两位十六进制文本。 */
function toHex2(value) {
  return ("0" + Math.round(value).toString(16)).slice(-2);
}

/** 生成三位数字签名段。 */
function pad3(value) {
  return ("000" + Math.round(value)).slice(-3);
}
/**
 * 采集当前 Figma 单选根节点的层级和几何数据，交给 Unity 网关做确定性同步。
 * 这里只读 Figma 画布，不做图片、字体、材质资源替换。
 */
async function handleExportHierarchyToUnity(message) {
  try {
    const selection = figma.currentPage.selection || [];
    if (selection.length !== 1) {
      throw new Error("请在 Figma 中只选择 1 个根节点。当前选择数量：" + selection.length);
    }

    const selectedRoot = selection[0];
    const root = resolveHierarchyExportRootNode(selectedRoot);
    if (!root) {
      throw new Error("当前选择的节点不支持Figma导入Prefab：" + ((selectedRoot && selectedRoot.type) || "UNKNOWN"));
    }

    const syncImages = !!(message && message.syncImages);
    const selectedAncestorIds = buildHierarchyAncestorIdSet(selectedRoot, root);
    const selectedNodeId = selectedRoot && selectedRoot.id ? String(selectedRoot.id) : "";
    const selectionTargetsWholeRoot = selectedRoot === root || isHierarchyImportBoundsNode(selectedRoot);
    const geometrySyncSelectionId = selectionTargetsWholeRoot && root && root.id ? String(root.id) : selectedNodeId;
    const hierarchyRoot = await collectHierarchyExportNode(root, "", 0, syncImages, selectedAncestorIds, selectedNodeId, null, false, geometrySyncSelectionId, false);
    hierarchyRoot.geometryChangedFromBaseline = false;
    const rootPrefabPath = getHierarchySharedPluginData(root, "prefabPath") || getHierarchySharedPluginData(selectedRoot, "prefabPath") || "";
    hierarchyRoot.prefabPath = rootPrefabPath;
    const payload = {
      version: 1,
      fileKey: figma.fileKey || "",
      pageId: figma.currentPage && figma.currentPage.id ? figma.currentPage.id : "",
      pageName: figma.currentPage && figma.currentPage.name ? figma.currentPage.name : "",
      prefabPath: rootPrefabPath,
      syncImages,
      root: hierarchyRoot
    };

    figma.ui.postMessage({
      type: "EXPORT_HIERARCHY_TO_UNITY_RESULT",
      requestId: message.requestId,
      ok: true,
      result: payload
    });
    figma.notify("已采集 Figma 层级，等待 Unity 同步。");
  } catch (error) {
    figma.ui.postMessage({
      type: "EXPORT_HIERARCHY_TO_UNITY_RESULT",
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/** 判断节点是否可以参与Figma导入Prefab。 */
function isHierarchyExportNode(node) {
  if (!node || node.type === "PAGE" || node.type === "DOCUMENT") {
    return false;
  }
  if (isHierarchySliceLeafNode(node)) {
    return false;
  }
  if (isHierarchyPrefabVisualLeafNode(node)) {
    return false;
  }
  return "width" in node && "height" in node;
}

/** 将 Prefab导入Figma 生成的 __ImportBounds 外壳解包到真实 Prefab 根节点。 */
function resolveHierarchyExportRootNode(node) {
  const candidate = resolveHierarchyPrefabRootCandidate(node);
  if (!isHierarchyExportRootNode(candidate)) {
    return null;
  }
  if (!isHierarchyImportBoundsNode(candidate)) {
    return candidate;
  }
  const children = candidate.children.filter(isHierarchyExportNode);
  return children.length === 1 && isHierarchyExportRootNode(children[0]) ? children[0] : candidate;
}

/** 判断当前选择是否可以作为 Figma导入Prefab 的根节点。 */
function isHierarchyExportRootNode(node) {
  if (!isHierarchyExportNode(node)) {
    return false;
  }
  return "children" in node && Array.isArray(node.children);
}

function resolveHierarchyPrefabRootCandidate(node) {
  if (!node) {
    return null;
  }
  if (isHierarchyImportBoundsNode(node)) {
    return node;
  }

  const selectedPrefabPath = getHierarchySharedPluginData(node, "prefabPath");
  let current = node;
  let topPrefabNode = null;
  let importBoundsParent = null;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    if (isHierarchyImportBoundsNode(current)) {
      importBoundsParent = current;
    }

    const importKind = getHierarchySharedPluginData(current, "importKind");
    const currentPrefabPath = getHierarchySharedPluginData(current, "prefabPath");
    if (
      importKind === "prefab-to-figma" &&
      (!selectedPrefabPath || !currentPrefabPath || currentPrefabPath === selectedPrefabPath) &&
      isHierarchyExportRootNode(current)
    ) {
      topPrefabNode = current;
    }

    current = current.parent;
  }

  return importBoundsParent || topPrefabNode || node;
}

function isHierarchyImportBoundsNode(node) {
  const name = String(node && node.name || "");
  return getHierarchySharedPluginData(node, "nodeRole") === "importBounds" || name.endsWith("__ImportBounds");
}

function getHierarchySharedPluginData(node, key) {
  if (!node || typeof node.getSharedPluginData !== "function") {
    return "";
  }
  return node.getSharedPluginData(PrefabToFigmaNamespace, key) || "";
}

/** 跳过九宫/三切片内部叶子，不跳过父容器名中包含 __slice 的节点。 */
function isHierarchySliceLeafNode(node) {
  return String(node && node.name || "").startsWith("__slice_");
}

/** 跳过 Prefab导入Figma 为渲染效果创建的内部视觉叶子。 */
function isHierarchyPrefabVisualLeafNode(node) {
  const name = String(node && node.name || "");
  return name === "__text" || name === "__text_underlay" || name === "__image";
}

/** 嵌套 Prefab / 通用组件作为一个 Unity 节点同步，不展开 Figma 内部实现层。 */
function isHierarchyOpaquePrefabNode(node, parentPath) {
  if (!node) {
    return false;
  }
  const role = getHierarchySharedPluginData(node, "nodeRole");
  if (
    role === "prefabInstance" ||
    role === "prefabInstanceFrame" ||
    role === "missingNestedPrefabPlaceholder"
  ) {
    return true;
  }
  if (
    getHierarchySharedPluginData(node, "sourcePrefabGuid") ||
    getHierarchySharedPluginData(node, "sourcePrefabPath")
  ) {
    return true;
  }
  if (!parentPath) {
    return false;
  }
  return isHierarchyCommonPrefabName(node.name);
}

function isHierarchyCommonPrefabName(name) {
  const normalized = String(name || "").replace(/^\[|\]$/g, "");
  return /^(Common_|Common-|CommonPrefab_|Common_Prefab_|KaTong|KaTone)/.test(normalized);
}

function getHierarchySyncBoundaryKind(node, parentPath, rootPath) {
  if (isHierarchyOpaquePrefabNode(node, parentPath)) {
    return "NestedPrefabBoundary";
  }
  if (!parentPath && isHierarchyCommonPrefabName(node && node.name)) {
    return "NestedPrefabBoundary";
  }
  if (!parentPath && !rootPath) {
    return "RootAsset";
  }
  return "NormalNode";
}

function buildHierarchyStructuralPath(node, rootNode) {
  const segments = [];
  let current = node;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    segments.push(getHierarchyStructuralSegment(current));
    if (rootNode && current === rootNode) {
      break;
    }
    current = current.parent;
  }
  return segments.reverse().join("/");
}

function getHierarchyStructuralSegment(node) {
  const name = String(node && node.name || "Unnamed");
  const index = getHierarchyRawSiblingIndex(node);
  return index + ":" + name;
}

function buildHierarchyAncestorIdSet(selectedNode, rootNode) {
  const result = {};
  let current = selectedNode;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    if (current.id) {
      result[String(current.id)] = true;
    }
    if (rootNode && current === rootNode) {
      break;
    }
    current = current.parent;
  }
  return result;
}

function isHierarchySelectedAncestor(node, selectedAncestorIds) {
  return !!(node && node.id && selectedAncestorIds && selectedAncestorIds[String(node.id)]);
}

function isHierarchySelectedNode(node, selectedNodeId) {
  return !!(node && node.id && selectedNodeId && String(node.id) === selectedNodeId);
}

/** 递归采集节点树，保留 siblingIndex 作为 Unity 排序依据。 */
async function collectHierarchyExportNode(node, parentPath, siblingIndex, syncImages, selectedAncestorIds, selectedNodeId, rootNode, insideNestedPrefabOverride, geometrySyncSelectionId, insideGeometrySyncSelection) {
  if (isCleanupRecoveryNode(node)) {
    throw new Error("cleanup recovery backup cannot be exported");
  }
  const name = String(node.name || "Unnamed");
  const path = parentPath ? parentPath + "/" + name : name;
  const rawSyncBoundaryKind = getHierarchySyncBoundaryKind(node, parentPath, "");
  const isOpaquePrefab = rawSyncBoundaryKind === "NestedPrefabBoundary";
  const isNestedPrefabOverride = !!insideNestedPrefabOverride || isOpaquePrefab;
  const syncBoundaryKind = isNestedPrefabOverride ? "NestedPrefabInternalOverride" : rawSyncBoundaryKind;
  const absolute = getHierarchyNodeAbsolutePosition(node);
  const local = getHierarchyNodeLocalPosition(node);
  const textInfo = getHierarchyTextInfo(node);
  const imageInfo = syncImages && syncBoundaryKind === "NormalNode" ? await getHierarchyImageInfo(node, path) : null;
  const rawSiblingIndex = getHierarchyRawSiblingIndex(node);
  const orderBaseline = readHierarchyOrderBaseline(node, rawSiblingIndex);
  const geometrySnapshot = {
    x: roundHierarchyNumber(local.x),
    y: roundHierarchyNumber(local.y),
    width: roundHierarchyNumber(Number(node.width || 0)),
    height: roundHierarchyNumber(Number(node.height || 0)),
    rotation: roundHierarchyNumber(Number(node.rotation || 0))
  };
  const geometryBaseline = readHierarchyGeometryBaseline(node, geometrySnapshot);
  const isGeometrySyncSelectionNode = !!(geometrySyncSelectionId && node && node.id && String(node.id) === geometrySyncSelectionId);
  const canSyncGeometry = !!geometrySyncSelectionId && (insideGeometrySyncSelection || isGeometrySyncSelectionNode);
  const result = {
    id: String(node.id || ""),
    name,
    type: String(node.type || ""),
    path,
    structuralPath: buildHierarchyStructuralPath(node, rootNode || node),
    syncBoundaryKind,
    sourcePrefabGuid: getHierarchySharedPluginData(node, "sourcePrefabGuid"),
    sourcePrefabPath: getHierarchySharedPluginData(node, "sourcePrefabPath"),
    nodeRole: getHierarchySharedPluginData(node, "nodeRole"),
    allowCreateChildren: !isNestedPrefabOverride && (syncBoundaryKind === "NormalNode" || syncBoundaryKind === "RootAsset"),
    allowDeleteChildren: !isNestedPrefabOverride && (syncBoundaryKind === "NormalNode" || syncBoundaryKind === "RootAsset"),
    allowReparent: !isNestedPrefabOverride && (syncBoundaryKind === "NormalNode" || syncBoundaryKind === "RootAsset"),
    siblingIndex: siblingIndex || 0,
    figmaSiblingIndex: rawSiblingIndex,
    hasOrderBaseline: orderBaseline.hasBaseline,
    orderBaselineSiblingIndex: orderBaseline.value,
    hasGeometryBaseline: geometryBaseline.hasBaseline,
    geometryChangedFromBaseline: canSyncGeometry && geometryBaseline.changed,
    visible: node.visible !== false,
    x: geometrySnapshot.x,
    y: geometrySnapshot.y,
    absoluteX: roundHierarchyNumber(absolute.x),
    absoluteY: roundHierarchyNumber(absolute.y),
    width: geometrySnapshot.width,
    height: geometrySnapshot.height,
    rotation: geometrySnapshot.rotation,
    constraints: normalizeHierarchyExportConstraints(node),
    fontSize: textInfo.fontSize,
    hasText: textInfo.hasText,
    hasImage: !!imageInfo,
    image: imageInfo,
    childrenComplete: true,
    children: []
  };

  const isSelectedAncestor = isHierarchySelectedAncestor(node, selectedAncestorIds);
  const isSelectedNode = isHierarchySelectedNode(node, selectedNodeId);
  const restrictOpaqueChildrenToSelectedPath = isOpaquePrefab && isSelectedAncestor && !isSelectedNode;

  if ("children" in node && Array.isArray(node.children)) {
    let children = node.children.filter(child => isHierarchyExportNode(child) && !isCleanupRecoveryNode(child));
    if (restrictOpaqueChildrenToSelectedPath) {
      children = children.filter(child => isHierarchySelectedAncestor(child, selectedAncestorIds));
    }
    for (let i = 0; i < children.length; i++) {
      result.children.push(await collectHierarchyExportNode(children[i], path, i, syncImages, selectedAncestorIds, selectedNodeId, rootNode || node, isNestedPrefabOverride, geometrySyncSelectionId, canSyncGeometry));
    }
  }

  return result;
}

function normalizeHierarchyExportConstraints(node) {
  if (!node || !("constraints" in node) || !node.constraints) {
    return { horizontal: "CENTER", vertical: "CENTER" };
  }
  return {
    horizontal: normalizeConstraint(node.constraints.horizontal, "CENTER"),
    vertical: normalizeConstraint(node.constraints.vertical, "CENTER")
  };
}

function getHierarchyRawSiblingIndex(node) {
  if (!node || !node.parent || !("children" in node.parent) || !Array.isArray(node.parent.children)) {
    return 0;
  }
  const index = node.parent.children.indexOf(node);
  return index >= 0 ? index : 0;
}

function readHierarchyOrderBaseline(node, currentIndex) {
  const key = "hierarchySyncBaselineSiblingIndex";
  const raw = getHierarchySharedPluginData(node, key);
  if (raw !== "") {
    const parsed = Number(raw);
    return {
      hasBaseline: Number.isFinite(parsed),
      value: Number.isFinite(parsed) ? Math.round(parsed) : currentIndex
    };
  }
  if (node && typeof node.setSharedPluginData === "function") {
    node.setSharedPluginData(PrefabToFigmaNamespace, key, String(currentIndex));
  }
  return {
    hasBaseline: false,
    value: currentIndex
  };
}

function readHierarchyGeometryBaseline(node, snapshot) {
  const key = "hierarchySyncBaselineGeometry";
  const importedRect = parseHierarchyGeometryBaseline(getHierarchySharedPluginData(node, "rect"));
  if (importedRect) {
    return {
      hasBaseline: true,
      changed: !hierarchyGeometryApproximatelyEqual(snapshot, importedRect)
    };
  }

  const raw = getHierarchySharedPluginData(node, key);
  if (raw !== "") {
    const baseline = parseHierarchyGeometryBaseline(raw);
    if (baseline) {
      return {
        hasBaseline: true,
        changed: !hierarchyGeometryApproximatelyEqual(snapshot, baseline)
      };
    }
  }

  if (node && typeof node.setSharedPluginData === "function") {
    node.setSharedPluginData(PrefabToFigmaNamespace, key, JSON.stringify(snapshot));
  }
  return {
    hasBaseline: false,
    changed: false
  };
}

function parseHierarchyGeometryBaseline(raw) {
  try {
    const parsed = JSON.parse(String(raw || ""));
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      x: Number(parsed.x || 0),
      y: Number(parsed.y || 0),
      width: Number(parsed.width || 0),
      height: Number(parsed.height || 0),
      rotation: Number(parsed.rotation || 0)
    };
  } catch (_error) {
    return null;
  }
}

function hierarchyGeometryApproximatelyEqual(left, right) {
  return hierarchyNumberApproximatelyEqual(left.x, right.x)
    && hierarchyNumberApproximatelyEqual(left.y, right.y)
    && hierarchyNumberApproximatelyEqual(left.width, right.width)
    && hierarchyNumberApproximatelyEqual(left.height, right.height)
    && hierarchyNumberApproximatelyEqual(left.rotation, right.rotation);
}

function hierarchyNumberApproximatelyEqual(left, right) {
  return Math.abs(Number(left || 0) - Number(right || 0)) <= 0.01;
}

/** 如果节点有可见 IMAGE fill，则导出 PNG 数据给 Unity 替换匹配 Image 组件的 Sprite。 */
async function getHierarchyImageInfo(node, nodePath) {
  const assetInfo = readHierarchyImageAssetInfo(node);
  const hasExistingSprite = !!(assetInfo.spriteGuid || assetInfo.spritePath || assetInfo.assetPath);
  if (hasExistingSprite) {
    return {
      nodeId: String(node.id || ""),
      nodeName: String(node.name || "FigmaImage"),
      nodePath: String(nodePath || ""),
      imageHash: findFirstImageHash(node, false),
      fileName: buildUnityImageName(node, nodePath),
      base64: "",
      mode: "existingSprite",
      spriteGuid: assetInfo.spriteGuid,
      spritePath: assetInfo.spritePath,
      assetPath: assetInfo.assetPath
    };
  }

  if (!hasImageFill(node) || !("exportAsync" in node) || Number(node.width || 0) <= 0 || Number(node.height || 0) <= 0) {
    return null;
  }

  const bytes = await node.exportAsync({ format: "PNG" });
  return {
    nodeId: String(node.id || ""),
    nodeName: String(node.name || "FigmaImage"),
    nodePath: String(nodePath || ""),
    imageHash: findFirstImageHash(node, false),
    fileName: buildUnityImageName(node, nodePath),
    base64: bytesToBase64(bytes),
    mode: "exportedPng",
    spriteGuid: "",
    spritePath: "",
    assetPath: ""
  };
}

/** 获取节点相对父节点的 Figma 左上角坐标。 */
function getHierarchyNodeLocalPosition(node) {
  return {
    x: Number(node.x || 0),
    y: Number(node.y || 0)
  };
}

/** 获取节点绝对左上角坐标，供 Unity 根节点或跨父级同步计算。 */
function getHierarchyNodeAbsolutePosition(node) {
  if (node && node.absoluteTransform) {
    return {
      x: Number(node.absoluteTransform[0][2] || 0),
      y: Number(node.absoluteTransform[1][2] || 0)
    };
  }
  return getHierarchyNodeLocalPosition(node);
}

/** 只采集字号；字体、材质、字库引用不参与同步。 */
function getHierarchyTextInfo(node) {
  if (!node || node.type !== "TEXT") {
    return { hasText: false, fontSize: 0 };
  }

  const value = node.fontSize;
  if (typeof value === "number") {
    return { hasText: true, fontSize: roundHierarchyNumber(value) };
  }
  return { hasText: true, fontSize: 0 };
}

/** 限制小数噪声，避免 Unity Prefab 反复出现无意义改动。 */
function roundHierarchyNumber(value) {
  const number = Number(value || 0);
  if (!isFinite(number)) {
    return 0;
  }
  return Math.round(number * 1000) / 1000;
}
function normalizePsdLayerId(value) {
  var text = String(value == null ? "" : value).trim();
  return /^\d+$/.test(text) && text !== "0" ? text : "";
}

function canonicalizePsdSourceState(value) {
  if (Array.isArray(value)) return value.map(canonicalizePsdSourceState);
  if (!value || typeof value !== "object") return value;
  var result = {};
  for (var key of Object.keys(value).sort()) {
    var child = value[key];
    if (typeof child !== "undefined") result[key] = canonicalizePsdSourceState(child);
  }
  return result;
}

function stablePsdSourceStateJson(value) {
  return JSON.stringify(canonicalizePsdSourceState(value));
}

function hashPsdSourceState(value) {
  var text = stablePsdSourceStateJson(value);
  var hash = 2166136261;
  for (var index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function equalPsdAssetBytes(left, right) {
  if (!left || !right || typeof left.length !== "number" || typeof right.length !== "number") return false;
  if (left.length !== right.length) return false;
  for (var index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function resolvePsdLiveContentHash(options) {
  var value = options || {};
  if (equalPsdAssetBytes(value.currentBytes, value.incomingBytes)) {
    return String(value.incomingContentHash || "");
  }
  return "figma-image:" + String(value.currentImageHash || "missing");
}

function isPsdFontFamilyAllowed(textState, liveFamily) {
  var expected = textState || {};
  var actual = String(liveFamily || "").trim().toLowerCase();
  if (!actual) return false;
  if (String(expected.fontFamily || "").trim().toLowerCase() === actual) return true;
  return (Array.isArray(expected.fontFallback) ? expected.fontFallback : []).some(function (candidate) {
    return String(candidate && candidate.family || "").trim().toLowerCase() === actual;
  });
}

function isLegacyPsdPlacedPayloadUnsupported(item, mode) {
  if (mode === "text" || !item || item.path !== "geometry.rotation") return false;
  var value = item.value;
  return !!value
    && typeof value === "object"
    && ["SoLd", "PlLd", "PlcL"].includes(String(value.tag || ""))
    && typeof value.sha256 === "string";
}

function normalizePsdSourceState(layer) {
  var sourceLayer = layer || {};
  var raw = sourceLayer.sourceState && typeof sourceLayer.sourceState === "object"
    ? sourceLayer.sourceState
    : sourceLayer;
  if (!raw || typeof raw !== "object") return null;
  var geometry = raw.geometry || {};
  var display = raw.display || {};
  var geometryX = geometry.x != null ? geometry.x : sourceLayer.x;
  var geometryY = geometry.y != null ? geometry.y : sourceLayer.y;
  var geometryWidth = geometry.width != null
    ? geometry.width
    : (sourceLayer.w != null ? sourceLayer.w : sourceLayer.width);
  var geometryHeight = geometry.height != null
    ? geometry.height
    : (sourceLayer.h != null ? sourceLayer.h : sourceLayer.height);
  var rotation = geometry.rotation == null ? null : Number(geometry.rotation);
  var mode = String(raw.mode || sourceLayer.mode || "image");
  return canonicalizePsdSourceState({
    version: 3,
    layerId: normalizePsdLayerId(raw.layerId || sourceLayer.layerId),
    mode: mode,
    geometry: {
      x: Number(geometryX == null ? 0 : geometryX),
      y: Number(geometryY == null ? 0 : geometryY),
      width: Number(geometryWidth == null ? 0 : geometryWidth),
      height: Number(geometryHeight == null ? 0 : geometryHeight),
      rotation: Number.isFinite(rotation) ? rotation : null,
    },
    display: {
      visible: (display.visible != null ? display.visible : sourceLayer.visible) !== false,
      opacity: Number(display.opacity != null
        ? display.opacity
        : (sourceLayer.opacity != null ? sourceLayer.opacity : 1)),
      blendMode: display.blendMode != null ? display.blendMode : null,
      constraints: display.constraints || sourceLayer.constraints || {},
    },
    content: raw.content || { contentHash: String(sourceLayer.contentHash || "") },
    text: raw.text || null,
    nineSlice: raw.nineSlice || null,
    unsupported: Array.isArray(raw.unsupported)
      ? raw.unsupported.filter(function (item) {
        return !isLegacyPsdPlacedPayloadUnsupported(item, mode);
      })
      : [],
  });
}

var PSD_SOURCE_FIELD_DESCRIPTORS = [
  ["content.contentHash", "content"],
  ["geometry.x", "position"], ["geometry.y", "position"],
  ["geometry.width", "size"], ["geometry.height", "size"],
  ["geometry.rotation", "rotation"],
  ["display.visible", "display"], ["display.opacity", "display"],
  ["display.blendMode", "display"], ["display.constraints", "display"],
  ["text.characters", "textContent"], ["text.fontFamily", "textStyle"],
  ["text.fontFallback", "textStyle"], ["text.fontSize", "textStyle"],
  ["text.effectiveFontSize", "textStyle"], ["text.leading", "textStyle"],
  ["text.lineHeightMode", "textStyle"], ["text.textAlignHorizontal", "textStyle"],
  ["text.fillColor", "textStyle"], ["text.stroke", "textStyle"],
  ["text.dropShadow", "textStyle"],
  ["nineSlice", "nineSlice"],
];

function valueAtPsdPath(value, path) {
  return path.split(".").reduce(function (current, key) {
    return current == null ? undefined : current[key];
  }, value);
}

function psdNumericToleranceForPath(path) {
  if (path === "display.opacity") return 0.000001;
  if (path.startsWith("geometry.")
    || path === "text.fontSize"
    || path === "text.effectiveFontSize"
    || path === "text.leading") return 0.01;
  return 0;
}

function psdValuesEqualWithinTolerance(left, right, tolerance) {
  if (typeof left === "number" && typeof right === "number") {
    return Number.isFinite(left) && Number.isFinite(right)
      ? Math.abs(left - right) <= tolerance
      : Object.is(left, right);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every(function (item, index) {
      return psdValuesEqualWithinTolerance(item, right[index], tolerance);
    });
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    var keys = Array.from(new Set(Object.keys(left).concat(Object.keys(right)))).sort();
    return keys.every(function (key) {
      return psdValuesEqualWithinTolerance(left[key], right[key], tolerance);
    });
  }
  return left === right;
}

function psdValuesEqualForPath(path, before, after) {
  var tolerance = psdNumericToleranceForPath(path);
  if (path === "text.fillColor" || path === "text.stroke" || path === "text.dropShadow") {
    tolerance = 0.001;
  }
  return tolerance > 0 && psdValuesEqualWithinTolerance(before, after, tolerance);
}

function diffPsdSourceStates(baseline, incoming) {
  var changes = [];
  for (var descriptor of PSD_SOURCE_FIELD_DESCRIPTORS) {
    var path = descriptor[0];
    var before = valueAtPsdPath(baseline, path);
    var after = valueAtPsdPath(incoming, path);
    if (psdValuesEqualForPath(path, before, after)) continue;
    if (stablePsdSourceStateJson(before) === stablePsdSourceStateJson(after)) continue;
    changes.push({
      path: path,
      category: descriptor[1],
      before: before,
      after: after,
      delta: typeof before === "number" && typeof after === "number" ? after - before : null,
    });
  }
  var unsupportedChanged = stablePsdSourceStateJson(baseline.unsupported || [])
    !== stablePsdSourceStateJson(incoming.unsupported || []);
  return { changes: changes, unsupportedChanged: unsupportedChanged };
}

function categoryLayerCount(changed, category) {
  return changed.filter(function (pair) {
    return pair.changes.some(function (change) { return change.category === category; });
  }).length;
}

function transformPsdVector(matrix, vector) {
  return {
    x: matrix[0][0] * vector.x + matrix[0][1] * vector.y,
    y: matrix[1][0] * vector.x + matrix[1][1] * vector.y,
  };
}

function transformPsdPoint(matrix, point) {
  return {
    x: matrix[0][0] * point.x + matrix[0][1] * point.y + matrix[0][2],
    y: matrix[1][0] * point.x + matrix[1][1] * point.y + matrix[1][2],
  };
}

function inversePsdTransformPoint(matrix, point) {
  var a = matrix[0][0], c = matrix[0][1], tx = matrix[0][2];
  var b = matrix[1][0], d = matrix[1][1], ty = matrix[1][2];
  var determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) {
    throw new Error("non-invertible-parent-transform");
  }
  var x = point.x - tx;
  var y = point.y - ty;
  return {
    x: (d * x - c * y) / determinant,
    y: (-b * x + a * y) / determinant,
  };
}

function computePsdGeometryTarget(input) {
  var incoming = input.incoming;
  var desiredAbsolute = transformPsdPoint(input.rootAbsoluteTransform, {
    x: incoming.x,
    y: incoming.y,
  });
  var rootOriginInParent = inversePsdTransformPoint(
    input.parentAbsoluteTransform,
    transformPsdPoint(input.rootAbsoluteTransform, { x: 0, y: 0 }),
  );
  var widthEdgeInParent = inversePsdTransformPoint(
    input.parentAbsoluteTransform,
    transformPsdPoint(input.rootAbsoluteTransform, { x: incoming.width, y: 0 }),
  );
  var heightEdgeInParent = inversePsdTransformPoint(
    input.parentAbsoluteTransform,
    transformPsdPoint(input.rootAbsoluteTransform, { x: 0, y: incoming.height }),
  );
  var rotation = Number.isFinite(incoming.rotation) ? incoming.rotation : input.currentRotation;
  return {
    localPosition: inversePsdTransformPoint(input.parentAbsoluteTransform, desiredAbsolute),
    size: {
      width: Math.hypot(
        widthEdgeInParent.x - rootOriginInParent.x,
        widthEdgeInParent.y - rootOriginInParent.y,
      ),
      height: Math.hypot(
        heightEdgeInParent.x - rootOriginInParent.x,
        heightEdgeInParent.y - rootOriginInParent.y,
      ),
    },
    rotation: rotation,
  };
}

function mapPsdLiveGeometryToSource(input) {
  var nodeSize = input.nodeSize || { width: 0, height: 0 };
  var pageOrigin = transformPsdPoint(input.nodeAbsoluteTransform, { x: 0, y: 0 });
  var pageWidthEdge = transformPsdPoint(input.nodeAbsoluteTransform, { x: nodeSize.width, y: 0 });
  var pageHeightEdge = transformPsdPoint(input.nodeAbsoluteTransform, { x: 0, y: nodeSize.height });
  var sourceOrigin = inversePsdTransformPoint(input.rootAbsoluteTransform, pageOrigin);
  var sourceWidthEdge = inversePsdTransformPoint(input.rootAbsoluteTransform, pageWidthEdge);
  var sourceHeightEdge = inversePsdTransformPoint(input.rootAbsoluteTransform, pageHeightEdge);
  var widthVector = {
    x: sourceWidthEdge.x - sourceOrigin.x,
    y: sourceWidthEdge.y - sourceOrigin.y,
  };
  var heightVector = {
    x: sourceHeightEdge.x - sourceOrigin.x,
    y: sourceHeightEdge.y - sourceOrigin.y,
  };
  var rotation = Math.atan2(widthVector.y, widthVector.x) * 180 / Math.PI;
  if (Math.abs(rotation) < 1e-10) rotation = 0;
  return {
    x: sourceOrigin.x,
    y: sourceOrigin.y,
    width: Math.hypot(widthVector.x, widthVector.y),
    height: Math.hypot(heightVector.x, heightVector.y),
    rotation: rotation,
  };
}

function buildPsdLayerMutationPlan(pair) {
  var categories = Array.from(new Set(pair.changes.map(function (change) {
    return change.category;
  }))).sort();
  return {
    layerId: normalizePsdLayerId(pair.source.layerId),
    nodeId: String(pair.target.nodeId || ""),
    source: pair.source,
    target: pair.target,
    categories: categories,
    changedPaths: pair.changes.map(function (change) { return change.path; }).sort(),
    baseline: normalizePsdSourceState({ sourceState: pair.target.sourceState }),
    incoming: normalizePsdSourceState(pair.source),
  };
}

function psdOwnershipForMode(mode) {
  if (mode === "text") return "text-content";
  if (mode === "image") return "image-content";
  if (mode === "nine-slice") return "nine-slice-content";
  return "protected";
}

function validatePsdOwnedTarget(ownership, sourceMode, nodeType, textAutoResize) {
  var expected = psdOwnershipForMode(sourceMode);
  if (expected === "protected") return "protected-source-mode";
  if (ownership !== expected) return "ownership-mismatch";
  if (expected === "nine-slice-content") {
    return nodeType === "FRAME" ? "" : "unsupported-nine-slice-target";
  }
  if (expected === "text-content") {
    if (nodeType !== "TEXT") return "unsupported-text-target";
    if (textAutoResize && textAutoResize !== "NONE") return "unsafe-text-auto-resize";
    return "";
  }
  return nodeType === "RECTANGLE" ? "" : "unsupported-image-target";
}

function measurePsdLayerIdentity(currentNodes, incomingLayers) {
  var current = new Set((currentNodes || []).map(function (item) {
    return normalizePsdLayerId(item && item.layerId);
  }).filter(Boolean));
  var incoming = new Set((incomingLayers || []).map(function (item) {
    return normalizePsdLayerId(item && item.layerId);
  }).filter(Boolean));
  var matched = 0;
  for (var layerId of current) {
    if (incoming.has(layerId)) matched += 1;
  }
  var comparisonSize = Math.max(current.size, incoming.size);
  return {
    currentCount: current.size,
    incomingCount: incoming.size,
    matchedCount: matched,
    currentCoverage: current.size > 0 ? matched / current.size : 0,
    incomingCoverage: incoming.size > 0 ? matched / incoming.size : 0,
    overlap: comparisonSize > 0 ? matched / comparisonSize : 0,
  };
}

function isPsdIncrementalCandidate(record) {
  var node = record && record.node;
  if (!node) return true;
  if (typeof isCleanupRecoveryNode === "function") {
    return !isCleanupRecoveryNode(node);
  }
  var current = node;
  while (current) {
    if (typeof current.name === "string" && current.name.startsWith("__cleanup_backup__")) {
      return false;
    }
    current = current.parent || null;
  }
  return true;
}


function buildPsdIncrementalDiff(currentNodes, incomingLayers) {
  var currentById = new Map();
  var conflicts = [];

  for (var current of currentNodes || []) {
    if (!isPsdIncrementalCandidate(current)) continue;
    var currentId = normalizePsdLayerId(current && current.layerId);
    if (!currentId) continue;
    if (currentById.has(currentId)) {
      conflicts.push({
        kind: "duplicate-target-layer-id",
        layerId: currentId,
        first: currentById.get(currentId),
        duplicate: current,
      });
      continue;
    }
    currentById.set(currentId, current);
  }

  var incomingById = new Map();
  for (var source of incomingLayers || []) {
    var sourceId = normalizePsdLayerId(source && source.layerId);
    if (!sourceId) {
      conflicts.push({
        kind: "missing-source-layer-id",
        name: source && source.name ? String(source.name) : "",
      });
      continue;
    }
    if (incomingById.has(sourceId)) {
      conflicts.push({
        kind: "duplicate-source-layer-id",
        layerId: sourceId,
        first: incomingById.get(sourceId),
        duplicate: source,
      });
      continue;
    }
    incomingById.set(sourceId, source);
  }

  var changed = [];
  var unchanged = [];
  var added = [];
  var missing = [];
  var baselineRequired = [];

  for (var incomingEntry of incomingById.entries()) {
    var layerId = incomingEntry[0];
    var sourceLayer = incomingEntry[1];
    var incomingState = normalizePsdSourceState(sourceLayer);
    var target = currentById.get(layerId);
    if (!target) {
      if (incomingState && incomingState.unsupported.length > 0) {
        conflicts.push({
          kind: "unsupported-source-change",
          layerId: layerId,
          unsupported: incomingState.unsupported,
        });
      } else {
        added.push({ source: sourceLayer, sourceState: incomingState });
      }
      continue;
    }

    if (!target.sourceState || typeof target.sourceState !== "object") {
      baselineRequired.push({ source: sourceLayer, target: target, sourceState: incomingState });
      continue;
    }

    var baselineState = normalizePsdSourceState({
      layerId: layerId,
      sourceState: target.sourceState,
    });
    var sourceFieldDiff = diffPsdSourceStates(baselineState, incomingState);
    var liveState = target.liveState && typeof target.liveState === "object"
      ? normalizePsdSourceState({ layerId: layerId, sourceState: target.liveState })
      : null;
    var liveFieldDiff = liveState ? diffPsdSourceStates(liveState, incomingState) : sourceFieldDiff;
    var fieldDiff = liveFieldDiff.changes.length > 0 || !sourceFieldDiff.changes.length
      ? liveFieldDiff
      : sourceFieldDiff;
    var pair = {
      source: sourceLayer,
      target: target,
      baselineState: baselineState,
      liveState: liveState,
      sourceState: incomingState,
      changes: fieldDiff.changes,
    };

    if (fieldDiff.changes.some(function (change) {
      return change.path === "geometry.rotation"
        && (!Number.isFinite(change.before) || !Number.isFinite(change.after));
    })) {
      conflicts.push({ kind: "unreliable-rotation-delta", layerId: layerId });
    }
    if (sourceFieldDiff.unsupportedChanged) {
      conflicts.push({
        kind: "unsupported-source-change",
        layerId: layerId,
        before: baselineState.unsupported,
        after: incomingState.unsupported,
      });
    }

    if (fieldDiff.changes.length === 0 && !sourceFieldDiff.unsupportedChanged) unchanged.push(pair);
    else changed.push(pair);
  }

  for (var currentEntry of currentById.entries()) {
    if (!incomingById.has(currentEntry[0])) {
      missing.push({ target: currentEntry[1] });
    }
  }

  var status = conflicts.length > 0
    ? "preview-blocked"
    : baselineRequired.length > 0
      ? "preview-baseline-required"
      : changed.length === 0 && added.length === 0
        ? "preview-no-changes"
        : "preview-ready";

  return {
    status: status,
    changed: changed,
    unchanged: unchanged,
    added: added,
    missing: missing,
    baselineRequired: baselineRequired,
    conflicts: conflicts,
    canApply: status === "preview-ready",
    summary: {
      affected: changed.length,
      changed: changed.length,
      unchanged: unchanged.length,
      added: added.length,
      missing: missing.length,
      conflicts: conflicts.length,
      content: categoryLayerCount(changed, "content"),
      textContent: categoryLayerCount(changed, "textContent"),
      position: categoryLayerCount(changed, "position"),
      size: categoryLayerCount(changed, "size"),
      rotation: categoryLayerCount(changed, "rotation"),
      display: categoryLayerCount(changed, "display"),
      textStyle: categoryLayerCount(changed, "textStyle"),
      nineSlice: categoryLayerCount(changed, "nineSlice"),
      baselineRequired: baselineRequired.length,
    },
  };
}
const CleanupMetadataNamespace = "psd_layer_to_figma_bridge";

const CleanupPsdMetadataKeys = Object.freeze([
  "psdLayerId",
  "psdOwnership",
  "psdContentHash",
  "rawPsdLayerName",
  "psdSourceFileName",
  "psdSourceKey",
  "psdLayerSetFingerprint",
]);

const CleanupSnapshotLimits = Object.freeze({
  maxNodes: 500,
  maxDepth: 12,
  maxTextCharacters: 256,
  maxBytes: 256 * 1024,
});

function isCleanupRecoveryNode(node) {
  let current = node || null;
  while (current) {
    if (typeof current.name === "string" && current.name.startsWith("__cleanup_backup__")) {
      return true;
    }
    current = current.parent || null;
  }
  return false;
}

function buildCleanupSnapshot(root, requestedLimits = CleanupSnapshotLimits) {
  if (!root || !root.id) throw new Error("cleanup snapshot requires one root node");
  if (isCleanupRecoveryNode(root)) throw new Error("cleanup recovery backup cannot be used as a cleanup root");
  const limits = normalizeCleanupSnapshotLimits(requestedLimits);
  const nodes = [];
  collectCleanupSnapshotNodes(root, 0, nodes, limits);
  const snapshot = {
    schemaVersion: 1,
    rootNodeId: String(root.id),
    capturedAt: typeof requestedLimits.now === "function"
      ? String(requestedLimits.now())
      : new Date().toISOString(),
    limits: {
      maxNodes: limits.maxNodes,
      maxDepth: limits.maxDepth,
      maxTextCharacters: limits.maxTextCharacters,
      maxBytes: limits.maxBytes,
    },
    nodes,
  };
  const byteLength = cleanupUtf8ByteLength(JSON.stringify(snapshot));
  if (byteLength > limits.maxBytes) {
    throw new Error(`cleanup snapshot exceeds ${limits.maxBytes} bytes`);
  }
  return snapshot;
}

function normalizeCleanupSnapshotLimits(value) {
  return {
    maxNodes: positiveCleanupLimit(value && value.maxNodes, CleanupSnapshotLimits.maxNodes),
    maxDepth: nonNegativeCleanupLimit(value && value.maxDepth, CleanupSnapshotLimits.maxDepth),
    maxTextCharacters: nonNegativeCleanupLimit(value && value.maxTextCharacters, CleanupSnapshotLimits.maxTextCharacters),
    maxBytes: positiveCleanupLimit(value && value.maxBytes, CleanupSnapshotLimits.maxBytes),
  };
}

function positiveCleanupLimit(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeCleanupLimit(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function collectCleanupSnapshotNodes(node, depth, output, limits) {
  if (isCleanupRecoveryNode(node)) return;
  if (depth > limits.maxDepth) {
    throw new Error(`cleanup snapshot exceeds depth ${limits.maxDepth}`);
  }
  if (output.length >= limits.maxNodes) {
    throw new Error(`cleanup snapshot exceeds ${limits.maxNodes} nodes`);
  }
  output.push(buildCleanupSnapshotNode(node, depth, limits.maxTextCharacters));
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    collectCleanupSnapshotNodes(child, depth + 1, output, limits);
  }
}

function buildCleanupSnapshotNode(node, depth, maxTextCharacters) {
  const psd = readCleanupPsdMetadata(node);
  const children = Array.isArray(node.children)
    ? node.children.filter((child) => !isCleanupRecoveryNode(child))
    : [];
  const record = {
    id: String(node.id || ""),
    parentId: node.parent && node.parent.id ? String(node.parent.id) : "",
    type: String(node.type || ""),
    name: String(node.name || ""),
    siblingIndex: cleanupSiblingIndex(node),
    depth,
    x: finiteCleanupNumber(node.x),
    y: finiteCleanupNumber(node.y),
    w: finiteCleanupNumber(node.width),
    h: finiteCleanupNumber(node.height),
    visible: node.visible !== false,
    opacity: Number.isFinite(Number(node.opacity)) ? Number(node.opacity) : 1,
    childCount: children.length,
    roles: {
      image: cleanupHasImagePaint(node),
      nineSlice: cleanupIsNineSlice(node),
      component: node.type === "COMPONENT" || node.type === "COMPONENT_SET" || node.type === "INSTANCE",
      psdSource: Object.keys(psd).length > 0,
    },
  };
  if (node.type === "TEXT") {
    record.characters = String(node.characters || "").slice(0, maxTextCharacters);
  }
  if (Object.keys(psd).length > 0) record.psd = psd;
  return record;
}

function cleanupSiblingIndex(node) {
  const siblings = node.parent && Array.isArray(node.parent.children)
    ? node.parent.children.filter((sibling) => !isCleanupRecoveryNode(sibling))
    : [];
  const index = siblings.indexOf(node);
  return index >= 0 ? index : 0;
}

function finiteCleanupNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function cleanupHasImagePaint(node) {
  return Array.isArray(node.fills) && node.fills.some((paint) => paint && paint.type === "IMAGE");
}

function cleanupIsNineSlice(node) {
  const name = String(node.name || "").toLowerCase();
  return /(?:nine.?slice|jiugong|__slice_|slice[_-]?\d)/.test(name)
    || cleanupSharedPluginData(node, "spriteBorder") !== ""
    || cleanupSharedPluginData(node, "border") !== "";
}

function readCleanupPsdMetadata(node) {
  const result = {};
  for (const key of CleanupPsdMetadataKeys) {
    const value = cleanupSharedPluginData(node, key);
    if (value !== "") result[key] = value;
  }
  return result;
}

function cleanupSharedPluginData(node, key) {
  if (!node || typeof node.getSharedPluginData !== "function") return "";
  try {
    return String(node.getSharedPluginData(CleanupMetadataNamespace, key) || "");
  } catch (_) {
    return "";
  }
}

function cleanupUtf8ByteLength(value) {
  return encodeURIComponent(String(value)).replace(/%[0-9A-F]{2}|./gi, "x").length;
}
const CleanupBackupPrefix = "__cleanup_backup__";
const CleanupRecoveryMetadataKey = "cleanupRecoveryMetadata";

function computeCleanupSnapshotHashFromNodes(nodes) {
  const canonicalNodes = (Array.isArray(nodes) ? nodes : [])
    .map(function (node) {
      return {
        id: String(node && node.id || ""),
        parentId: String(node && node.parentId || ""),
        type: String(node && node.type || ""),
        name: String(node && node.name || ""),
        siblingIndex: Number.isInteger(Number(node && node.siblingIndex)) ? Number(node.siblingIndex) : 0,
        depth: Number.isInteger(Number(node && node.depth)) ? Number(node.depth) : 0,
        x: cleanupPrimitiveOrNull(node && node.x),
        y: cleanupPrimitiveOrNull(node && node.y),
        w: cleanupPrimitiveOrNull(node && node.w),
        h: cleanupPrimitiveOrNull(node && node.h),
        visible: cleanupPrimitiveOrNull(node && node.visible),
        opacity: cleanupPrimitiveOrNull(node && node.opacity),
        childCount: cleanupPrimitiveOrNull(node && node.childCount),
        characters: cleanupPrimitiveOrNull(node && node.characters),
        roles: cleanupStableJsonValue(node && node.roles),
        psd: cleanupStableJsonValue(node && node.psd),
      };
    })
    .sort(function (left, right) {
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
  return cleanupSha256(JSON.stringify(canonicalNodes));
}

function captureCleanupRollbackJournal(root) {
  if (!root || !root.id) throw new Error("cleanup rollback journal requires a root node");
  const entries = [];
  cleanupCollectRollbackEntries(root, 0, entries);
  return {
    root: root,
    rootBounds: cleanupReadBounds(root),
    entries: entries,
    createdNodes: [],
    backupNode: null,
  };
}

async function rollbackCleanupTransaction(journal) {
  const errors = [];
  const mismatches = [];
  const entries = Array.isArray(journal && journal.entries) ? journal.entries : [];

  for (const entry of entries) {
    try {
      if (!entry.node || !entry.parent || typeof entry.parent.insertChild !== "function") {
        throw new Error("missing original parent for node " + entry.id);
      }
      entry.parent.insertChild(Math.min(entry.index, cleanupChildCount(entry.parent)), entry.node);
    } catch (error) {
      errors.push("restore parent " + entry.id + ": " + cleanupErrorMessage(error));
    }
  }

  for (const entry of entries) {
    try {
      cleanupRestoreNodeProperties(entry);
    } catch (error) {
      errors.push("restore properties " + entry.id + ": " + cleanupErrorMessage(error));
    }
  }

  const createdNodes = Array.isArray(journal && journal.createdNodes) ? journal.createdNodes.slice().reverse() : [];
  for (const node of createdNodes) {
    try {
      if (node && typeof node.remove === "function" && !node.removed) node.remove();
    } catch (error) {
      errors.push("remove created node: " + cleanupErrorMessage(error));
    }
  }

  for (const entry of entries) {
    const actualIndex = cleanupNodeIndex(entry.node);
    if (entry.node.parent !== entry.parent || actualIndex !== entry.index || String(entry.node.name || "") !== entry.name) {
      mismatches.push({
        nodeId: entry.id,
        expectedParentId: entry.parent && entry.parent.id ? String(entry.parent.id) : "",
        actualParentId: entry.node.parent && entry.node.parent.id ? String(entry.node.parent.id) : "",
        expectedIndex: entry.index,
        actualIndex: actualIndex,
        expectedName: entry.name,
        actualName: String(entry.node.name || ""),
      });
    }
  }

  return { pass: errors.length === 0 && mismatches.length === 0, errors: errors, mismatches: mismatches };
}

async function applyFigmaHierarchyCleanupTransactionJob(job) {
  const plan = job && job.plan ? job.plan : {};
  const target = job && job.target ? job.target : (plan.target || {});
  cleanupValidateTransactionEnvelope(plan, target);
  const nodeId = String(target.nodeId || plan.target.nodeId || "");
  const root = await cleanupGetNodeById(nodeId);
  if (!root) throw new Error("Figma node not found: " + nodeId);
  if (!Array.isArray(root.children)) throw new Error("Figma node has no children: " + String(root.type || "unknown"));
  await setCurrentPageForNode(root);

  const currentSnapshot = buildCleanupSnapshot(root);
  const actualHash = computeCleanupSnapshotHashFromNodes(currentSnapshot.nodes);
  const expectedHash = String(target.snapshotHash || plan.target.snapshotHash || "");
  if (actualHash !== expectedHash) {
    return {
      status: "failed",
      state: "failed",
      checks: { snapshotHash: { pass: false, expected: expectedHash, actual: actualHash } },
      rollback: {},
      errors: ["cleanup snapshot changed after approval; no writes were applied"],
    };
  }

  const journal = captureCleanupRollbackJournal(root);
  const operationResults = [];
  const createdNodeIds = new Map();
  try {
    if (plan.createBackup !== false) journal.backupNode = cleanupCreateBackup(root, job && job.sessionId);
    for (const operation of plan.operations) {
      const operationResult = await cleanupApplyOperation(operation, journal, createdNodeIds);
      operationResults.push(operationResult);
      if (operation && operation.type === "CREATE_GROUP") {
        createdNodeIds.set(String(operation.id || ""), String(operationResult.createdNodeId || ""));
      }
    }
    const checks = cleanupVerifyTransaction(root, journal, plan, operationResults);
    if (!checks.allPass) throw new CleanupVerificationError(checks);
    cleanupRemoveBackup(journal);
    return {
      status: "completed",
      state: "succeeded",
      rootNodeId: String(root.id),
      checks: checks,
      rollback: {},
      operationResults: operationResults,
      errors: [],
    };
  } catch (error) {
    const checks = error instanceof CleanupVerificationError
      ? error.checks
      : { allPass: false, operationExecution: { pass: false, error: cleanupErrorMessage(error) } };
    const rollback = await rollbackCleanupTransaction(journal);
    if (rollback.pass) {
      cleanupRemoveBackup(journal);
      return {
        status: "rolled_back",
        state: "rolled_back",
        rootNodeId: String(root.id),
        backupNodeId: "",
        checks: checks,
        rollback: rollback,
        operationResults: operationResults,
        errors: [cleanupErrorMessage(error)],
      };
    }
    return {
      status: "recovery_required",
      state: "recovery_required",
      rootNodeId: String(root.id),
      backupNodeId: journal.backupNode && journal.backupNode.id ? String(journal.backupNode.id) : "",
      checks: checks,
      rollback: rollback,
      operationResults: operationResults,
      errors: [cleanupErrorMessage(error)],
    };
  }
}

async function handleFigmaHierarchyCleanupTransaction(message) {
  try {
    const result = await applyFigmaHierarchyCleanupTransactionJob(message.job || {});
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_CLEANUP_TRANSACTION_RESULT",
      requestId: message.requestId,
      result: result,
    });
    if (result.state === "succeeded") {
      figma.notify("AI 层级整理已完成");
    } else if (result.state === "rolled_back") {
      figma.notify("AI 层级整理校验失败，已自动回滚", { error: true });
    } else {
      figma.notify("AI 层级整理失败，请保留隐藏备份并检查恢复信息", { error: true });
    }
  } catch (error) {
    figma.ui.postMessage({
      type: "FIGMA_HIERARCHY_CLEANUP_TRANSACTION_RESULT",
      requestId: message.requestId,
      result: {
        status: "failed",
        state: "failed",
        checks: {},
        rollback: {},
        errors: [cleanupErrorMessage(error)],
      },
    });
    figma.notify("AI 层级整理失败：" + cleanupErrorMessage(error), { error: true });
  }
}

function listCleanupRecoveryBackups(root) {
  const result = [];
  const visit = function (node) {
    if (!node) return;
    if (cleanupIsRecoveryBackupRoot(node)) {
      const metadata = cleanupReadRecoveryMetadata(node);
      result.push({
        nodeId: String(node.id || ""),
        name: String(node.name || ""),
        runId: String(metadata.runId || String(node.name || "").slice(CleanupBackupPrefix.length)),
        sourceName: String(metadata.sourceName || ""),
        type: String(node.type || ""),
      });
      return;
    }
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) visit(child);
  };
  visit(root);
  return result;
}

function restoreCleanupRecoveryBackup(backup, target) {
  if (!cleanupIsRecoveryBackupRoot(backup)) throw new Error("selected node is not a cleanup recovery backup");
  if (!target || !target.id || cleanupIsRecoveryNode(target)) throw new Error("select exactly one damaged non-backup root to restore");
  const parent = target.parent;
  if (!parent || !Array.isArray(parent.children) || typeof parent.insertChild !== "function") {
    throw new Error("selected damaged root cannot be replaced in its current parent");
  }
  if (typeof backup.clone !== "function") throw new Error("cleanup recovery backup cannot be cloned");
  if (typeof target.remove !== "function") throw new Error("selected damaged root cannot be removed");

  const metadata = cleanupReadRecoveryMetadata(backup);
  const targetIndex = Math.max(0, parent.children.indexOf(target));
  const restored = backup.clone();
  let targetRemoved = false;
  try {
    restored.name = String(metadata.sourceName || target.name || "Restored");
    if ("x" in restored) restored.x = cleanupRecoveryNumber(metadata.sourceX, target.x);
    if ("y" in restored) restored.y = cleanupRecoveryNumber(metadata.sourceY, target.y);
    if ("visible" in restored) restored.visible = typeof metadata.sourceVisible === "boolean" ? metadata.sourceVisible : target.visible !== false;
    if ("locked" in restored) restored.locked = typeof metadata.sourceLocked === "boolean" ? metadata.sourceLocked : target.locked === true;
    parent.insertChild(targetIndex, restored);
    target.remove();
    targetRemoved = true;
  } catch (error) {
    if (!targetRemoved && restored && typeof restored.remove === "function" && !restored.removed) {
      try { restored.remove(); } catch (_) { /* keep the original backup for manual recovery */ }
    }
    throw error;
  }

  let backupRetained = false;
  try {
    backup.remove();
  } catch (_) {
    backupRetained = true;
  }
  return {
    replacedNodeId: String(target.id),
    restoredNodeId: String(restored.id || ""),
    backupRetained: backupRetained,
  };
}

function deleteCleanupRecoveryBackup(backup) {
  if (!cleanupIsRecoveryBackupRoot(backup)) throw new Error("selected node is not a cleanup recovery backup");
  if (typeof backup.remove !== "function") throw new Error("cleanup recovery backup cannot be removed");
  const deletedNodeId = String(backup.id || "");
  backup.remove();
  return { deletedNodeId: deletedNodeId };
}

async function handleQueryCleanupRecoveryBackups(message) {
  try {
    figma.ui.postMessage({
      type: "QUERY_CLEANUP_RECOVERY_BACKUPS_RESULT",
      requestId: message.requestId,
      ok: true,
      backups: listCleanupRecoveryBackups(figma.currentPage),
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "QUERY_CLEANUP_RECOVERY_BACKUPS_RESULT",
      requestId: message.requestId,
      ok: false,
      error: cleanupErrorMessage(error),
      backups: [],
    });
  }
}

async function handleRestoreCleanupRecoveryBackup(message) {
  try {
    const backup = await cleanupGetNodeById(String(message.backupNodeId || ""));
    const selection = figma.currentPage && Array.isArray(figma.currentPage.selection) ? figma.currentPage.selection : [];
    if (selection.length !== 1) throw new Error("请先只选择 1 个需要恢复的受损根节点");
    const result = restoreCleanupRecoveryBackup(backup, selection[0]);
    const restored = await cleanupGetNodeById(result.restoredNodeId);
    if (restored) figma.currentPage.selection = [restored];
    figma.ui.postMessage({
      type: "RESTORE_CLEANUP_RECOVERY_BACKUP_RESULT",
      requestId: message.requestId,
      ok: true,
      result: result,
    });
    figma.notify(result.backupRetained ? "已恢复节点，但旧备份删除失败，请稍后手动删除" : "已从整理备份恢复节点");
  } catch (error) {
    figma.ui.postMessage({
      type: "RESTORE_CLEANUP_RECOVERY_BACKUP_RESULT",
      requestId: message.requestId,
      ok: false,
      error: cleanupErrorMessage(error),
    });
    figma.notify("恢复整理备份失败：" + cleanupErrorMessage(error), { error: true });
  }
}

async function handleDeleteCleanupRecoveryBackup(message) {
  try {
    const backup = await cleanupGetNodeById(String(message.backupNodeId || ""));
    const result = deleteCleanupRecoveryBackup(backup);
    figma.ui.postMessage({
      type: "DELETE_CLEANUP_RECOVERY_BACKUP_RESULT",
      requestId: message.requestId,
      ok: true,
      result: result,
    });
    figma.notify("已删除整理恢复备份");
  } catch (error) {
    figma.ui.postMessage({
      type: "DELETE_CLEANUP_RECOVERY_BACKUP_RESULT",
      requestId: message.requestId,
      ok: false,
      error: cleanupErrorMessage(error),
    });
    figma.notify("删除整理备份失败：" + cleanupErrorMessage(error), { error: true });
  }
}

class CleanupVerificationError extends Error {
  constructor(checks) {
    super("cleanup transaction verification failed");
    this.name = "CleanupVerificationError";
    this.checks = checks;
  }
}

function cleanupValidateTransactionEnvelope(plan, target) {
  if (!plan || (plan.schemaVersion !== 2 && plan.schemaVersion !== 3) || plan.operation !== "figma-hierarchy-cleanup-transaction") {
    throw new Error("invalid cleanup transaction plan");
  }
  if (!target || !String(target.nodeId || plan.target && plan.target.nodeId || "")) {
    throw new Error("cleanup transaction target.nodeId is required");
  }
  if (!Array.isArray(plan.operations)) throw new Error("cleanup transaction operations must be an array");
  if (!plan.verification || typeof plan.verification !== "object") throw new Error("cleanup transaction verification is required");
}

async function cleanupApplyOperation(operation, journal, createdNodeIds) {
  if (!operation || !operation.type) throw new Error("cleanup transaction contains an invalid operation");
  switch (operation.type) {
    case "CREATE_GROUP": {
      const parent = await cleanupResolveOperationParent(operation, createdNodeIds);
      const children = [];
      for (const childId of operation.childNodeIds || []) {
        const child = await cleanupGetNodeById(String(childId));
        if (!child || child.parent !== parent) throw new Error("CREATE_GROUP child is not a direct child: " + childId);
        children.push(child);
      }
      if (children.length < 2) throw new Error("CREATE_GROUP requires at least two children");
      const firstIndex = Math.min.apply(null, children.map(cleanupNodeIndex));
      const beforeChildren = children.map(function (child) {
        return { id: String(child.id), bounds: cleanupReadBounds(child) };
      });
      const group = createHierarchyCleanupGroup(parent, {
        name: String(operation.name || "[Group]"),
        childNodeIds: children.map(function (child) { return String(child.id); }),
      }, beforeChildren);
      journal.createdNodes.push(group);
      if (typeof parent.insertChild === "function") parent.insertChild(firstIndex, group);
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        const bounds = beforeChildren[index].bounds;
        group.appendChild(child);
        preserveHierarchyChildAbsoluteBounds(child, group, bounds);
      }
      return { id: String(operation.id), type: operation.type, createdNodeId: String(group.id) };
    }
    case "RENAME_NODE": {
      const node = await cleanupRequireNode(operation.nodeId);
      node.name = String(operation.name || "");
      return { id: String(operation.id), type: operation.type, nodeId: String(node.id) };
    }
    case "MOVE_NODE": {
      const node = await cleanupRequireNode(operation.nodeId);
      const parent = await cleanupRequireContainer(operation.parentNodeId);
      const bounds = cleanupReadBounds(node);
      parent.insertChild(Math.min(Number(operation.index), cleanupChildCount(parent)), node);
      preserveHierarchyChildAbsoluteBounds(node, parent, bounds);
      return { id: String(operation.id), type: operation.type, nodeId: String(node.id) };
    }
    case "REORDER_CHILDREN": {
      const parent = await cleanupResolveOperationParent(operation, createdNodeIds);
      const expectedIds = (operation.childNodeIds || []).map(String);
      const actualIds = parent.children.map(function (child) { return String(child.id); });
      if (expectedIds.length !== actualIds.length || expectedIds.some(function (id) { return actualIds.indexOf(id) < 0; })) {
        throw new Error("REORDER_CHILDREN must list every direct child exactly once");
      }
      for (let index = 0; index < expectedIds.length; index += 1) {
        const child = await cleanupRequireNode(expectedIds[index]);
        parent.insertChild(index, child);
      }
      return { id: String(operation.id), type: operation.type, parentNodeId: String(parent.id) };
    }
    case "SET_AUTO_LAYOUT": {
      const node = await cleanupRequireNode(operation.nodeId);
      if (!("layoutMode" in node)) throw new Error("SET_AUTO_LAYOUT target does not support Auto Layout");
      node.layoutMode = operation.layoutMode;
      node.itemSpacing = Number(operation.itemSpacing);
      node.paddingTop = Number(operation.paddingTop);
      node.paddingRight = Number(operation.paddingRight);
      node.paddingBottom = Number(operation.paddingBottom);
      node.paddingLeft = Number(operation.paddingLeft);
      return { id: String(operation.id), type: operation.type, nodeId: String(node.id) };
    }
    default:
      throw new Error("unsupported cleanup operation: " + String(operation.type));
  }
}

async function cleanupResolveOperationParent(operation, createdNodeIds) {
  const parentOperationId = String(operation && operation.parentOperationId || "").trim();
  const parentNodeId = String(operation && operation.parentNodeId || "").trim();
  if (parentOperationId && parentNodeId) {
    throw new Error("cleanup operation must not specify both parentNodeId and parentOperationId");
  }
  if (parentOperationId) {
    const createdNodeId = createdNodeIds && createdNodeIds.get(parentOperationId);
    if (!createdNodeId) throw new Error("cleanup operation parent group was not created: " + parentOperationId);
    return cleanupRequireContainer(createdNodeId);
  }
  if (!parentNodeId) throw new Error("cleanup operation parent is missing");
  return cleanupRequireContainer(parentNodeId);
}

function cleanupVerifyTransaction(root, journal, plan, operationResults) {
  const toleranceValue = Number(plan.verification && plan.verification.preserveAbsoluteBoundsTolerance);
  const tolerance = Number.isFinite(toleranceValue) && toleranceValue >= 0 ? toleranceValue : 0.01;
  const rootAfter = cleanupReadBounds(root);
  const rootDrift = cleanupBoundsDrift(journal.rootBounds, rootAfter);
  const boundsMismatches = [];
  const psdMismatches = [];
  for (const entry of journal.entries) {
    const drift = cleanupBoundsDrift(entry.bounds, cleanupReadBounds(entry.node));
    if (drift > tolerance) boundsMismatches.push({ nodeId: entry.id, drift: drift });
    if (JSON.stringify(entry.psd) !== JSON.stringify(cleanupReadPsdMetadata(entry.node))) psdMismatches.push(entry.id);
  }
  let semanticErrors = [];
  if (typeof buildHierarchyLiveSemanticBlockingErrors === "function") {
    semanticErrors = buildHierarchyLiveSemanticBlockingErrors(root, { mode: "cleanupTransaction", plan: plan }) || [];
  }
  const checks = {
    snapshotHash: { pass: true },
    operationsAppliedExactlyOnce: { pass: operationResults.length === plan.operations.length, expected: plan.operations.length, actual: operationResults.length },
    rootBoundsPreserved: { pass: rootDrift <= tolerance, drift: rootDrift, tolerance: tolerance },
    originalBoundsPreserved: { pass: boundsMismatches.length === 0, mismatches: boundsMismatches },
    psdIdentityPreserved: { pass: psdMismatches.length === 0, nodeIds: psdMismatches },
    semanticHierarchyRules: { pass: semanticErrors.length === 0, errors: semanticErrors },
  };
  checks.allPass = Object.keys(checks).every(function (key) {
    return key === "allPass" || checks[key].pass === true;
  });
  return checks;
}

function cleanupCreateBackup(root, runId) {
  if (!root || typeof root.clone !== "function") throw new Error("cleanup target cannot be cloned for rollback backup");
  const clone = root.clone();
  if (typeof clone.setPluginData === "function") {
    try {
      clone.setPluginData(CleanupRecoveryMetadataKey, JSON.stringify({
        schemaVersion: 1,
        runId: String(runId || ""),
        sourceName: String(root.name || ""),
        sourceX: cleanupRecoveryNumber(root.x, 0),
        sourceY: cleanupRecoveryNumber(root.y, 0),
        sourceVisible: root.visible !== false,
        sourceLocked: root.locked === true,
      }));
    } catch (_) { /* backup remains usable with the selected target's root properties */ }
  }
  const page = findContainingPage(root) || figma.currentPage;
  if (clone.parent !== page && page && typeof page.appendChild === "function") page.appendChild(clone);
  clone.name = CleanupBackupPrefix + String(runId || Date.now());
  if ("visible" in clone) clone.visible = false;
  if ("locked" in clone) clone.locked = true;
  if (typeof clone.x === "number" && typeof root.x === "number" && typeof root.width === "number") clone.x = root.x + root.width + 100;
  if (typeof clone.y === "number" && typeof root.y === "number") clone.y = root.y;
  return clone;
}

function cleanupIsRecoveryBackupRoot(node) {
  return !!(node && typeof node.name === "string" && node.name.startsWith(CleanupBackupPrefix));
}

function cleanupIsRecoveryNode(node) {
  if (typeof isCleanupRecoveryNode === "function") return isCleanupRecoveryNode(node);
  let current = node || null;
  while (current) {
    if (cleanupIsRecoveryBackupRoot(current)) return true;
    current = current.parent || null;
  }
  return false;
}

function cleanupReadRecoveryMetadata(node) {
  if (!node || typeof node.getPluginData !== "function") return {};
  try {
    const value = JSON.parse(String(node.getPluginData(CleanupRecoveryMetadataKey) || "{}"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (_) {
    return {};
  }
}

function cleanupRecoveryNumber(value, fallback) {
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  const fallbackNumber = Number(fallback);
  return Number.isFinite(fallbackNumber) ? fallbackNumber : 0;
}

function cleanupRemoveBackup(journal) {
  const backup = journal && journal.backupNode;
  if (backup && typeof backup.remove === "function") {
    try { backup.remove(); } catch (_) { return; }
  }
  if (journal) journal.backupNode = null;
}

function cleanupCollectRollbackEntries(parent, depth, output) {
  const children = Array.isArray(parent && parent.children) ? parent.children.slice() : [];
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index];
    output.push({
      id: String(node.id || ""),
      node: node,
      parent: parent,
      index: index,
      depth: depth + 1,
      name: String(node.name || ""),
      bounds: cleanupReadBounds(node),
      layout: cleanupCaptureLayout(node),
      psd: cleanupReadPsdMetadata(node),
      visible: node.visible,
      opacity: node.opacity,
    });
    cleanupCollectRollbackEntries(node, depth + 1, output);
  }
}

function cleanupCaptureLayout(node) {
  const result = {};
  const keys = ["layoutMode", "itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "primaryAxisSizingMode", "counterAxisSizingMode"];
  for (const key of keys) {
    if (node && key in node) result[key] = node[key];
  }
  return result;
}

function cleanupRestoreNodeProperties(entry) {
  for (const key of Object.keys(entry.layout || {})) {
    try { entry.node[key] = entry.layout[key]; } catch (_) { /* best effort, verified below */ }
  }
  entry.node.name = entry.name;
  if (typeof entry.visible === "boolean" && "visible" in entry.node) entry.node.visible = entry.visible;
  if (typeof entry.opacity === "number" && "opacity" in entry.node) entry.node.opacity = entry.opacity;
  if (typeof entry.node.resize === "function" && entry.bounds.width >= 0 && entry.bounds.height >= 0) {
    entry.node.resize(Math.max(entry.bounds.width, 0.01), Math.max(entry.bounds.height, 0.01));
  }
  if (typeof entry.node.x === "number") entry.node.x = entry.bounds.x - cleanupParentAbsoluteOrigin(entry.parent).x;
  if (typeof entry.node.y === "number") entry.node.y = entry.bounds.y - cleanupParentAbsoluteOrigin(entry.parent).y;
}

function cleanupReadBounds(node) {
  if (typeof getNodeBounds === "function") return getNodeBounds(node);
  const absolute = node && node.absoluteBoundingBox;
  return {
    x: Number(absolute && absolute.x !== undefined ? absolute.x : node && node.x || 0),
    y: Number(absolute && absolute.y !== undefined ? absolute.y : node && node.y || 0),
    width: Number(absolute && absolute.width !== undefined ? absolute.width : node && node.width || 0),
    height: Number(absolute && absolute.height !== undefined ? absolute.height : node && node.height || 0),
  };
}

function cleanupParentAbsoluteOrigin(parent) {
  if (!parent || parent.type === "PAGE" || parent.type === "DOCUMENT") return { x: 0, y: 0 };
  const bounds = cleanupReadBounds(parent);
  return { x: bounds.x, y: bounds.y };
}

function cleanupBoundsDrift(before, after) {
  return Math.max(
    Math.abs(Number(before.x) - Number(after.x)),
    Math.abs(Number(before.y) - Number(after.y)),
    Math.abs(Number(before.width) - Number(after.width)),
    Math.abs(Number(before.height) - Number(after.height)),
  );
}

function cleanupReadPsdMetadata(node) {
  if (typeof readCleanupPsdMetadata !== "function") return {};
  const value = readCleanupPsdMetadata(node);
  return cleanupStableJsonValue(value) || {};
}

async function cleanupGetNodeById(nodeId) {
  if (typeof figma === "undefined") return null;
  if (typeof figma.getNodeByIdAsync === "function") {
    try { return await figma.getNodeByIdAsync(String(nodeId)); } catch (_) { return null; }
  }
  if (typeof figma.getNodeById === "function") {
    try { return figma.getNodeById(String(nodeId)); } catch (_) { return null; }
  }
  return null;
}

async function cleanupRequireNode(nodeId) {
  const node = await cleanupGetNodeById(String(nodeId));
  if (!node) throw new Error("Figma node not found: " + String(nodeId));
  return node;
}

async function cleanupRequireContainer(nodeId) {
  const node = await cleanupRequireNode(nodeId);
  if (!Array.isArray(node.children) || typeof node.insertChild !== "function") {
    throw new Error("Figma node is not a container: " + String(nodeId));
  }
  return node;
}

function cleanupNodeIndex(node) {
  const siblings = node && node.parent && Array.isArray(node.parent.children) ? node.parent.children : [];
  const index = siblings.indexOf(node);
  return index >= 0 ? index : 0;
}

function cleanupChildCount(node) {
  return Array.isArray(node && node.children) ? node.children.length : 0;
}

function cleanupPrimitiveOrNull(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
}

function cleanupStableJsonValue(value) {
  if (Array.isArray(value)) return value.map(cleanupStableJsonValue);
  if (!value || typeof value !== "object") return cleanupPrimitiveOrNull(value);
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = cleanupStableJsonValue(value[key]);
  return output;
}

function cleanupErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function cleanupUtf8Bytes(value) {
  const bytes = [];
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      }
    }
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return bytes;
}

function cleanupSha256(value) {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const bytes = cleanupUtf8Bytes(value);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((high >>> shift) & 0xff);
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((low >>> shift) & 0xff);
  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const words = new Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const base = offset + index * 4;
      words[index] = ((bytes[base] << 24) | (bytes[base + 1] << 16) | (bytes[base + 2] << 8) | bytes[base + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15];
      const y = words[index - 2];
      const sigma0 = (cleanupRotateRight(x, 7) ^ cleanupRotateRight(x, 18) ^ (x >>> 3)) >>> 0;
      const sigma1 = (cleanupRotateRight(y, 17) ^ cleanupRotateRight(y, 19) ^ (y >>> 10)) >>> 0;
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let a = hash[0]; let b = hash[1]; let c = hash[2]; let d = hash[3];
    let e = hash[4]; let f = hash[5]; let g = hash[6]; let h = hash[7];
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = (cleanupRotateRight(e, 6) ^ cleanupRotateRight(e, 11) ^ cleanupRotateRight(e, 25)) >>> 0;
      const choice = ((e & f) ^ ((~e) & g)) >>> 0;
      const temp1 = (h + bigSigma1 + choice + constants[index] + words[index]) >>> 0;
      const bigSigma0 = (cleanupRotateRight(a, 2) ^ cleanupRotateRight(a, 13) ^ cleanupRotateRight(a, 22)) >>> 0;
      const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (bigSigma0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
  }
  return hash.map(function (word) { return ("00000000" + word.toString(16)).slice(-8); }).join("");
}

function cleanupRotateRight(value, count) {
  return (value >>> count) | (value << (32 - count));
}
